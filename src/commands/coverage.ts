/**
 * coverage command -- the oracle: "can AiDex answer this pattern?"
 *
 * Built for a caller that decides whether to BLOCK a grep. That asymmetry drives
 * every choice below: a wrong `covered: true` costs an unjustified block and
 * teaches an agent to work around the tooling, while a wrong `covered: false`
 * costs one redundant grep. So `covered` is true ONLY when the index can answer
 * both the symbol and the literal dimension for this pattern and this path.
 */

import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { join, resolve, relative } from 'path';
import { validateIndex, withDatabase, normalizePath } from './shared.js';
import { classifyPattern, readCoverage, coverageNotice, LITERAL_RULE_ID, LITERAL_RULE_VERSION, type PatternClass } from '../coverage/rule.js';

// ============================================================
// Types
// ============================================================

/**
 * Closed enumeration. A caller branches on this, so adding a value is a
 * contract change: new reasons must default to NOT blocking.
 */
export type CoverageReason =
    /** Index answers both dimensions for this pattern and path. ONLY blocking value. */
    | 'covered'
    /** Present as a symbol, but the literal dimension is unknown on this index. */
    | 'covered_symbols_only'
    /** Index predates literal coverage: a zero says nothing about literals. */
    | 'literal_coverage_absent'
    /** Index has literals, but built under a different rule than this build. */
    | 'literal_rule_outdated'
    /** Identifier-shaped, but under the literal indexing rule. */
    | 'pattern_below_literal_rule'
    /** Whitespace, interpolation, oversized: never held by any dimension. */
    | 'pattern_not_indexable'
    /** File is under the project root but absent from the index. */
    | 'path_out_of_scope'
    /** File is indexed but has changed since. */
    | 'index_stale_on_file'
    /** No .aidex/index.db at this path. */
    | 'project_not_indexed'
    /** The oracle itself failed. Never a verdict -- callers must fail open. */
    | 'oracle_error';

export interface CoverageParams {
    path: string;
    pattern: string;
    /** Optional file the search is scoped to. */
    target?: string;
}

export interface CoverageVerdict {
    covered: boolean;
    reason: CoverageReason;
    pattern: string;
    /** Which dimension would hold this pattern, per the shared rule. */
    dimension: PatternClass['dimension'];
    scope: 'in_scope' | 'out_of_scope' | null;
    schemaVersion: string | null;
    /**
     * The rule this index was built under, echoed even though there is only one
     * today. A verdict that describes itself stays correct the day the rule moves.
     */
    rule: { id: string; version: number } | null;
    /**
     * The effective `kinds` a query would use, echoed even when it is the
     * default. Same reason: the answer describes the query it predicts, so it
     * does not silently become wrong if a lever ever appears.
     */
    kinds: string[];
    /** What the caller can do about it. Null when nothing is wrong. */
    advice: string | null;
    error?: string;
}

/**
 * The `kinds` a query uses today. Not configurable, by decision -- see the note
 * in coverage/rule.ts. Echoed so the contract is visible rather than assumed.
 */
export const DEFAULT_KINDS = ['symbol'] as const;

// ============================================================
// Main
// ============================================================

export function can(params: CoverageParams): CoverageVerdict {
    const pattern = params.pattern ?? '';
    const cls = classifyPattern(pattern);

    const base: CoverageVerdict = {
        covered: false,
        reason: 'oracle_error',
        pattern,
        dimension: cls.dimension,
        scope: null,
        schemaVersion: null,
        rule: null,
        kinds: [...DEFAULT_KINDS],
        advice: null,
    };

    const dbPath = validateIndex(params.path);
    if (!dbPath) {
        return {
            ...base,
            reason: 'project_not_indexed',
            advice: `No index at ${params.path}. Run aidex_init to create one.`,
        };
    }

    return withDatabase(dbPath, true, (db, queries) => {
        const coverage = readCoverage(db);
        const v: CoverageVerdict = {
            ...base,
            schemaVersion: coverage.schemaVersion,
            rule: coverage.record
                ? { id: coverage.record.ruleId, version: coverage.record.ruleVersion }
                : null,
        };

        // ---- path scoping, before anything else -------------------------
        // An out-of-scope or stale file makes every other answer moot: the
        // index simply has nothing to say about that file.
        if (params.target) {
            const abs = resolve(params.target);
            const rel = normalizePath(relative(resolve(params.path), abs));
            if (!rel || rel.startsWith('..')) {
                return {
                    ...v, reason: 'path_out_of_scope', scope: 'out_of_scope',
                    advice: `${params.target} is outside ${params.path}.`,
                };
            }
            const row = queries.getFileByPath(rel);
            if (!row) {
                return {
                    ...v, reason: 'path_out_of_scope', scope: 'out_of_scope',
                    advice: `${rel} is not indexed (excluded, or never indexed). Use grep on it.`,
                };
            }
            if (!existsSync(abs) || hashFile(abs) !== row.hash) {
                return {
                    ...v, reason: 'index_stale_on_file', scope: 'in_scope',
                    advice: `${rel} changed since indexing. Run aidex_update on it, or use grep.`,
                };
            }
            v.scope = 'in_scope';
        }

        // ---- pattern shape ----------------------------------------------
        if (cls.reason === 'not_indexable') {
            return {
                ...v, reason: 'pattern_not_indexable',
                advice: 'Whitespace, interpolation or oversized pattern: no AiDex dimension holds it. Use grep.',
            };
        }

        // ---- the literal dimension ---------------------------------------
        // Below LITERAL_COVERAGE_SCHEMA the literal dimension is UNKNOWN, not
        // empty. A symbol hit does not license `covered`: the same text could
        // also occur as a literal that this index never recorded.
        // Literals present, but produced by a different rule than this build
        // implements. The tables look current, only the meaning moved -- so the
        // schema lock cannot catch this and the rule identity must.
        if (coverage.ruleOutdated) {
            return {
                ...v, reason: 'literal_rule_outdated',
                advice: `Index built under rule ${coverage.record?.ruleId}@${coverage.record?.ruleVersion}, this build implements ${LITERAL_RULE_ID}@${LITERAL_RULE_VERSION}. Rebuild: ${rebuildCommand(params.path)}`,
            };
        }

        if (!coverage.literalsIndexed) {
            const hit = hasSymbol(queries, pattern);
            return {
                ...v,
                reason: hit ? 'covered_symbols_only' : 'literal_coverage_absent',
                advice: `Symbols only (schema ${coverage.schemaVersion}). Use grep to prove an absence, or rebuild: ${rebuildCommand(params.path)}`,
            };
        }

        // A bare lowercase word is a valid symbol AND a possible literal. The
        // symbol side being indexed does not license `covered`: the literal side
        // is only indexed in certain syntactic positions, which the pattern
        // alone cannot reveal.
        if (cls.literalRule === 'below') {
            return {
                ...v, reason: 'pattern_below_literal_rule',
                advice: 'Single lowercase word: indexed as a literal only in type/JSX/object-value position. Use grep to prove an absence.',
            };
        }

        return { ...v, covered: true, reason: 'covered', advice: null };
    });
}

// ============================================================
// Helpers
// ============================================================

/**
 * The exact, copy-pasteable command that lifts a project to literal coverage.
 *
 * Reindexing is MANUAL by decision: nothing here ever triggers it. A machine
 * therefore lives indefinitely in a mixed state -- some projects rebuilt, others
 * never. So the remedy has to travel with every honest refusal, or the operator
 * re-derives it each time and reads the limit as a breakage.
 */
export function rebuildCommand(projectPath: string): string {
    // Derived from THIS module's location, not from `process.argv[1]`.
    // argv[1] is whatever script the process was started with, which is only
    // AiDex's entry point when AiDex is the program being run: called as a
    // library -- a test, a probe, an embedding host -- it named the caller's
    // own script, so the emitted remedy re-ran the caller instead of rebuilding
    // anything. This file sits at `<root>/commands/coverage.js`, so the entry
    // point is one level up, whoever is calling.
    const entry = fileURLToPath(new URL('../index.js', import.meta.url));
    // `process.execPath`, not the string "node": the interpreter on PATH is not
    // necessarily the one this build runs under, and the difference is fatal
    // rather than cosmetic -- better-sqlite3 and tree-sitter are native addons,
    // so a PATH `node` from another major aborts with NODE_MODULE_VERSION
    // mismatch. This process is provably able to load them, so naming it makes
    // the emitted remedy runnable by construction. Quoted: it routinely lives
    // under a path with spaces.
    return `"${normalizePath(process.execPath)}" "${normalizePath(entry)}" rebuild-index "${normalizePath(resolve(projectPath))}"`;
}

/** Same digest as init.ts, so a mismatch means the same thing on both sides. */
function hashFile(absPath: string): string {
    return createHash('sha256')
        .update(readFileSync(absPath, 'utf-8'))
        .digest('hex')
        .substring(0, 16);
}

function hasSymbol(queries: { searchItems: (t: string, m: 'exact', l: number) => Array<unknown> }, term: string): boolean {
    return queries.searchItems(term, 'exact', 1).length > 0;
}

/** Location of a project index, for callers that only have a file path. */
export function indexPathFor(projectPath: string): string {
    return join(projectPath, '.aidex', 'index.db');
}

/**
 * The single extra line appended to an EMPTY query result. Same predicate as
 * the oracle -- there is no second copy of the rule. Returns null when the
 * empty answer needs no caveat.
 *
 * Only reached on an empty result, so the extra DB open costs nothing on the
 * hot path.
 */
export function noticeFor(projectPath: string, pattern: string): string | null {
    const dbPath = validateIndex(projectPath);
    if (!dbPath) return null;
    try {
        return withDatabase(dbPath, true, (db) =>
            coverageNotice(pattern, readCoverage(db), rebuildCommand(projectPath))
        );
    } catch {
        // A notice is never worth failing a query over.
        return null;
    }
}

/**
 * Notice for a cross-project empty result. No single index to read, so it
 * states the shape verdict only -- coverage is per index by construction.
 */
export function globalNotice(pattern: string): string | null {
    const cls = classifyPattern(pattern);
    if (cls.reason === 'not_indexable') {
        return `"${pattern}" is not an indexable shape: AiDex never held it. Use grep.`;
    }
    if (cls.dimension === 'literal' || cls.reason === 'below_literal_rule') {
        return `"${pattern}" is literal-shaped and literal coverage is per index: this zero is not proof of absence. Use grep, or check aidex_coverage on the project you care about.`;
    }
    return `Symbols only unless a project was rebuilt for literal coverage: a zero here is not proof of absence across all projects.`;
}
