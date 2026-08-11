/**
 * query command - Search for terms in the index
 */

import { withProjectDb } from './shared.js';
import { globToRegex } from '../utils/glob.js';
import { readCoverage, LITERAL_RULE_ID, LITERAL_RULE_VERSION } from '../coverage/rule.js';
// `coverage.ts` does not import this module, so the remedy string can be shared
// without a cycle: one command emits the rebuild line, everything else quotes it.
import { rebuildCommand } from './coverage.js';

// ============================================================
// Types
// ============================================================

export type QueryMode = 'exact' | 'contains' | 'starts_with';

/**
 * Which dimension of the index to search.
 *
 * Separate from `typeFilter` on purpose. `typeFilter` selects a LINE type
 * (code / comment / method / struct / property / string); `kinds` selects why
 * the occurrence exists. One parameter filtering two namespaces would fail
 * silently the day a value collided between them -- and it would already be
 * wrong today, since a literal occurrence usually sits on a line that is
 * already typed `code`.
 */
export type QueryKind = 'symbol' | 'literal';

/**
 * Default is symbols only, so every query written before literals existed
 * returns exactly what it returned before. Discoverability of the literal
 * dimension is handled by the count reported on an empty result, not by
 * widening the default under people's feet.
 */
export const DEFAULT_QUERY_KINDS: QueryKind[] = ['symbol'];

/**
 * How many matching TERMS one call looks at. Distinct from `limit`, which caps
 * the MATCHES finally shown: a term evicted here contributes no match at all,
 * which is why the window has to be visible and pageable rather than silent.
 */
export const DEFAULT_ITEM_WINDOW = 1000;

export interface QueryParams {
    path: string;
    term: string;
    mode?: QueryMode;
    fileFilter?: string;
    typeFilter?: string[];
    kinds?: QueryKind[];
    /** Terms to skip, for reading past the first window. */
    itemOffset?: number;
    /** Terms to look at in this call (default 1000). */
    itemLimit?: number;
    modifiedSince?: string;
    modifiedBefore?: string;
    limit?: number;
}

export interface QueryMatch {
    file: string;
    lineNumber: number;
    lineType: string;
    modified?: number;
}

export interface QueryResult {
    success: boolean;
    term: string;
    mode: QueryMode;
    /** The kinds actually used, echoed even when it is the default. */
    kinds: QueryKind[];
    matches: QueryMatch[];
    totalMatches: number;
    /**
     * Matches that exist in the OTHER kinds, not returned under `kinds`.
     * This is the teaser that makes the literal dimension discoverable without
     * changing the default.
     */
    otherKindMatches: number;
    /**
     * Does THIS index declare literal coverage under the CURRENT rule?
     *
     * Carried on the result so the tool layer can pick its notice without
     * reopening the database -- and so it cannot invite a caller to re-run with
     * `kinds: ["literal"]` on an index where that re-run would be refused.
     */
    literalDimensionAvailable: boolean;
    truncated: boolean;
    /** Matching TERMS in the index, before the window. */
    itemsTotal: number;
    /** Terms this call actually looked at. */
    itemsReturned: number;
    /** Terms skipped before this window. */
    itemOffset: number;
    /**
     * True when terms exist beyond this window. Reported rather than silent:
     * a caller that cannot see the cut has no way to tell "nothing else" from
     * "nothing else HERE", which is the same failure as an unqualified zero.
     */
    itemsTruncated: boolean;
    error?: string;
}

// ============================================================
// Main query function
// ============================================================

export function query(params: QueryParams): QueryResult {
    const mode = params.mode ?? 'exact';
    const limit = params.limit ?? 100;
    const kinds: QueryKind[] = (params.kinds && params.kinds.length > 0)
        ? params.kinds
        : DEFAULT_QUERY_KINDS;

    // 'both' means the term is that kind AND the other one on the same line, so
    // it satisfies a filter on either.
    const kindMatches = (k: string): boolean => k === 'both' || kinds.includes(k as QueryKind);

    return withProjectDb(
        params.path, true,
        (error) => ({ success: false, term: params.term, mode, kinds, matches: [], totalMatches: 0, otherKindMatches: 0, literalDimensionAvailable: false, truncated: false, itemsTotal: 0, itemsReturned: 0, itemOffset: 0, itemsTruncated: false, error }),
        (db, queries) => {
            try {
                const coverage = readCoverage(db);
                const literalDimensionAvailable = coverage.literalsIndexed;

                // ---- the guard --------------------------------------------
                // An index only answers for the literal dimension once it
                // DECLARES it. Since Lot 3, `aidex_update` writes literal
                // occurrences into whatever index it touches without advancing
                // `schema_version`, so an index can hold literals for the three
                // files that changed today and nothing else -- and answering
                // from those would be a partial index presenting itself as a
                // complete one, which is worse than holding none at all.
                //
                // Refused whole, never half-answered: returning the symbol side
                // of a mixed `kinds` while silently dropping an unreliable
                // literal side is the same lie in a quieter voice.
                //
                // On an index that genuinely holds no literals this replaces a
                // mute zero with a refusal that says why -- same information,
                // honest shape.
                if (kinds.includes('literal') && !literalDimensionAvailable) {
                    const rebuild = rebuildCommand(params.path);
                    const error = coverage.ruleOutdated
                        ? `This index carries literals built under rule ${coverage.record?.ruleId}@${coverage.record?.ruleVersion}, `
                          + `not the current ${LITERAL_RULE_ID}@${LITERAL_RULE_VERSION}: what it holds is not what this build would index, `
                          + `so the literal dimension is refused rather than answered wrongly. Rebuild: ${rebuild}`
                        : `This index does not declare literal coverage (schema ${coverage.schemaVersion}): `
                          + `it may hold literals for a few updated files and none for the rest, so a literal answer would be `
                          + `partial while looking complete. Use grep, or rebuild: ${rebuild}`;
                    return {
                        success: false,
                        term: params.term,
                        mode,
                        kinds,
                        matches: [],
                        totalMatches: 0,
                        otherKindMatches: 0,
                        literalDimensionAvailable,
                        truncated: false,
                        itemsTotal: 0,
                        itemsReturned: 0,
                        itemOffset: 0,
                        itemsTruncated: false,
                        error,
                    };
                }

                // ---- the term window --------------------------------------
                // Items whose every occurrence is a literal are dropped in SQL
                // when the caller did not ask for literals, so they cannot take
                // seats in a window meant for symbols. Measured before this
                // existed: 14% to 22% of items on real indexes are literal-only.
                const wantsLiterals = kinds.includes('literal');
                const itemOffset = Math.max(0, params.itemOffset ?? 0);
                const itemLimit = Math.max(1, params.itemLimit ?? DEFAULT_ITEM_WINDOW);

                const itemsTotal = queries.countItems(params.term, mode, wantsLiterals);
                const items = queries.searchItems(params.term, mode, itemLimit, itemOffset, wantsLiterals);
                const itemsTruncated = itemOffset + items.length < itemsTotal;
                const window = {
                    itemsTotal,
                    itemsReturned: items.length,
                    itemOffset,
                    itemsTruncated,
                };

                if (items.length === 0) {
                    return {
                        success: true,
                        term: params.term,
                        mode,
                        kinds,
                        matches: [],
                        totalMatches: 0,
                        // Nothing under the requested kinds. If the term exists
                        // ONLY as a literal, the SQL filter above already
                        // removed it, so the count has to be taken separately
                        // or the literal dimension becomes invisible again --
                        // the very thing the teaser exists to prevent.
                        otherKindMatches: wantsLiterals
                            ? 0
                            : queries.countItems(params.term, mode, true) - itemsTotal,
                        literalDimensionAvailable,
                        truncated: false,
                        ...window,
                    };
                }

                // Parse time filters
                const modifiedSinceTs = params.modifiedSince ? parseTimeOffset(params.modifiedSince) : null;
                const modifiedBeforeTs = params.modifiedBefore ? parseTimeOffset(params.modifiedBefore) : null;

                // Pre-compile file filter regex
                const fileFilterRegex = params.fileFilter ? globToRegex(params.fileFilter) : null;

                // Batch fetch all occurrences at once (eliminates N+1)
                const allOccurrences = queries.getOccurrencesByItems(items.map(i => i.id));
                let allMatches: QueryMatch[] = [];
                const otherKindKeys = new Set<string>();

                for (const occ of allOccurrences) {
                    // Apply file filter
                    if (fileFilterRegex && !fileFilterRegex.test(occ.path.replace(/\\/g, '/'))) {
                        continue;
                    }

                    // Kind filter. What it excludes is COUNTED, not discarded:
                    // that count is what tells an empty answer to point at the
                    // other dimension instead of looking like an absence.
                    if (!kindMatches(occ.kind)) {
                        otherKindKeys.add(`${occ.path}:${occ.line_number}`);
                        continue;
                    }

                    // Apply type filter
                    if (params.typeFilter && params.typeFilter.length > 0) {
                        if (!params.typeFilter.includes(occ.line_type)) {
                            continue;
                        }
                    }

                    // Apply time filters
                    if (modifiedSinceTs !== null && occ.modified !== null) {
                        if (occ.modified < modifiedSinceTs) {
                            continue;
                        }
                    }
                    if (modifiedBeforeTs !== null && occ.modified !== null) {
                        if (occ.modified > modifiedBeforeTs) {
                            continue;
                        }
                    }

                    allMatches.push({
                        file: occ.path,
                        lineNumber: occ.line_number,
                        lineType: occ.line_type,
                        modified: occ.modified ?? undefined,
                    });
                }

                // Remove duplicates (same file + line)
                const seen = new Set<string>();
                allMatches = allMatches.filter(m => {
                    const key = `${m.file}:${m.lineNumber}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });

                // Sort by file, then line number
                allMatches.sort((a, b) => {
                    const fileCompare = a.file.localeCompare(b.file);
                    if (fileCompare !== 0) return fileCompare;
                    return a.lineNumber - b.lineNumber;
                });

                const totalMatches = allMatches.length;
                const truncated = allMatches.length > limit;

                if (truncated) {
                    allMatches = allMatches.slice(0, limit);
                }

                return {
                    success: true,
                    term: params.term,
                    mode,
                    kinds,
                    matches: allMatches,
                    totalMatches,
                    // Same reasoning as the empty branch: literal-only terms
                    // were filtered in SQL, so their count is added back here
                    // rather than inferred from occurrences that never loaded.
                    otherKindMatches: otherKindKeys.size + (wantsLiterals
                        ? 0
                        : queries.countItems(params.term, mode, true) - itemsTotal),
                    literalDimensionAvailable,
                    truncated,
                    ...window,
                };

            } catch (error) {
                return {
                    success: false,
                    term: params.term,
                    mode,
                    kinds,
                    matches: [],
                    totalMatches: 0,
                    otherKindMatches: 0,
                    literalDimensionAvailable: false,
                    truncated: false,
                    itemsTotal: 0,
                    itemsReturned: 0,
                    itemOffset: 0,
                    itemsTruncated: false,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }
    );
}

// ============================================================
// Helper functions
// ============================================================

/**
 * Parse time offset string to Unix timestamp
 * Supports: "2h" (hours), "30m" (minutes), "1d" (days), "1w" (weeks), or ISO date string
 */
export function parseTimeOffset(input: string): number | null {
    if (!input) return null;

    // Try relative time format: 2h, 30m, 1d, 1w
    const match = input.match(/^(\d+)([mhdw])$/i);
    if (match) {
        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        const now = Date.now();

        switch (unit) {
            case 'm': return now - value * 60 * 1000;           // minutes
            case 'h': return now - value * 60 * 60 * 1000;      // hours
            case 'd': return now - value * 24 * 60 * 60 * 1000; // days
            case 'w': return now - value * 7 * 24 * 60 * 60 * 1000; // weeks
        }
    }

    // Try ISO date string
    const date = new Date(input);
    if (!isNaN(date.getTime())) {
        return date.getTime();
    }

    return null;
}

