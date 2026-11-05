/**
 * Coverage predicate -- the single source of truth for "what does this index
 * know about?".
 *
 * THREE consumers, ONE producer:
 *   - the indexer decides what to index with `classifyPattern`, and writes the
 *     measured per-language coverage into `metadata` at the end of a reindex;
 *   - the coverage oracle (`commands/coverage.ts`) answers callers with it;
 *   - the empty-result notice in `server/tools.ts` reads it back.
 *
 * The percentages are never hardcoded here. They are MEASURED per index at
 * reindex time, because they vary far too much to be a constant: measured
 * 2026-08-10, literal coverage under the strict rule ran 9.8% on Go against
 * 29.9% on TypeScript, and 18.8% vs 29.9% between two TypeScript projects.
 * A constant written in the docs would have been wrong almost everywhere.
 */

/** Minimal surface we need from the project DB (see db/database.ts). */
export interface MetadataReader {
    getMetadata(key: string): string | null;
}

// ============================================================
// Versions
// ============================================================

/**
 * The `schema_version` at which an index carries literal occurrences.
 * Below it, the literal dimension is UNKNOWN -- not empty. An index that has
 * not been fully reindexed under a literal-aware build cannot prove a literal
 * is absent, so it must never claim coverage over it.
 */
export const LITERAL_COVERAGE_SCHEMA = '1.3';

/** Metadata key holding the JSON coverage record written by the indexer. */
export const COVERAGE_METADATA_KEY = 'literal_coverage';

/**
 * Identity of the rule an index was built under.
 *
 * There is exactly one rule today, so this is a constant -- but it is STORED in
 * the index anyway, for the same reason `schema_version` is: the day the rule
 * changes, an index built under the old one must be able to SAY so instead of
 * letting a caller assume it covers what the current rule covers. A schema lock
 * would not catch it, because the tables are unchanged; only the semantics move.
 */
export const LITERAL_RULE_ID = 'strict+typepos';
/**
 * Bumped 1 -> 2 (f08aeeb1): the whitespace guard in `classifyPattern` was
 * lifted, so multi-word literals now qualify. An index built under version 1
 * holds NONE of them -- not "few", none, by construction of the old guard.
 * Without this bump `readCoverage` would keep reporting `literalsIndexed: true`
 * on such an index and the oracle would answer `covered: true` for a
 * multi-word pattern the index never held: exactly the false positive this
 * module exists to prevent. The version bump forces `ruleOutdated: true`
 * instead, so every consumer refuses until a full reindex.
 */
export const LITERAL_RULE_VERSION = 2;

/**
 * NO configuration lever, by decision -- not for the `kinds` default, not for
 * the indexing rule, and specifically not via an environment variable.
 *
 * The oracle exists to predict what a query will ACTUALLY return. A default
 * living in the environment would force the oracle to read the same environment
 * to stay correct, rebuilding the guesser this module was written to delete,
 * with one more channel to diverge through. Worse for the rule itself: the
 * coverage percentages are measured at reindex and stored per index, so a rule
 * depending on outside state would leave two indexes of the same schema with
 * different semantics and a banner that lies without any signal.
 *
 * If a lever ever becomes necessary, it goes PER PROJECT in the index metadata
 * -- the house form already used for embeddings and `llm_send_code` -- never in
 * an env var or a machine-global setting. The unit that means anything is the
 * index: two projects may legitimately want different settings, while one
 * project must answer identically from any terminal.
 */

// ============================================================
// Pattern classification
// ============================================================

export type PatternDimension = 'symbol' | 'literal' | 'none';

export type PatternReason =
    | 'symbol_shaped'
    | 'literal_shaped'
    | 'below_literal_rule'
    | 'not_indexable';

export interface PatternClass {
    /** Whether any AiDex dimension could ever hold this pattern. */
    indexable: boolean;
    /** Which dimension is reported to the caller. */
    dimension: PatternDimension;
    /** True when a bare code identifier could carry this text (always indexed). */
    symbolShaped: boolean;
    /**
     * Where the pattern sits relative to the literal indexing rule.
     * `below` is the trap: a bare lowercase word like `ok` IS a valid symbol AND
     * a possible literal, and the literal side is only indexed in specific
     * syntactic positions. Claiming coverage on the symbol side alone would let
     * a caller read an empty result as proof of absence -- the exact failure
     * this module exists to prevent.
     */
    literalRule: 'above' | 'below' | 'not_literal_shaped';
    reason: PatternReason;
}

/**
 * Chars allowed in an identifier-shaped literal, plus a single interior space
 * (f08aeeb1: multi-word literals). Only ONE space between words ever reaches
 * this regex because `classifyPattern` normalizes its input first -- a run of
 * whitespace never survives to be tested here.
 */
const LITERAL_SHAPE = /^[A-Za-z0-9_:.\-/ ]+$/;
/** Chars allowed in a bare code symbol. */
const SYMBOL_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const MIN_LEN = 2;
const MAX_LEN = 64;

/**
 * Collapse any run of whitespace (space, tab, newline, CR) to a single space,
 * and trim the ends.
 *
 * This is the ONLY normalization form for a literal's text, and it must be
 * applied at BOTH ends of the same pipe: `extractor.ts` calls it before
 * storing a literal's term, `db/queries.ts` calls it before matching a query
 * against those terms, and `classifyPattern` below calls it before shape/length
 * checks so a caller never has to normalize by hand first. A drift between any
 * of these call sites -- one normalizing, one not -- produces a silent miss:
 * the index holds the canonical form, the query builds a raw one, and nothing
 * ever matches even though the text is "the same" to a human reader.
 */
export function normalizeLiteralWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Classify a search pattern against the indexing rules.
 *
 * Deliberately mechanical: no heuristics, no scoring. A caller must be able to
 * predict the answer from the pattern alone, because this verdict is what makes
 * an empty result interpretable.
 */
export function classifyPattern(pattern: string): PatternClass {
    const p = normalizeLiteralWhitespace(pattern ?? '');

    if (p.length < MIN_LEN || p.length > MAX_LEN || /\$\{|\{\}|%[sdv]/.test(p)) {
        return {
            indexable: false, dimension: 'none', symbolShaped: false,
            literalRule: 'not_literal_shaped', reason: 'not_indexable',
        };
    }

    const symbolShaped = SYMBOL_SHAPE.test(p);
    const literalShaped = LITERAL_SHAPE.test(p) && /[A-Za-z]/.test(p);

    if (!symbolShaped && !literalShaped) {
        return {
            indexable: false, dimension: 'none', symbolShaped: false,
            literalRule: 'not_literal_shaped', reason: 'not_indexable',
        };
    }

    // The literal rule, evaluated INDEPENDENTLY of the symbol shape. Both apply
    // to the same text: `restoreWorkspace` is a symbol and could also sit in a
    // string; `ok` likewise. Only the strict form (a separator or mixed case) is
    // indexed unconditionally.
    const hasSeparator = /[:\-._/]/.test(p);
    const isMixedCase = /[a-z]/.test(p) && /[A-Z]/.test(p);
    // f08aeeb1 gate fix [4]: the position restriction applied below (only
    // 'below' literals are gated to type/jsx/object_value position) in
    // practice only ever binds all-lowercase, unpunctuated phrases. Any
    // literal with a separator char OR any capital letter -- which covers
    // ordinary capitalized English sentences like "Failed to load config" or
    // "Error while loading" -- already resolves to 'above' and is indexed
    // unconditionally, position notwithstanding. This was unchanged in
    // f08aeeb1 (no separator/case logic was touched), but the commit message
    // describing it as "unchanged" was true for the code and misleading about
    // effect: only a narrow slice of literals is actually still constrained.
    const literalRule: PatternClass['literalRule'] =
        !literalShaped ? 'not_literal_shaped'
            : (hasSeparator || isMixedCase) ? 'above'
                : 'below';

    // Report the dimension the caller most likely means, but the verdict is
    // driven by literalRule, not by this label.
    const dimension: PatternDimension = symbolShaped ? 'symbol' : 'literal';

    if (literalRule === 'below') {
        return { indexable: true, dimension, symbolShaped, literalRule, reason: 'below_literal_rule' };
    }

    return {
        indexable: true, dimension, symbolShaped, literalRule,
        reason: symbolShaped ? 'symbol_shaped' : 'literal_shaped',
    };
}

// ============================================================
// The indexing side of the same rule
// ============================================================

/**
 * Where a string literal sits in the syntax tree, reduced to the only
 * distinction the rule makes.
 *
 * Measured 2026-08-10 on koryphaios, by hand-reading random samples: in these
 * three positions a bare lowercase word is a discriminating name 7 times out of
 * 12 (type/JSX) and 33 times out of 100 (object value), against noise almost
 * everywhere else. `other` is every remaining position, including the array and
 * call-argument positions deferred to Lot 4.
 */
export type LiteralPosition = 'type' | 'jsx' | 'object_value' | 'other';

/**
 * Does this literal text, in this position, get indexed?
 *
 * This is the INDEXER half of the module, and it deliberately runs through the
 * same `classifyPattern` the oracle answers with. Two predicates -- one deciding
 * what goes in, one predicting what comes out -- would drift, and the drift
 * would show up as an index quietly not holding what the oracle promises.
 */
export function literalQualifies(text: string, position: LiteralPosition): boolean {
    const cls = classifyPattern(text);
    if (!cls.indexable || cls.literalRule === 'not_literal_shaped') {
        return false;
    }
    // Strict form (a separator or mixed case): indexed wherever it appears.
    if (cls.literalRule === 'above') {
        return true;
    }
    // Single lowercase word: only in the three privileged positions. This is
    // exactly the `below` verdict the oracle reports, seen from the other side.
    return position !== 'other';
}

// ============================================================
// Per-index coverage record
// ============================================================

/**
 * One language's measurement.
 *
 * The SAMPLE SIZE ships with the percentage, and that is not bookkeeping. The
 * first real run of this measurement reported `java: 100%` on koryphaios --
 * true, and meaningless: the project had exactly two Java files holding one
 * string literal between them. A bare percentage makes a sample of 1 look
 * exactly like a sample of 10 000, which is the same failure mode as an
 * unqualified zero -- a number that reads as knowledge and is not.
 */
export interface LanguageCoverage {
    /** Percentage of string literals indexed, one decimal. */
    percent: number;
    /** String literals encountered. `seen` of 1 makes any percent meaningless. */
    seen: number;
    /** Of those, the ones the rule kept. */
    indexed: number;
}

export interface CoverageRecord {
    /** Rule this index was built under. */
    ruleId: string;
    ruleVersion: number;
    /** Per-language measurement, taken at reindex over THIS repository. */
    perLanguage: Record<string, LanguageCoverage>;
    /** Unix ms of the reindex that produced these figures. */
    measuredAt: number;
}

export interface IndexCoverage {
    schemaVersion: string;
    /**
     * True only when this index was built by a literal-aware build, fully
     * reindexed, UNDER THE CURRENT RULE. A stale rule means the index covers
     * something other than what the running code would claim.
     */
    literalsIndexed: boolean;
    /** Set when the index carries literals built under a different rule. */
    ruleOutdated: boolean;
    record: CoverageRecord | null;
}

/**
 * Read what THIS index knows. Never computes anything: it reports the figures
 * the indexer measured on this repository.
 */
export function readCoverage(db: MetadataReader): IndexCoverage {
    const schemaVersion = db.getMetadata('schema_version') ?? '0';
    const raw = db.getMetadata(COVERAGE_METADATA_KEY);

    let record: CoverageRecord | null = null;
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as CoverageRecord;
            if (parsed && typeof parsed === 'object' && parsed.perLanguage) {
                record = parsed;
            }
        } catch {
            // A malformed record means "unknown", never "zero".
            record = null;
        }
    }

    const schemaOk = compareVersions(schemaVersion, LITERAL_COVERAGE_SCHEMA) >= 0 && record !== null;
    const ruleOk = record !== null
        && record.ruleId === LITERAL_RULE_ID
        && record.ruleVersion === LITERAL_RULE_VERSION;

    return {
        schemaVersion,
        literalsIndexed: schemaOk && ruleOk,
        ruleOutdated: schemaOk && !ruleOk,
        record,
    };
}

/** Numeric dotted-version compare. '1.10' sorts above '1.9', unlike a string compare. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(n => parseInt(n, 10) || 0);
    const pb = b.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

// ============================================================
// The one-line notice for empty results
// ============================================================

/**
 * One line, appended to an empty result. Two lines total with the "No matches"
 * line above it: what is missing, and what to do about it.
 *
 * The per-language percentages deliberately do NOT go here. They are read once,
 * from the tool description and the docs. This line is emitted on every empty
 * result of every session, and the whole point of the index is to SAVE context.
 * The only case that earns extra words is a pattern that falls precisely in the
 * uncovered zone, because there the coverage IS the answer.
 */
export function coverageNotice(
    pattern: string,
    coverage: IndexCoverage,
    rebuildCmd?: string | null
): string | null {
    const cls = classifyPattern(pattern);
    // Reindexing is manual, so a machine stays mixed indefinitely. The remedy
    // rides along with the refusal instead of living in a doc nobody reopens.
    const fix = rebuildCmd ? ` Rebuild: ${rebuildCmd}` : '';

    if (cls.reason === 'not_indexable') {
        // f08aeeb1 gate fix [3]: whitespace stopped being a not_indexable
        // cause when classifyPattern started normalizing it (f08aeeb1). Only
        // interpolation/format specifiers and the length bounds remain.
        return `"${pattern}" is not an indexable shape (interpolation or too long): AiDex never held it. Use grep.`;
    }

    if (coverage.ruleOutdated) {
        return `This index carries literals built under rule ${coverage.record?.ruleId}@${coverage.record?.ruleVersion}, not the current ${LITERAL_RULE_ID}@${LITERAL_RULE_VERSION}: its coverage is not what this build would claim. Use grep.${fix}`;
    }

    if (!coverage.literalsIndexed) {
        if (!cls.symbolShaped) {
            return `Literal coverage ABSENT (schema ${coverage.schemaVersion}) and "${pattern}" is literal-shaped: this zero proves nothing. Use grep.${fix}`;
        }
        return `Symbols only (schema ${coverage.schemaVersion}): literals are not indexed, so a zero is not proof of absence. Use grep.${fix}`;
    }

    if (cls.literalRule === 'below') {
        return `"${pattern}" is a single lowercase word: indexed as a literal only in type/JSX/object-value position, so this zero is not proof of absence. Use grep.`;
    }

    return null;
}
