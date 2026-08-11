/**
 * Reference query corpus harness -- spec_fd1ed424.
 *
 * WHY THIS EXISTS
 * Two roadmap items are about to change how aidex_query RANKS results:
 * b27f5663 (trigram prefilter for contains mode) and 10096483 (multi-term IDF
 * ranking). Neither can be judged "better" or "worse" against thin air --
 * both need a fixed, real set of queries with a known-correct answer to replay
 * before and after the change. This file is that harness; tests/fixtures/
 * query-corpus.json is the fixed set.
 *
 * GROUND TRUTH is a scan of the SOURCE, never the index -- same discipline as
 * tests/coverage-oracle.test.js. The corpus is THIS repo (operator decision:
 * a real, already-indexed codebase beats a synthetic one for judging a ranking
 * change against a real literal distribution). Because dev1/dev2 are editing
 * hooks/ and src/index.ts in the live working tree while this suite runs, the
 * corpus is pinned to a fixed commit (query-corpus.json meta.pinnedCommit) and
 * reconstructed via `git archive <sha>` into a fresh temp dir every run, so
 * ground truth can never drift under a concurrent edit. Every count frozen in
 * the fixture is ALSO re-derived from that frozen snapshot at test time (pure
 * JS scan, no external grep dependency -- see countOccurrences below) and
 * compared to the frozen number: a mismatch means the fixture itself was built
 * wrong, not that the repo moved, because the snapshot is immutable per run.
 *
 * THREE FAMILIES, THREE DIFFERENT RANKING REGIMES
 * - identifier: mono-term, mode=exact. Neither roadmap item touches this path
 *   (single exact term resolves to a single item). Control group: if this
 *   family ever regresses, the bug is not in Lot B.
 * - multiword: literal string constants containing whitespace. Proven absent
 *   from the index by construction (see the note in the fixture meta, backed
 *   by reading src/coverage/rule.ts classifyPattern and src/parser/
 *   extractor.ts literalText/literalQualifies): a string literal with a space
 *   is rejected at INDEX time, not just unreachable through a single-term
 *   query. This is the structural gap 10096483 exists to close. Asserted to
 *   return zero today, not skipped -- that zero is the baseline.
 * - contains: substring queries against many candidate items, the target of
 *   b27f5663. RANK is measured as the exact minimal `itemLimit` at which the
 *   expected occurrence enters the window returned by query() (binary search;
 *   item order is a strict total order per src/db/queries.ts searchItems
 *   ORDER BY, so window membership is monotone in itemLimit). This is the only
 *   rank-sensitive number observable through the public query() contract
 *   today: the final `matches` array is sorted by file then line (query.ts,
 *   allMatches.sort), NOT by relevance, so a caller cannot see item-relevance
 *   order any other way. A Lot B ranking change that reorders items will move
 *   this number even though it never touches `matches` ordering.
 *
 * THIS FILE IS THE COMPARISON POINT. Re-run it before and after a Lot B change
 * and diff the printed table (afterAll) -- rank should fall or hold for every
 * `contains` entry, itemsTotal for `multiword` should turn nonzero once
 * 10096483 lands, and the `identifier` family must not move at all.
 */

import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { jest, describe, test, beforeAll, afterAll, expect } from '@jest/globals';
import { init } from '../build/commands/init.js';
import { query } from '../build/commands/query.js';
import { isNativeAbiMismatch, nodeAbiGuardMessage } from './helpers/node-interpreter-guard.js';

jest.setTimeout(120000);

const REPO_ROOT = process.cwd();
const CORPUS_PATH = join(REPO_ROOT, 'tests/fixtures/query-corpus.json');
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8'));
const { pinnedCommit } = corpus.meta;

// ============================================================
// Ground truth: pure-JS scan, no external grep binary dependency
// (this repo's `rg` is a Claude Code shell function, not a real PATH binary,
// so spawnSync('rg', ...) is not portable here -- see spec_fd1ed424 notes).
// ============================================================

const SCOPE_EXTS = new Set(['.ts', '.tsx', '.js']);
const SCOPE_EXCLUDE_DIRS = new Set(['node_modules', 'build', '.git']);
const SCOPE_DIRS = ['src', 'tests', 'hooks'];

function walk(dir, out) {
    for (const name of readdirSync(dir)) {
        if (SCOPE_EXCLUDE_DIRS.has(name)) continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (SCOPE_EXTS.has(extname(name))) out.push(full);
    }
}

function scopedFiles(root) {
    const files = [];
    for (const d of SCOPE_DIRS) {
        const full = join(root, d);
        if (existsSync(full)) walk(full, files);
    }
    return files;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Total occurrence count of `pattern` across the scoped file set (ripgrep --count-matches semantics: occurrences, not lines). */
function countOccurrences(root, pattern, { wholeWord = false, caseInsensitive = false } = {}) {
    let escaped = escapeRegex(pattern);
    if (wholeWord) escaped = `\\b${escaped}\\b`;
    const re = new RegExp(escaped, caseInsensitive ? 'gi' : 'g');
    let total = 0;
    for (const file of scopedFiles(root)) {
        const content = readFileSync(file, 'utf-8');
        const matches = content.match(re);
        if (matches) total += matches.length;
    }
    return total;
}

const groundTruth = {
    identifier: (root, term) => countOccurrences(root, term, { wholeWord: true }),
    multiword: (root, term) => countOccurrences(root, term, {}),
    contains: (root, term) => countOccurrences(root, term, { caseInsensitive: true }),
};

// ============================================================
// Rank: exact minimal itemLimit at which the target occurrence appears
// ============================================================

function hasTarget(result, target) {
    return result.matches.some(m => m.file === target.file && m.lineNumber === target.line);
}

/**
 * Binary search over itemLimit. Item order is a strict total order (searchItems
 * ORDER BY exact/prefix/length/alpha/id), so membership in the returned window
 * is monotone: once the target's item is included at some itemLimit, it stays
 * included at every larger itemLimit. That monotonicity is what makes binary
 * search valid here instead of a linear scan.
 */
function findRank(dir, base, target) {
    const wide = query({ ...base, path: dir, itemLimit: 1_000_000, itemOffset: 0, limit: 1_000_000 });
    if (!wide.success) return { rank: null, itemsTotal: 0, found: false, error: wide.error };
    if (!hasTarget(wide, target)) return { rank: null, itemsTotal: wide.itemsTotal, found: false };
    if (wide.itemsTotal <= 1) return { rank: wide.itemsTotal, itemsTotal: wide.itemsTotal, found: true };

    let lo = 1;
    let hi = wide.itemsTotal;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const r = query({ ...base, path: dir, itemLimit: mid, itemOffset: 0, limit: 1_000_000 });
        if (r.success && hasTarget(r, target)) hi = mid; else lo = mid + 1;
    }
    return { rank: lo, itemsTotal: wide.itemsTotal, found: true };
}

// Node ABI guard: extracted to tests/helpers/node-interpreter-guard.js so
// this file and tests/cli-update.test.js share one resolution discipline
// instead of two hand-rolled ones. See that module's header for why.

// ============================================================
// Harness
// ============================================================

describe('query corpus baseline (spec_fd1ed424)', () => {
    let dir;
    const results = [];

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'aidex-query-corpus-'));

        const archive = spawnSync('git', ['archive', pinnedCommit], {
            cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 64,
        });
        if (archive.status !== 0) {
            throw new Error(`git archive ${pinnedCommit} failed (status ${archive.status}): ${archive.stderr?.toString()}`);
        }

        const extract = spawnSync('tar', ['-x'], { cwd: dir, input: archive.stdout });
        if (extract.status !== 0) {
            throw new Error(`tar extract into ${dir} failed (status ${extract.status}): ${extract.stderr?.toString()}`);
        }

        return init({ path: dir }).then((res) => {
            if (!res.success) throw new Error(`init failed on pinned snapshot: ${JSON.stringify(res)}`);
        }).catch((err) => {
            if (isNativeAbiMismatch(err)) throw new Error(nodeAbiGuardMessage(err));
            throw err;
        });
    }, 120000);

    afterAll(() => {
        if (results.length) {
            // The comparison point: re-run before/after a Lot B change and diff.
            console.log('\n[query-corpus baseline] spec_fd1ed424, pinned commit ' + pinnedCommit);
            console.table(results.map(r => ({
                id: r.id,
                family: r.family,
                query: r.query,
                itemsTotal: r.itemsTotal,
                totalMatches: r.totalMatches,
                rank: r.rank ?? '-',
                elapsedMs: r.elapsedMs,
            })));
        }
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    for (const entry of corpus.queries) {
        test(`${entry.id} [${entry.family}] "${entry.query}"`, () => {
            const base = { term: entry.query, mode: entry.mode, kinds: entry.kinds };

            // Fixture-drift guard: re-derive ground truth from the frozen
            // snapshot itself, independent of the frozen number in the JSON.
            const freshGroundTruth = groundTruth[entry.family](dir, entry.query);
            expect(freshGroundTruth).toBe(entry.grepGroundTruth.count);

            const t0 = Date.now();
            const res = query({ ...base, path: dir, itemLimit: 1_000_000, limit: 1_000_000 });
            const elapsedMs = Date.now() - t0;
            expect(res.success).toBe(true);

            const record = {
                id: entry.id, family: entry.family, query: entry.query,
                itemsTotal: res.itemsTotal, totalMatches: res.totalMatches,
                elapsedMs, rank: null,
            };

            if (entry.family === 'identifier') {
                // Control group: neither roadmap item touches this path.
                expect(res.itemsTotal).toBeGreaterThan(0);
                expect(res.totalMatches).toBeGreaterThan(0);
            } else if (entry.family === 'multiword') {
                // The structural gap 10096483 exists to close: a phrase with
                // whitespace is provably present in source (freshGroundTruth
                // above already proved that) yet absent from the index.
                expect(res.itemsTotal).toBe(0);
                expect(res.totalMatches).toBe(0);
            } else {
                const { rank, itemsTotal, found } = findRank(dir, base, entry.targetOccurrence);
                expect(found).toBe(true);
                expect(rank).not.toBeNull();
                record.rank = rank;
                record.itemsTotal = itemsTotal;
            }

            results.push(record);
        });
    }
});
