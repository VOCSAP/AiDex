/**
 * printIndexWarnings() -- roadmap card bfb7bf8f, review pass 3.
 *
 * WHY THIS EXISTS
 * The `init` and `rebuild-index` CLI blocks in src/index.ts print a
 * "Warnings" block whenever result.errors.length > 0, even when the run
 * overall reports success:true -- so a partially-successful run can never
 * again hide a genuine per-file failure behind a "Done!" and a silently-
 * reduced Files count (16d8512 for init, extended to rebuild-index in
 * bfb7bf8f). Both call sites were character-for-character identical and are
 * now the same extracted function, src/utils/cli-warnings.ts.
 *
 * Forcing a REAL per-file indexing failure to prove the block prints is
 * fragile and platform-dependent to construct (see the header comment in
 * tests/init-success-modes.test.js for why -- no reliable, portable way to
 * make a real file fail mid-index on both POSIX and Windows CI). Extracting
 * the printer into its own pure function sidesteps that entirely: this suite
 * feeds it a FABRICATED errors[] array directly and asserts on console.log,
 * which is exactly what the roadmap card's acceptance criterion ("a run
 * where some files fail must surface those failures in the output") needs
 * -- proof the block prints, not proof a specific fixture can trigger it.
 *
 * Residual gap, traced not excused: two further fabrication attempts on
 * this machine also failed to produce a real non-empty errors[] entry -- a
 * 3,348,889-byte TypeScript file (past the 1 MB tree-sitter buffer) still
 * reports "Done! / Files: 2 / Items: 60001" with no warning, and a
 * directory named `weird.ts` (EISDIR bait) reports "Done! / Files: 1 /
 * Items: 1" because the scanner never lists it in the first place. So this
 * suite proves the printer prints correctly for a given array; that it is
 * CALLED with the right array from a real failing init()/rebuild-index run
 * remains a code-reading claim (both CLI call sites in src/index.ts, the
 * init and rebuild-index branches, pass `result.errors` straight through),
 * not an executed one.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { printIndexWarnings } from '../build/utils/cli-warnings.js';

let logSpy;

beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
});

function loggedLines() {
    return logSpy.mock.calls.map((args) => args.join(' '));
}

describe('printIndexWarnings', () => {
    test('empty errors[]: prints nothing -- the healthy-run no-regression case', () => {
        printIndexWarnings([]);
        expect(logSpy).not.toHaveBeenCalled();
    });

    test('non-empty errors[]: prints a Warnings header naming the count -- the acceptance criterion this card exists for', () => {
        printIndexWarnings(['src/broken-a.ts: parse error', 'src/broken-b.ts: cannot read file']);

        const lines = loggedLines();
        expect(lines[0]).toBe('  Warnings: 2 file(s) reported errors during indexing');
    });

    test('non-empty errors[]: every entry from the fabricated array appears in the output', () => {
        const errors = ['fileA.ts: boom', 'fileB.ts: kaboom', 'fileC.ts: whoops'];
        printIndexWarnings(errors);

        const output = loggedLines().join('\n');
        for (const e of errors) {
            expect(output).toContain(`    - ${e}`);
        }
    });

    test('exactly 10 errors: all 10 printed, no overflow line', () => {
        const errors = Array.from({ length: 10 }, (_, i) => `file${i}.ts: err`);
        printIndexWarnings(errors);

        const lines = loggedLines();
        // header + 10 detail lines, no overflow line
        expect(lines).toHaveLength(11);
        expect(lines.some((l) => l.includes('more'))).toBe(false);
    });

    test('more than 10 errors: only the first 10 printed plus an overflow count line', () => {
        const errors = Array.from({ length: 13 }, (_, i) => `file${i}.ts: err`);
        printIndexWarnings(errors);

        const lines = loggedLines();
        expect(lines[0]).toBe('  Warnings: 13 file(s) reported errors during indexing');
        // header + first 10 detail lines + 1 overflow line
        expect(lines).toHaveLength(12);
        expect(lines[11]).toBe('    ... and 3 more');
        expect(lines.some((l) => l.includes('file10.ts'))).toBe(false);
    });
});
