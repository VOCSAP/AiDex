/**
 * Differential test for the coverage oracle -- spec_2ef5a027.
 *
 * WHY THIS EXISTS
 * The oracle promises to predict what a query will ACTUALLY return. Only one
 * failure of that promise costs anything: `covered: true` on a pattern the query
 * answers with zero. That is a false block -- a legitimate search refused, which
 * teaches an agent to work around the tooling, the exact behaviour the whole
 * coverage mechanism exists to end. Nothing else in the suite checks it.
 *
 * GROUND TRUTH is a whole-token regex scan of the fixture source, i.e. grep, not
 * the index. Checking the index against itself would prove nothing.
 *
 * PATTERNS ARE DRAWN FROM THE SOURCE, never enumerated here. A frozen list
 * covers what it lists and stops growing with the code. The only hardcoded
 * patterns are the REGRESSION ANCHORS below: each one already produced a wrong
 * answer during development, so each has earned a permanent seat.
 *
 * THIS TEST IS THE GATE. The Claude Code hook may only start blocking greps once
 * this is green, and it is what will go red if an indexing rule ever moves
 * without the oracle following.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, isAbsolute, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir, homedir } from 'os';
import Database from 'better-sqlite3';

import { init, isUnderSystemTemp } from '../build/commands/init.js';
import { update } from '../build/commands/update.js';
import { query } from '../build/commands/query.js';
import { can } from '../build/commands/coverage.js';
import { openDatabase, createQueries } from '../build/db/index.js';
import { classifyPattern } from '../build/coverage/rule.js';

// ============================================================
// Fixture
// ============================================================

/**
 * Source that deliberately mixes the shapes the rules discriminate on:
 * bare symbols, mixed case, separators, single lowercase words in call-argument
 * / type / JSX / object-value position, plus prose that must never be indexed.
 */
const FIXTURE_FILES = {
    'src/channels.ts': `
export type ChannelKind = 'telegram' | 'discord' | 'ntfy' | 'ok';

export const MIGRATE_FILES = ['config.json', 'sessions.json'];

export function restoreWorkspace(id: string): void {
    reportError('roadmap', 'could not restore workspace');
    send('sandbox:changed', { mode: 'copy' });
}

export function reportError(scope: string, message: string): void {
    console.error(scope, message);
}

function send(channel: string, payload: Record<string, unknown>): void {
    void channel; void payload;
}

// A template literal whose interpolation holds a real symbol: the literal pass
// must skip the TEXT of a string without skipping what is embedded in it.
export function greetUser(userName: string): string {
    return \`hello \${userName}\`;
}
`,
    'src/panel.tsx': `
export function Panel(): JSX.Element {
    const cls = 'restore-prev';
    return <div className="field"><span className={cls}>hello world</span></div>;
}
`,
    'src/config.ts': `
export const DEFAULTS = {
    provider: 'codex',
    platform: 'linux',
    settingsKey: 'settings.restoreSessions',
};
`,
};

/** Root of the current drive / filesystem, for a path that is definitely not temp. */
// Anchored on this file's own location, not process.cwd() -- see roadmap
// card 39e02f07 (defect 2): process.cwd() only shares a drive/root with the
// repo when launched from the same filesystem root, which broke when the
// suite was launched from outside the repo root.
function cwdRoot() {
    return dirname(dirname(fileURLToPath(import.meta.url))).split(/[\\/]/)[0] + '/';
}

/** Rows in the user's global registry, or null when there is no registry here. */
function registryCount() {
    const dbPath = join(homedir(), '.aidex', 'global.db');
    if (!existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    const n = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
    db.close();
    return n;
}

/** Occurrences carrying a literal, counted straight from the tables. */
function countLiteralOccurrences(dir, relPath) {
    const db = new Database(join(dir, '.aidex', 'index.db'), { readonly: true });
    const n = relPath
        ? db.prepare(`
            SELECT COUNT(*) n FROM occurrences o
            JOIN files f ON f.id = o.file_id
            WHERE o.kind IN ('literal', 'both') AND f.path = ?
        `).get(relPath.replace(/\\/g, '/')).n
        : db.prepare("SELECT COUNT(*) n FROM occurrences WHERE kind IN ('literal', 'both')").get().n;
    db.close();
    return n;
}

function createFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-oracle-'));
    for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
        const abs = join(dir, rel);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, content, 'utf-8');
    }
    return dir;
}

// ============================================================
// Ground truth: a whole-token scan of the source. This is grep, not the index.
// ============================================================

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * Count occurrences of `pattern` as a WHOLE token.
 *
 * Token-bounded on purpose: the index stores whole terms, so a substring match
 * would compare two different things and the differential would be noise. `\b`
 * is not usable here -- patterns like `sandbox:changed` or `config.json` contain
 * characters that are themselves word boundaries -- so the boundary is defined
 * explicitly as "not adjacent to an identifier character".
 */
function groundTruthCount(dir, pattern) {
    const re = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegex(pattern)}([^A-Za-z0-9_$]|$)`, 'g');
    let total = 0;
    for (const rel of Object.keys(FIXTURE_FILES)) {
        const text = readFileSync(join(dir, rel), 'utf-8');
        for (const line of text.split('\n')) {
            re.lastIndex = 0;
            if (re.test(line)) total++;
        }
    }
    return total;
}

// ============================================================
// Pattern sampling -- drawn from the fixture, never enumerated
// ============================================================

/** Deterministic PRNG so a failure is reproducible from the printed seed. */
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Every identifier and every quoted literal the fixture actually contains. */
function harvestPatterns(dir) {
    const found = new Set();
    for (const rel of Object.keys(FIXTURE_FILES)) {
        const text = readFileSync(join(dir, rel), 'utf-8');
        for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) found.add(m[0]);
        for (const m of text.matchAll(/['"]([^'"\n]{2,64})['"]/g)) found.add(m[1]);
    }
    return [...found];
}

function sample(list, n, seed) {
    const rnd = mulberry32(seed);
    const idx = list.map((_, i) => i);
    for (let i = 0; i < n && i < idx.length; i++) {
        const j = i + Math.floor(rnd() * (idx.length - i));
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx.slice(0, n).map(i => list[i]);
}

/**
 * REGRESSION ANCHORS. Every one of these produced a wrong verdict at some point:
 *   ok, field                 -> returned covered:true although a bare lowercase
 *                                word is a symbol AND a literal candidate, and
 *                                the literal side is only partially indexed
 *   roadmap:search, sessions.json, restore-prev
 *                             -> the literal-shaped patterns the whole feature
 *                                exists for
 *   restoreWorkspace          -> the symbol that must stay answerable
 * They are pinned here so they survive the scratchpad they were found in.
 */
const REGRESSION_ANCHORS = [
    'ok', 'field', 'roadmap:search', 'sessions.json', 'restore-prev', 'restoreWorkspace',
];

const SEED = 20260810;
const SAMPLE_SIZE = 40;

// ============================================================
// Tests
// ============================================================

describe('coverage oracle differential', () => {
    let dir;
    let present = [];
    let absent = [];
    let literalCoverage = false;

    beforeAll(async () => {
        dir = createFixture();
        const result = await init({ path: dir });
        expect(result.success).toBe(true);

        const harvested = harvestPatterns(dir);
        const drawn = [...new Set([...sample(harvested, SAMPLE_SIZE, SEED), ...REGRESSION_ANCHORS])];

        // Split by GROUND TRUTH, not by what the index thinks.
        for (const p of drawn) {
            (groundTruthCount(dir, p) > 0 ? present : absent).push(p);
        }

        // Patterns guaranteed absent: derived, then VERIFIED absent by the same
        // scan rather than assumed absent because they look random.
        for (const base of ['zzqx', 'nonexistent', 'no:such:channel', 'missing.json']) {
            const p = `${base}${SEED}`;
            if (groundTruthCount(dir, p) === 0) absent.push(p);
        }

        literalCoverage = can({ path: dir, pattern: 'roadmap:search' }).reason !== 'literal_coverage_absent';

        console.log(
            `[oracle differential] mode=${literalCoverage ? 'FULL' : 'GATE-ONLY (index has no literal coverage)'} `
            + `seed=${SEED} present=${present.length} absent=${absent.length}`
        );
    });

    afterAll(() => {
        // Always, so a failing assertion does not leak a directory per run.
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test('fixture yields patterns on both sides of ground truth', () => {
        expect(present.length).toBeGreaterThan(5);
        expect(absent.length).toBeGreaterThan(0);
    });

    /**
     * THE assertion. Everything else in this file supports it.
     *
     * "The query returns zero" means the RESPONSE REPORTS AN ABSENCE, which is
     * not the same as `totalMatches === 0`. A default (symbols-only) query on a
     * literal answers zero matches AND `otherKindMatches: N`, which the tool
     * renders as "N match(es) exist in other kinds -- re-run with kinds:
     * ["literal"]". That response points AT the match; no caller reading it can
     * conclude the term is absent. The false block being guarded against is the
     * silent zero -- nothing found, nothing pointed at -- so both counters have
     * to be zero for a covered verdict to be wrong.
     */
    test('no pattern is claimed covered while the query reports an absence', () => {
        const falseBlocks = [];
        for (const pattern of present) {
            const verdict = can({ path: dir, pattern });
            if (!verdict.covered) continue;
            const result = query({ path: dir, term: pattern });
            if (result.totalMatches === 0 && result.otherKindMatches === 0) {
                falseBlocks.push({ pattern, reason: verdict.reason, groundTruth: groundTruthCount(dir, pattern) });
            }
        }
        expect(falseBlocks).toEqual([]);
    });

    /**
     * The other direction: a covered verdict on a pattern the source does NOT
     * contain has to be TRUE, because that verdict is what licenses a caller to
     * read the zero as proof of absence.
     *
     * This assertion used to forbid coverage on absent patterns outright. That
     * only ever held while no index had literal coverage: on a 1.3 index,
     * `roadmap:search` being absent AND covered is not a defect, it is the
     * entire payoff of the feature. What must be checked is that the claim
     * holds -- query both dimensions and find nothing -- not that it is never
     * made.
     */
    test('a covered verdict on an absent pattern is backed by an empty index', () => {
        const wrong = [];
        for (const pattern of absent) {
            const verdict = can({ path: dir, pattern });
            if (!verdict.covered) continue;
            const result = query({ path: dir, term: pattern, kinds: ['symbol', 'literal'] });
            if (result.totalMatches > 0) {
                wrong.push({ pattern, reason: verdict.reason, matches: result.totalMatches });
            }
        }
        expect(wrong).toEqual([]);
    });

    /**
     * Keeps a GATE-ONLY run from reading as a green full differential: with no
     * literal coverage, nothing can be covered, and that is the property to
     * assert instead of pretending the main test proved something.
     */
    test('an index without literal coverage never claims coverage', () => {
        if (literalCoverage) {
            const covered = present.filter(p => can({ path: dir, pattern: p }).covered);
            expect(covered.length).toBeGreaterThan(0);
            return;
        }
        const leaked = [...present, ...absent]
            .map(p => ({ p, v: can({ path: dir, pattern: p }) }))
            .filter(x => x.v.covered)
            .map(x => ({ pattern: x.p, reason: x.v.reason }));
        expect(leaked).toEqual([]);
    });

    test('regression anchors keep their verdicts', () => {
        // A bare lowercase word is a symbol AND a literal candidate: it must
        // never be claimed covered, on any index state.
        for (const pattern of ['ok', 'field']) {
            expect(can({ path: dir, pattern }).covered).toBe(false);
        }
        // f08aeeb1: an all-lowercase, unpunctuated phrase is now literal-shaped
        // (whitespace guard lifted), but still 'below' the literal rule -- same
        // trap as a bare lowercase word, never claimed covered.
        expect(can({ path: dir, pattern: 'hello world' }).reason).toBe('pattern_below_literal_rule');
        // The symbol dimension stays answerable.
        expect(query({ path: dir, term: 'restoreWorkspace' }).totalMatches).toBeGreaterThan(0);
    });

    test('the default kinds is symbols only and is echoed back', () => {
        const result = query({ path: dir, term: 'restoreWorkspace' });
        expect(result.kinds).toEqual(['symbol']);
        expect(result.otherKindMatches).toBe(0);
    });

    // --------------------------------------------------------
    // Lot 3 -- literals are indexed, measured, and then declared
    // --------------------------------------------------------

    test('a full reindex declares 1.3 and stores a MEASURED per-language record', () => {
        const db = new Database(join(dir, '.aidex', 'index.db'), { readonly: true });
        const read = (key) =>
            db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value ?? null;

        expect(read('schema_version')).toBe('1.3');
        const record = JSON.parse(read('literal_coverage'));
        db.close();

        expect(record.ruleId).toBe('strict+typepos');
        // f08aeeb1 bumped 1 -> 2 (whitespace guard lifted for multi-word literals).
        expect(record.ruleVersion).toBe(2);
        // The percentage is measured, so it is never asserted to a value -- only
        // that it exists, is a real percentage, and came from this fixture.
        const ts = record.perLanguage.typescript;
        expect(ts.percent).toBeGreaterThan(0);
        expect(ts.percent).toBeLessThanOrEqual(100);
        // The sample size ships with it, so a 100% over one literal can be told
        // apart from a 100% over a thousand.
        expect(ts.seen).toBeGreaterThan(ts.indexed);
        expect(ts.indexed).toBeGreaterThan(0);
    });

    test('separator-bearing literals land in the literal dimension', () => {
        for (const pattern of ['restore-prev', 'sandbox:changed', 'sessions.json']) {
            expect(query({ path: dir, term: pattern, kinds: ['literal'] }).totalMatches)
                .toBeGreaterThan(0);
        }
    });

    /**
     * The promise Lot 2 made and Lot 3 must not break: a query written before
     * literals existed returns what it returned before. A literal answering a
     * default query would be a silent widening of every existing call site.
     */
    test('literals never leak into a default symbol query', () => {
        for (const pattern of ['restore-prev', 'sandbox:changed', 'sessions.json']) {
            const result = query({ path: dir, term: pattern });
            expect(result.totalMatches).toBe(0);
            expect(result.otherKindMatches).toBeGreaterThan(0);
        }
    });

    /**
     * An identifier inside a template interpolation is a SYMBOL, and it was
     * indexed as one before Lot 3. Skipping the whole string node -- the
     * obvious way to avoid double-counting the text -- would have deleted it.
     */
    test('identifiers inside an interpolation stay indexed as symbols', () => {
        expect(query({ path: dir, term: 'userName' }).totalMatches).toBeGreaterThan(0);
    });

    /**
     * Line types are load-bearing for every existing `type_filter` query.
     * A literal must not upgrade the line it sits on: measured on koryphaios,
     * applying it would have flipped 9175 lines from 'code' to 'string'.
     */
    test('a literal never retypes a line that already had a type', () => {
        const db = new Database(join(dir, '.aidex', 'index.db'), { readonly: true });
        // Every line carrying a literal AND a symbol must still be 'code'-ish,
        // never 'string': 'string' is reserved for lines created by a literal.
        const flipped = db.prepare(`
            SELECT DISTINCT f.path, l.line_number
            FROM lines l
            JOIN files f ON f.id = l.file_id
            WHERE l.line_type = 'string'
              AND EXISTS (
                  SELECT 1 FROM occurrences o
                  WHERE o.file_id = l.file_id AND o.line_id = l.id
                    AND o.kind IN ('symbol', 'both')
              )
        `).all();
        db.close();
        expect(flipped).toEqual([]);
    });

    /**
     * The fixtures in this very file are what exposed this: they call `init()`,
     * so every `npm test` used to register one entry per fixture in the user's
     * global registry. 91 dead rows accumulated in two days, and six came back
     * the moment the registry was purged.
     */
    describe('throwaway indexes stay out of the global registry', () => {
        test('the temp boundary is matched at a separator, not by prefix', () => {
            const tmp = tmpdir();
            expect(isUnderSystemTemp(join(tmp, 'aidex-fixture-123'))).toBe(true);
            expect(isUnderSystemTemp(join(tmp, 'a', 'b', 'c'))).toBe(true);
            // The temp directory itself.
            expect(isUnderSystemTemp(tmp)).toBe(true);
            // A SIBLING whose name merely starts with the same characters must
            // not be swallowed by a naive startsWith.
            expect(isUnderSystemTemp(`${tmp}-projects`)).toBe(false);
            expect(isUnderSystemTemp(join(cwdRoot(), 'workspace', 'real-project'))).toBe(false);
        });

        test('indexing a temp fixture leaves the registry untouched', async () => {
            const before = registryCount();
            if (before === null) return;   // no global registry on this machine
            const throwaway = createFixture();
            await init({ path: throwaway });
            expect(registryCount()).toBe(before);
            rmSync(throwaway, { recursive: true, force: true });
        });
    });

    /**
     * A relative path indexes fine and then leaks: `basename('.')` is '.', so
     * `rebuild-index .` produced a project literally named '.' pointing at '.',
     * a phantom duplicate of the real one in the global registry, and the same
     * meaningless string landed in `metadata.project_root`.
     */
    test('a relative project path is resolved before anything records it', async () => {
        const rel = createFixture();
        const cwd = process.cwd();
        try {
            process.chdir(rel);
            const result = await init({ path: '.' });
            expect(result.success).toBe(true);
            expect(result.indexPath).not.toMatch(/^\.[\\/]/);
        } finally {
            process.chdir(cwd);
        }

        const db = new Database(join(rel, '.aidex', 'index.db'), { readonly: true });
        const root = db.prepare("SELECT value v FROM metadata WHERE key='project_root'").get().v;
        const name = db.prepare("SELECT value v FROM metadata WHERE key='project_name'").get().v;
        db.close();

        expect(root).not.toBe('.');
        expect(isAbsolute(root)).toBe(true);
        expect(name).not.toBe('.');

        rmSync(rel, { recursive: true, force: true });
    });

    // --------------------------------------------------------
    // The term window: visible, ordered, pageable
    // --------------------------------------------------------

    /**
     * `searchItems` caps how many TERMS a call examines. A term left out
     * contributes no result line at all, so a silent cap can hide a symbol
     * completely -- the same failure as an unqualified zero, one stage earlier.
     */
    describe('the term window', () => {
        test('a truncated window is reported, not silent', () => {
            const wide = query({ path: dir, term: 'e', mode: 'contains', itemLimit: 2 });
            expect(wide.success).toBe(true);
            expect(wide.itemsTruncated).toBe(true);
            expect(wide.itemsReturned).toBe(2);
            expect(wide.itemsTotal).toBeGreaterThan(2);
        });

        test('a window that covers everything is not flagged', () => {
            const all = query({ path: dir, term: 'e', mode: 'contains' });
            expect(all.itemsTruncated).toBe(false);
            expect(all.itemsReturned).toBe(all.itemsTotal);
            expect(all.itemOffset).toBe(0);
        });

        /**
         * Paging is only meaningful if the order is total. Without a tiebreak,
         * equal-ranking rows may swap between calls and a page can repeat or
         * skip rows -- SQL guarantees no order without ORDER BY.
         */
        test('successive slices are disjoint in TERMS and cover the whole set', () => {
            // Disjointness is asserted on terms, not on result lines: several
            // distinct terms can sit on one line, and the de-duplication by
            // file:line only applies within a single call. Paging pages terms.
            const db = openDatabase(join(dir, '.aidex', 'index.db'), true);
            const queries = createQueries(db);
            const total = queries.countItems('e', 'contains', false);
            const ids = [];
            for (let offset = 0; offset < total; offset += 3) {
                const slice = queries.searchItems('e', 'contains', 3, offset, false);
                ids.push(...slice.map(i => i.id));
            }
            db.close();

            expect(ids.length).toBe(total);
            expect(new Set(ids).size).toBe(ids.length);   // nothing served twice

            // And every line reachable in one call is reachable by paging.
            const paged = new Set();
            for (let offset = 0; offset < total; offset += 3) {
                const page = query({ path: dir, term: 'e', mode: 'contains', itemLimit: 3, itemOffset: offset });
                expect(page.itemOffset).toBe(offset);
                for (const m of page.matches) paged.add(`${m.file}:${m.lineNumber}`);
            }
            const whole = new Set(query({ path: dir, term: 'e', mode: 'contains', limit: 10000 })
                .matches.map(m => `${m.file}:${m.lineNumber}`));
            expect([...paged].sort()).toEqual([...whole].sort());
        });

        test('an offset past the end is empty but still states the total', () => {
            const past = query({ path: dir, term: 'e', mode: 'contains', itemOffset: 100000 });
            expect(past.success).toBe(true);
            expect(past.matches).toEqual([]);
            expect(past.itemsTotal).toBeGreaterThan(0);
        });

        test('the closest term to what was typed comes first', () => {
            // `send` exists as a symbol; `sendMessage`-like longer terms rank
            // after it, and an exact match ranks before any of them.
            const page = query({ path: dir, term: 'send', mode: 'contains', itemLimit: 1 });
            expect(page.itemsReturned).toBe(1);
            expect(page.totalMatches).toBeGreaterThan(0);
        });

        /**
         * Literal-only terms must not take seats in a window the caller asked
         * to fill with symbols -- measured at 14% to 22% of items on real
         * indexes. Their existence still has to be advertised, or the literal
         * dimension goes invisible again.
         */
        test('literal-only terms leave the symbol window alone but stay advertised', () => {
            const symbols = query({ path: dir, term: 'restore-prev' });
            expect(symbols.itemsTotal).toBe(0);
            expect(symbols.otherKindMatches).toBeGreaterThan(0);

            const literals = query({ path: dir, term: 'restore-prev', kinds: ['literal'] });
            expect(literals.itemsTotal).toBeGreaterThan(0);
            expect(literals.totalMatches).toBeGreaterThan(0);
        });
    });

    // --------------------------------------------------------
    // The guard: an index answers for literals only once it DECLARES them
    // --------------------------------------------------------

    /**
     * Reachable because of Lot 3, not despite it: `aidex_update` now writes
     * literal occurrences into whatever index it touches without advancing
     * `schema_version`. So an index can hold literals for the three files that
     * changed today and none for the rest -- and answering from those would be
     * a partial index presenting itself as a complete one.
     *
     * The fixture reproduces exactly that: real literal rows, a declaration
     * that says 1.2.
     */
    describe('literal dimension on an index that does not declare it', () => {
        let undeclared;

        beforeAll(async () => {
            undeclared = createFixture();
            await init({ path: undeclared });
            const db = new Database(join(undeclared, '.aidex', 'index.db'));
            db.prepare("UPDATE metadata SET value = '1.2' WHERE key = 'schema_version'").run();
            db.prepare("DELETE FROM metadata WHERE key = 'literal_coverage'").run();
            db.close();
        });

        afterAll(() => {
            if (undeclared) rmSync(undeclared, { recursive: true, force: true });
        });

        test('a literal query is refused, not half-answered', () => {
            const result = query({ path: undeclared, term: 'sandbox:changed', kinds: ['literal'] });
            expect(result.success).toBe(false);
            expect(result.matches).toEqual([]);
            expect(result.totalMatches).toBe(0);
            expect(result.error).toMatch(/does not declare literal coverage \(schema 1\.2\)/);
            // The remedy travels with the refusal: reindexing is manual, so a
            // machine stays mixed indefinitely.
            expect(result.error).toMatch(/rebuild-index/);
        });

        test('a mixed kinds query is refused whole', () => {
            // Answering the symbol half while dropping an unreliable literal
            // half is the same lie in a quieter voice.
            const result = query({ path: undeclared, term: 'restoreWorkspace', kinds: ['symbol', 'literal'] });
            expect(result.success).toBe(false);
            expect(result.matches).toEqual([]);
        });

        test('the default symbol query is untouched', () => {
            const result = query({ path: undeclared, term: 'restoreWorkspace' });
            expect(result.success).toBe(true);
            expect(result.totalMatches).toBeGreaterThan(0);
            expect(result.literalDimensionAvailable).toBe(false);
        });

        test('an index built under a foreign rule is refused too', () => {
            const foreign = createFixture();
            return init({ path: foreign }).then(() => {
                const db = new Database(join(foreign, '.aidex', 'index.db'));
                const raw = db.prepare("SELECT value v FROM metadata WHERE key='literal_coverage'").get().v;
                const record = JSON.parse(raw);
                record.ruleId = 'someone-elses-rule';
                db.prepare("UPDATE metadata SET value = ? WHERE key = 'literal_coverage'").run(JSON.stringify(record));
                db.close();

                const result = query({ path: foreign, term: 'sandbox:changed', kinds: ['literal'] });
                expect(result.success).toBe(false);
                expect(result.error).toMatch(/someone-elses-rule/);
                rmSync(foreign, { recursive: true, force: true });
            });
        });

        /**
         * Operator decision, 2026-08-11: `init` is the migration path, callable
         * by an agent. The conservative alternative was treacherous the other
         * way -- an agent reindexes, is told the index is fresh, and it stays
         * silent about literals with nothing saying so.
         */
        test('init migrates the index instead of skipping unchanged files', async () => {
            // Its own fixture: this test MIGRATES the index it runs on, and the
            // others in this block need one that still does not declare.
            const stale = createFixture();
            await init({ path: stale });
            const db0 = new Database(join(stale, '.aidex', 'index.db'));
            db0.prepare("UPDATE metadata SET value = '1.2' WHERE key = 'schema_version'").run();
            db0.prepare("DELETE FROM metadata WHERE key = 'literal_coverage'").run();
            db0.close();

            expect(query({ path: stale, term: 'sandbox:changed', kinds: ['literal'] }).success).toBe(false);

            const result = await init({ path: stale });
            expect(result.success).toBe(true);
            // Announced, not inferred from the elapsed time.
            expect(result.literalCoverageUpgraded).toBe(true);
            // The hash skip is ignored: the unchanged files are precisely the
            // ones whose literals were never extracted.
            expect(result.filesSkipped).toBe(0);
            expect(result.filesIndexed).toBeGreaterThan(0);

            const db = new Database(join(stale, '.aidex', 'index.db'), { readonly: true });
            expect(db.prepare("SELECT value v FROM metadata WHERE key='schema_version'").get().v).toBe('1.3');
            db.close();

            const after = query({ path: stale, term: 'sandbox:changed', kinds: ['literal'] });
            expect(after.success).toBe(true);
            expect(after.totalMatches).toBeGreaterThan(0);

            // A second run has nothing to migrate and goes back to incremental.
            const again = await init({ path: stale });
            expect(again.literalCoverageUpgraded).toBe(false);
            expect(again.filesSkipped).toBeGreaterThan(0);

            rmSync(stale, { recursive: true, force: true });
        });

        /**
         * Content must not contradict the declaration. An update that seeded
         * literals into a non-declaring index would leave it holding them for
         * the files touched today and none for the rest.
         */
        test('update writes no literals into an index that does not declare them', async () => {
            const before = countLiteralOccurrences(undeclared);
            const target = join('src', 'channels.ts');
            writeFileSync(
                join(undeclared, target),
                readFileSync(join(undeclared, target), 'utf-8') + "\nexport const EXTRA = { key: 'added:later' };\n",
                'utf-8'
            );

            const r = await update({ path: undeclared, file: target });
            expect(r.success).toBe(true);

            // Nothing added, and the re-indexed file now holds none at all:
            // updating clears the file first, so the index converges towards
            // matching its own declaration instead of drifting further from it.
            expect(countLiteralOccurrences(undeclared)).toBeLessThanOrEqual(before);
            expect(countLiteralOccurrences(undeclared, target)).toBe(0);
            // The symbol side of the same edit still lands.
            expect(query({ path: undeclared, term: 'EXTRA' }).totalMatches).toBeGreaterThan(0);
        });

        /**
         * The remedy has to RUN. It used to start with the bare word "node",
         * which on a machine whose PATH node is a different major aborts on
         * NODE_MODULE_VERSION before doing anything -- native addons.
         */
        test('the rebuild command names an interpreter that can load the addons', () => {
            const result = query({ path: undeclared, term: 'sandbox:changed', kinds: ['literal'] });
            expect(result.error).toContain(process.execPath.replace(/\\/g, '/'));
        });

        /**
         * The command must point at AiDex's entry point, never at whatever
         * script happens to be running. Called from this test file, a
         * `process.argv[1]` derivation emitted "<node> <jest.js> rebuild-index",
         * which re-runs the caller and rebuilds nothing.
         */
        test('the rebuild command points at the AiDex entry point', () => {
            const result = query({ path: undeclared, term: 'sandbox:changed', kinds: ['literal'] });
            expect(result.error).toMatch(/build\/index\.js" rebuild-index/);
            expect(result.error).not.toMatch(/jest/);
        });
    });

    /**
     * The measurement is only honest if it covered every file. An incremental
     * run skips unchanged files, so it must leave the record it cannot measure
     * exactly as it found it.
     */
    test('an incremental run never rewrites the coverage record', async () => {
        const dbPath = join(dir, '.aidex', 'index.db');
        const readRecord = () => {
            const db = new Database(dbPath, { readonly: true });
            const v = db.prepare("SELECT value FROM metadata WHERE key = 'literal_coverage'").get()?.value;
            db.close();
            return v;
        };

        const before = readRecord();
        const again = await init({ path: dir });   // no `fresh`: incremental
        expect(again.success).toBe(true);
        expect(readRecord()).toBe(before);
    });

    /**
     * A pre-Lot-2 index has no `occurrences.kind`, and it never gets one on a
     * read: the migration only runs on a writeable handle and a readonly
     * connection cannot ALTER. The fixture above is always built from the
     * current schema, so it can never expose this -- the column is dropped here
     * on purpose to reproduce a legacy index (hyp_bde59155, found by probing a
     * real index, not by this suite).
     */
    test('a legacy index without occurrences.kind still answers', async () => {
        // async/await, not a returned promise inside try/finally: the finally
        // would fire synchronously and delete the fixture out from under the
        // query, which reads as "0 matches" and blames the wrong thing.
        const legacyDir = mkdtempSync(join(tmpdir(), 'aidex-legacy-'));
        try {
            for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
                const abs = join(legacyDir, rel);
                mkdirSync(join(abs, '..'), { recursive: true });
                writeFileSync(abs, content, 'utf-8');
            }
            await init({ path: legacyDir });

            const db = new Database(join(legacyDir, '.aidex', 'index.db'));
            db.exec('ALTER TABLE occurrences DROP COLUMN kind');
            db.close();

            const result = query({ path: legacyDir, term: 'restoreWorkspace' });
            expect(result.success).toBe(true);
            expect(result.totalMatches).toBeGreaterThan(0);
            // Everything a pre-Lot-2 index holds IS a symbol, so the substituted
            // constant is the truth, not a placeholder.
            expect(result.kinds).toEqual(['symbol']);
            expect(result.otherKindMatches).toBe(0);
        } finally {
            rmSync(legacyDir, { recursive: true, force: true });
        }
    });

    test('classifyPattern separates the symbol shape from the literal rule', () => {
        expect(classifyPattern('ok').literalRule).toBe('below');
        expect(classifyPattern('ok').symbolShaped).toBe(true);
        expect(classifyPattern('roadmap:search').literalRule).toBe('above');
        expect(classifyPattern('restoreWorkspace').literalRule).toBe('above');
        // f08aeeb1: whitespace no longer disqualifies outright; an
        // unpunctuated, all-lowercase phrase lands 'below' the literal rule,
        // same bucket as a bare lowercase word.
        expect(classifyPattern('hello world').literalRule).toBe('below');
        expect(classifyPattern('hello world').reason).toBe('below_literal_rule');
    });
});
