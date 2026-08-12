/**
 * Whitespace-tolerance differential -- spec_90f49672, dispatched against
 * commit 34532c8 (card f08aeeb1).
 *
 * WHY THIS EXISTS
 * f08aeeb1 shipped two halves. The multi-word-literal-indexing half is proven
 * by tests/query-corpus.test.js's `multiword` family (10 real corpus queries,
 * 0 -> 1 result). The whitespace-TOLERANCE half -- a query whose spacing
 * differs from the source literal's spacing still matches -- was never
 * exercised: the developer's claim that it is "structurally guaranteed"
 * because `normalizeLiteralWhitespace` is a single shared function
 * (src/coverage/rule.ts, called from src/parser/extractor.ts at index time
 * and src/db/queries.ts at query time) is a DEDUCTION from reading the code,
 * not a measurement. This file is the measurement.
 *
 * Mirrors tests/coverage-oracle.test.js's fixture-and-init pattern: a throwaway
 * temp project, `init()` from build/, `query()` against it. Does not touch
 * tests/fixtures/query-corpus.json (the pinned reference corpus) -- this is an
 * independent fixture built fresh per run.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { init } from '../build/commands/init.js';
import { query } from '../build/commands/query.js';
import { isNativeAbiMismatch, nodeAbiGuardMessage } from './helpers/node-interpreter-guard.js';

// ============================================================
// Fixture
//
// Every literal below is mixed-case (upper + lower), which lands
// `literalRule: 'above'` in classifyPattern -- indexed unconditionally,
// regardless of syntactic position. That keeps this fixture's positive cases
// independent of the separate 'below'/position rule already covered by
// coverage-oracle.test.js, isolating exactly what's under test here:
// whitespace tolerance.
// ============================================================

const RESTART_LINE = "export const RESTART_MSG = 'Please Restart the Service';";
const WRAPPED_DECL = 'export const WRAPPED_MSG = `Deploy Blocked\n    Retry Later`;';
const FOO_BAR_LINE = "export const FOO_BAR = 'Foo Bar';";
const FOO_BAR_ALT_LINE = "export const FOO_BAR_ALT = 'FooBar';";

const SOURCE = [
    '',
    RESTART_LINE,
    '',
    WRAPPED_DECL,
    '',
    FOO_BAR_LINE,
    FOO_BAR_ALT_LINE,
    '',
].join('\n');

/** 1-based line number of the first line containing `needle`. */
function lineOf(source, needle) {
    const lines = source.split('\n');
    const idx = lines.findIndex(l => l.includes(needle));
    if (idx === -1) throw new Error(`fixture line not found: ${needle}`);
    return idx + 1;
}

const REL_PATH = 'src/messages.ts';
const RESTART_LINE_NO = lineOf(SOURCE, "RESTART_MSG = 'Please Restart the Service'");
const WRAPPED_LINE_NO = lineOf(SOURCE, 'WRAPPED_MSG = `Deploy Blocked');
const FOO_BAR_LINE_NO = lineOf(SOURCE, "FOO_BAR = 'Foo Bar'");
const FOO_BAR_ALT_LINE_NO = lineOf(SOURCE, "FOO_BAR_ALT = 'FooBar'");

function createFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-ws-tolerance-'));
    const abs = join(dir, REL_PATH);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, SOURCE, 'utf-8');
    return dir;
}

function hasTarget(result, lineNumber) {
    return result.matches.some(m => m.file === REL_PATH && m.lineNumber === lineNumber);
}

const MODES = ['exact', 'contains', 'starts_with'];

// ============================================================
// Harness
// ============================================================

describe('whitespace tolerance for multi-word literals (f08aeeb1, spec_90f49672)', () => {
    let dir;

    beforeAll(async () => {
        dir = createFixture();
        try {
            const result = await init({ path: dir });
            expect(result.success).toBe(true);
        } catch (err) {
            if (isNativeAbiMismatch(err)) throw new Error(nodeAbiGuardMessage(err));
            throw err;
        }
    });

    afterAll(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    // --------------------------------------------------------
    // 1-4: query whitespace differs from source whitespace, declined on all
    // three modes that share itemMatchClause/itemMatchParam (src/db/queries.ts).
    // --------------------------------------------------------

    const scenarios = [
        {
            id: 'double-space query vs single-space source',
            term: 'Please  Restart  the  Service',
            lineNo: () => RESTART_LINE_NO,
        },
        {
            id: 'tab query vs space source',
            term: 'Please\tRestart\tthe\tService',
            lineNo: () => RESTART_LINE_NO,
        },
        {
            id: 'single-space query vs multi-line indented source',
            term: 'Deploy Blocked Retry Later',
            lineNo: () => WRAPPED_LINE_NO,
        },
        {
            id: 'leading/trailing whitespace in query',
            term: '   Please Restart the Service   ',
            lineNo: () => RESTART_LINE_NO,
        },
    ];

    for (const scenario of scenarios) {
        for (const mode of MODES) {
            test(`${scenario.id} [${mode}]`, () => {
                const result = query({ path: dir, term: scenario.term, mode, kinds: ['literal'] });
                expect(result.success).toBe(true);
                expect(hasTarget(result, scenario.lineNo())).toBe(true);
            });
        }
    }

    // --------------------------------------------------------
    // Mode-specific: a PARTIAL match (not the whole normalized string) with
    // whitespace drift, so contains/starts_with are proven on their own
    // semantics rather than piggy-backing on full-string equality above.
    // --------------------------------------------------------

    test('contains: double-space partial substring matches single-space source', () => {
        const result = query({ path: dir, term: 'Restart  the', mode: 'contains', kinds: ['literal'] });
        expect(result.success).toBe(true);
        expect(hasTarget(result, RESTART_LINE_NO)).toBe(true);
    });

    test('starts_with: tab-separated prefix matches single-space source', () => {
        const result = query({ path: dir, term: 'Please\tRestart', mode: 'starts_with', kinds: ['literal'] });
        expect(result.success).toBe(true);
        expect(hasTarget(result, RESTART_LINE_NO)).toBe(true);
    });

    // --------------------------------------------------------
    // Guard rail: collapsing whitespace runs must not collapse DISTINCT terms
    // into each other. 'Foo Bar' (one space) and 'FooBar' (no space) sit on
    // separate lines in the fixture; normalizeLiteralWhitespace collapses runs
    // of whitespace, it does not strip single spaces, so these must stay
    // distinguishable in every mode.
    // --------------------------------------------------------

    for (const mode of MODES) {
        test(`guard: 'FooBar' query does not match the 'Foo Bar' line [${mode}]`, () => {
            const result = query({ path: dir, term: 'FooBar', mode, kinds: ['literal'] });
            expect(result.success).toBe(true);
            expect(hasTarget(result, FOO_BAR_ALT_LINE_NO)).toBe(true);
            expect(hasTarget(result, FOO_BAR_LINE_NO)).toBe(false);
        });

        test(`guard: 'Foo Bar' query does not match the 'FooBar' line [${mode}]`, () => {
            const result = query({ path: dir, term: 'Foo Bar', mode, kinds: ['literal'] });
            expect(result.success).toBe(true);
            expect(hasTarget(result, FOO_BAR_LINE_NO)).toBe(true);
            expect(hasTarget(result, FOO_BAR_ALT_LINE_NO)).toBe(false);
        });
    }
});
