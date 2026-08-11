/**
 * Trigram prefilter equivalence + fallback tests -- spec_e1328cd0, roadmap b27f5663.
 *
 * Lot B adds a trigram prefilter to Queries#searchItems/countItems for
 * `contains` mode (src/db/queries.ts). The hard acceptance bar is STRICT
 * equivalence with the pre-existing full LIKE scan: same total count, same
 * row order, same paginated slice, in every case (prefilter fired or not).
 *
 * Part A reuses the same pinned-commit git-archive harness as
 * query-corpus.test.js to get a realistic index, then for every contains-mode
 * query in the shared fixture, compares the real (prefiltered) path against
 * the full-scan path forced by monkey-patching the instance's private
 * trigramCandidates to always return null (this is plain JS against the
 * compiled build/ output, so overriding an instance method some TS source
 * marks `private` is just a normal property assignment at runtime).
 *
 * Part B measures wall-clock time for both paths on the same real index, to
 * back the "before/after on a real station index" requirement.
 *
 * Part C exercises the two documented fallback triggers (needle < 3 chars,
 * needle whose rarest trigram exceeds TRIGRAM_GUARD_FRAC of the corpus) plus
 * the "trigram present but zero-candidate" non-fallback case, against a small
 * synthetic index built directly through Queries so the corpus doesn't need
 * to happen to contain a case that crosses the 10% guard.
 */

import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { jest, describe, test, beforeAll, afterAll, expect } from '@jest/globals';
import { init } from '../build/commands/init.js';
import { openDatabase, createDatabase, createQueries } from '../build/db/index.js';
import { isNativeAbiMismatch, nodeAbiGuardMessage } from './helpers/node-interpreter-guard.js';

jest.setTimeout(120000);

const REPO_ROOT = process.cwd();
const CORPUS_PATH = join(REPO_ROOT, 'tests/fixtures/query-corpus.json');
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8'));
const { pinnedCommit } = corpus.meta;
const containsQueries = corpus.queries.filter(e => e.family === 'contains');

/** Force the full-scan path on a Queries instance for one call, then restore. */
function withForcedFullScan(queries, fn) {
    const real = queries.trigramCandidates;
    queries.trigramCandidates = () => null;
    try {
        return fn();
    } finally {
        queries.trigramCandidates = real;
    }
}

describe('trigram prefilter (spec_e1328cd0)', () => {
    let dir;
    let db;
    let queries;
    const perf = [];

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'aidex-trigram-prefilter-'));

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
            db = openDatabase(join(dir, '.aidex', 'index.db'), true);
            queries = createQueries(db);
        }).catch((err) => {
            if (isNativeAbiMismatch(err)) throw new Error(nodeAbiGuardMessage(err));
            throw err;
        });
    }, 120000);

    afterAll(() => {
        if (perf.length) {
            console.log('\n[trigram prefilter] before/after timing, pinned commit ' + pinnedCommit);
            console.table(perf);
        }
        if (db) db.close();
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    // --------------------------------------------------------
    // Part A: strict equivalence, real corpus
    // --------------------------------------------------------

    for (const entry of containsQueries) {
        test(`equivalence: ${entry.id} "${entry.query}"`, () => {
            const term = entry.query;
            const mode = 'contains';

            const realCount = queries.countItems(term, mode);
            const fullCount = withForcedFullScan(queries, () => queries.countItems(term, mode));
            expect(realCount).toBe(fullCount);

            // A handful of windows: from the top, and a couple of offsets, so
            // pagination (item_offset/item_limit, commit 4d2db60) is covered,
            // not just the unpaginated full result.
            const windows = [
                { limit: 1_000_000, offset: 0 },
                { limit: 5, offset: 0 },
                { limit: 5, offset: 3 },
                { limit: 1, offset: Math.max(0, realCount - 1) },
            ];
            for (const w of windows) {
                const realRows = queries.searchItems(term, mode, w.limit, w.offset);
                const fullRows = withForcedFullScan(queries, () => queries.searchItems(term, mode, w.limit, w.offset));
                expect(realRows).toEqual(fullRows);
            }
        });
    }

    // --------------------------------------------------------
    // Part B: before/after timing on the real index
    // --------------------------------------------------------

    test('performance: prefiltered vs full scan on a real index', () => {
        const REPEATS = 20;
        for (const entry of containsQueries) {
            const term = entry.query;
            const mode = 'contains';

            const t0 = Date.now();
            for (let i = 0; i < REPEATS; i++) queries.searchItems(term, mode, 1_000_000, 0);
            const prefilteredMs = Date.now() - t0;

            const t1 = Date.now();
            for (let i = 0; i < REPEATS; i++) withForcedFullScan(queries, () => queries.searchItems(term, mode, 1_000_000, 0));
            const fullScanMs = Date.now() - t1;

            perf.push({
                query: entry.query,
                repeats: REPEATS,
                prefilteredMs,
                fullScanMs,
                deltaMs: fullScanMs - prefilteredMs,
            });
        }
        expect(perf.length).toBe(containsQueries.length);
    });

    // --------------------------------------------------------
    // Part C: fallback cases, synthetic index (full control over guard_frac)
    // --------------------------------------------------------

    describe('fallback cases (synthetic index)', () => {
        let synthDir;
        let synthDb;
        let synthQueries;

        beforeAll(() => {
            synthDir = mkdtempSync(join(tmpdir(), 'aidex-trigram-synth-'));
            synthDb = createDatabase(join(synthDir, 'synth.db'), 'synth', synthDir);
            synthQueries = createQueries(synthDb);

            // 20 items: 1 is "commonneedle" (contains a trigram we'll query),
            // 18 others also contain "needle" so the trigram "eed" (from
            // "needle") sits in >10% of a 20-item corpus -- guard should reject.
            synthQueries.insertItem('uniqueTargetAbc');
            for (let i = 0; i < 18; i++) synthQueries.insertItem(`commonNeedleVariant${i}`);
            synthQueries.insertItem('unrelatedTermXyz');
        });

        afterAll(() => {
            if (synthDb) synthDb.close();
            if (synthDir) rmSync(synthDir, { recursive: true, force: true });
        });

        test('needle shorter than 3 chars falls back to full scan (identical result)', () => {
            const term = 'ab'; // 2 chars, not trigrammable
            const real = synthQueries.searchItems(term, 'contains', 1000, 0);
            const forced = withForcedFullScan(synthQueries, () => synthQueries.searchItems(term, 'contains', 1000, 0));
            expect(real).toEqual(forced);
            // Directly assert the guard signals fallback (null), not just that
            // results happen to agree.
            expect(synthQueries.trigramCandidates(term)).toBeNull();
        });

        test('needle whose rarest trigram exceeds guard_frac falls back to full scan', () => {
            // "eed" occurs in all 18 "commonNeedleVariant*" items out of 20
            // total items (90% >> 10% guard_frac) -- must fall back.
            const term = 'eed';
            expect(synthQueries.trigramCandidates(term)).toBeNull();
            const real = synthQueries.searchItems(term, 'contains', 1000, 0);
            const forced = withForcedFullScan(synthQueries, () => synthQueries.searchItems(term, 'contains', 1000, 0));
            expect(real).toEqual(forced);
            expect(real.length).toBe(18);
        });

        test('selective needle uses the prefilter and matches the full scan exactly', () => {
            const term = 'uniqueTarget';
            const candidates = synthQueries.trigramCandidates(term);
            expect(candidates).not.toBeNull(); // guard passed: prefilter actually fires
            const real = synthQueries.searchItems(term, 'contains', 1000, 0);
            const forced = withForcedFullScan(synthQueries, () => synthQueries.searchItems(term, 'contains', 1000, 0));
            expect(real).toEqual(forced);
            expect(real.length).toBe(1);
            expect(real[0].term).toBe('uniqueTargetAbc');
        });

        test('needle absent from the index: definite zero, not a fallback', () => {
            const term = 'zzzqqqxxx';
            const candidates = synthQueries.trigramCandidates(term);
            expect(candidates).not.toBeNull(); // NOT a fallback: a real (empty) candidate set
            expect(candidates.size).toBe(0);
            const real = synthQueries.searchItems(term, 'contains', 1000, 0);
            expect(real).toEqual([]);
        });

        test('items-table mutation invalidates the cached trigram index', () => {
            const before = synthQueries.searchItems('freshterm', 'contains', 1000, 0);
            expect(before).toEqual([]);
            synthQueries.insertItem('freshTermJustAdded');
            const after = synthQueries.searchItems('freshterm', 'contains', 1000, 0);
            expect(after.length).toBe(1);
            expect(after[0].term).toBe('freshTermJustAdded');
        });
    });
});
