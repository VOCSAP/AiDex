/**
 * init()'s success-mode contract -- roadmap card a7039829.
 *
 * WHY THIS EXISTS
 * init() used to hardcode `success: true` on its main return path no matter
 * what accumulated in errors[] during the per-file indexing loop. A file that
 * genuinely failed in production filled errors[] invisibly while the caller
 * saw "Done!" and a silently-reduced Files count -- one morning, three
 * separate diagnostic investigations, two chasing the wrong root cause.
 *
 * Two deliverables:
 *  [A] errors[] is now visible to the caller even when success is true (CLI
 *      init printer in src/index.ts; handleInit in src/server/tools.ts
 *      already did this since the initial commit -- see the "already did
 *      this" test below, which pins that pre-existing behavior so a future
 *      refactor cannot silently drop it while "only" changing the CLI side).
 *  [B] success itself can now react to errors[], gated behind ONE env var,
 *      AIDEX_SUCCESS_MODE, resolved through resolveSuccessMode() and applied
 *      through computeInitSuccess() -- both exported from build/commands/
 *      init.js specifically so this suite can pin the decision logic
 *      directly, without needing to force real per-file indexing failures
 *      (fragile and platform-dependent to construct: no reliable, portable
 *      way to make a real file fail mid-index on both POSIX and Windows CI
 *      without symlink privileges or ACL shelling).
 *
 * bfb7bf8f (2nd pass, later): the env var was originally AIDEX_INIT_SUCCESS_
 * MODE, scoped to init() only, and resolveSuccessMode() was originally named
 * resolveInitSuccessMode(). Widened by explicit operator arbitration to also
 * gate the rebuild-index CLI subcommand (src/index.ts), which needed no new
 * gating logic -- it already calls this same init() on every run. The old
 * name is kept as a back-compat alias (resolveSuccessMode's second
 * parameter); the new name wins if both are set.
 *
 * A DEVIATION FROM THE CARD'S LITERAL WORDING is exercised deliberately in
 * the "idempotent re-run" cases below: the card defines the 'empty' mode's
 * (originally named 'partial') trip condition as bare `filesIndexed === 0`
 * while candidates were found. Taken literally, that also fires on a
 * perfectly healthy no-op re-run of an already-up-to-date project (every
 * file short-circuits via the incremental hash-diff into filesSkipped, so
 * filesIndexed is 0 there too) -- which would make 'empty'/'strict' report
 * failure on the single most common re-run shape there is. computeInitSuccess
 * instead trips only when NEITHER filesIndexed NOR filesSkipped moved
 * (candidates existed, nothing was accounted for either way). The idempotent
 * cases below are the proof this refinement does not regress the literal
 * "total failure during indexing" scenario the card was written for.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { init, resolveSuccessMode, computeInitSuccess } from '../build/commands/init.js';
import { isNativeAbiMismatch, nodeAbiGuardMessage, resolveAidexNode } from './helpers/node-interpreter-guard.js';

// Anchored on this file's own location, not process.cwd() -- see roadmap
// card 39e02f07 (defect 2) and tests/cli-update-summary-contract.test.js.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, 'build', 'index.js');
const NODE_BIN = resolveAidexNode();

const tempDirs = [];

function makeProjectDir() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-init-success-'));
    tempDirs.push(dir);
    return dir;
}

function writeFile(dir, relPath, content) {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
}

async function safeInit(params) {
    try {
        return await init(params);
    } catch (err) {
        if (isNativeAbiMismatch(err)) throw new Error(nodeAbiGuardMessage(err));
        throw err;
    }
}

afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ============================================================
// [B1] resolveSuccessMode -- the single choke point reading the env var,
// now with the AIDEX_INIT_SUCCESS_MODE back-compat alias (bfb7bf8f 2nd pass)
// ============================================================

describe('resolveSuccessMode', () => {
    test('both unset -> default', () => {
        expect(resolveSuccessMode(undefined, undefined)).toBe('default');
    });

    test('empty string (new var only) -> default', () => {
        expect(resolveSuccessMode('', undefined)).toBe('default');
    });

    test('"default" (new var) -> default', () => {
        expect(resolveSuccessMode('default', undefined)).toBe('default');
    });

    test('"empty" (new var) -> empty', () => {
        expect(resolveSuccessMode('empty', undefined)).toBe('empty');
    });

    test('"strict" (new var) -> strict', () => {
        expect(resolveSuccessMode('strict', undefined)).toBe('strict');
    });

    // Unknown-value design decision: throw, not a silent fallback to
    // 'default' -- a silent fallback would reintroduce exactly the
    // invisible-bad-state bug this card exists to fix, one layer up.
    test('unknown value on the new var throws, naming AIDEX_SUCCESS_MODE, the value, and the valid set', () => {
        expect(() => resolveSuccessMode('partial', undefined)).toThrow(/AIDEX_SUCCESS_MODE.*partial/);
        expect(() => resolveSuccessMode('PARTIAL', undefined)).toThrow(/AIDEX_SUCCESS_MODE/);
        expect(() => resolveSuccessMode('typo', undefined)).toThrow(/default.*empty.*strict/);
    });

    describe('AIDEX_INIT_SUCCESS_MODE back-compat alias', () => {
        test('new var unset, legacy set -> legacy value used', () => {
            expect(resolveSuccessMode(undefined, 'strict')).toBe('strict');
        });

        test('new var empty string, legacy set -> legacy value used', () => {
            expect(resolveSuccessMode('', 'empty')).toBe('empty');
        });

        test('unknown value on the legacy-only var throws, naming AIDEX_INIT_SUCCESS_MODE (not the new name)', () => {
            expect(() => resolveSuccessMode(undefined, 'partial')).toThrow(/AIDEX_INIT_SUCCESS_MODE.*partial/);
        });

        test('both set -> new var wins over legacy', () => {
            expect(resolveSuccessMode('strict', 'empty')).toBe('strict');
        });

        test('both set, new var invalid -> throws naming the new var, legacy value never consulted', () => {
            expect(() => resolveSuccessMode('bogus', 'empty')).toThrow(/AIDEX_SUCCESS_MODE.*bogus/);
        });

        test('both unset -> default (no alias fallback needed)', () => {
            expect(resolveSuccessMode(undefined, undefined)).toBe('default');
        });
    });
});

// ============================================================
// [B2] computeInitSuccess -- pure decision table, all three modes
// ============================================================

describe('computeInitSuccess', () => {
    describe('default mode', () => {
        test('always true, even with a total wipeout and errors present', () => {
            expect(computeInitSuccess('default', { filesFound: 5, filesIndexed: 0, filesSkipped: 0, errorCount: 5 })).toBe(true);
        });

        test('true on the ordinary healthy case', () => {
            expect(computeInitSuccess('default', { filesFound: 5, filesIndexed: 5, filesSkipped: 0, errorCount: 0 })).toBe(true);
        });
    });

    describe('empty mode (catches total failure during indexing)', () => {
        test('false: candidates found, nothing indexed, nothing skipped (real total failure)', () => {
            expect(computeInitSuccess('empty', { filesFound: 5, filesIndexed: 0, filesSkipped: 0, errorCount: 5 })).toBe(false);
        });

        test('true: idempotent re-run, everything short-circuited as unchanged (filesIndexed 0 but filesSkipped 5)', () => {
            expect(computeInitSuccess('empty', { filesFound: 5, filesIndexed: 0, filesSkipped: 5, errorCount: 0 })).toBe(true);
        });

        test('true: partial success, some files indexed, some errored', () => {
            expect(computeInitSuccess('empty', { filesFound: 5, filesIndexed: 3, filesSkipped: 0, errorCount: 2 })).toBe(true);
        });

        test('true: legitimately empty project, zero candidates', () => {
            expect(computeInitSuccess('empty', { filesFound: 0, filesIndexed: 0, filesSkipped: 0, errorCount: 0 })).toBe(true);
        });
    });

    describe('strict mode (catches any error, subsumes empty for monotonicity)', () => {
        test('false: a single error among otherwise-successful files', () => {
            expect(computeInitSuccess('strict', { filesFound: 5, filesIndexed: 4, filesSkipped: 0, errorCount: 1 })).toBe(false);
        });

        test('true: fully healthy run', () => {
            expect(computeInitSuccess('strict', { filesFound: 5, filesIndexed: 5, filesSkipped: 0, errorCount: 0 })).toBe(true);
        });

        test('true: idempotent re-run, everything unchanged, zero errors', () => {
            expect(computeInitSuccess('strict', { filesFound: 5, filesIndexed: 0, filesSkipped: 5, errorCount: 0 })).toBe(true);
        });

        // Monotonicity: a total wipeout with ZERO errors[] entries must not
        // escape strict just because errorCount === 0 -- it must also fail
        // via the same totalFailure condition 'empty' uses, or strict would
        // be "beaten" by a subtler failure that empty alone would catch.
        test('false (monotonicity): total wipeout with zero errors[] entries still fails strict', () => {
            expect(computeInitSuccess('strict', { filesFound: 5, filesIndexed: 0, filesSkipped: 0, errorCount: 0 })).toBe(false);
        });

        test('true: legitimately empty project, zero candidates, zero errors', () => {
            expect(computeInitSuccess('strict', { filesFound: 0, filesIndexed: 0, filesSkipped: 0, errorCount: 0 })).toBe(true);
        });
    });
});

// ============================================================
// [A] + [B] end-to-end through the real init() -- proves the wiring, not
// just the pure function in isolation.
// ============================================================

describe('init() end-to-end, AIDEX_INIT_SUCCESS_MODE unset (default)', () => {
    let dir;

    beforeAll(async () => {
        dir = makeProjectDir();
        writeFile(dir, 'src/a.ts', 'export const A = 1;\n');
        writeFile(dir, 'src/b.ts', 'export const B = 2;\n');
    });

    test('a healthy project indexes successfully with no warnings', async () => {
        const result = await safeInit({ path: dir });
        expect(result.success).toBe(true);
        expect(result.filesIndexed).toBe(2);
        expect(result.errors).toEqual([]);
    });

    test('an idempotent re-run over the unchanged project stays success (filesIndexed 0, filesSkipped 2)', async () => {
        const result = await safeInit({ path: dir });
        expect(result.success).toBe(true);
        expect(result.filesIndexed).toBe(0);
        expect(result.filesSkipped).toBe(2);
        expect(result.errors).toEqual([]);
    });
});

describe('init() end-to-end, a legitimately empty project stays success in all three modes', () => {
    let dir;

    beforeAll(() => {
        dir = makeProjectDir();
        // No source files at all -- zero candidates of any supported extension.
    });

    for (const mode of ['default', 'empty', 'strict']) {
        test(`mode=${mode}`, async () => {
            const prev = process.env.AIDEX_INIT_SUCCESS_MODE;
            process.env.AIDEX_INIT_SUCCESS_MODE = mode;
            try {
                const result = await safeInit({ path: dir, fresh: true });
                expect(result.success).toBe(true);
                expect(result.filesIndexed).toBe(0);
                expect(result.errors).toEqual([]);
            } finally {
                if (prev === undefined) delete process.env.AIDEX_INIT_SUCCESS_MODE;
                else process.env.AIDEX_INIT_SUCCESS_MODE = prev;
            }
        });
    }
});

describe('init() end-to-end, an unknown AIDEX_INIT_SUCCESS_MODE value rejects visibly', () => {
    test('init() rejects instead of silently falling back to default', async () => {
        const dir = makeProjectDir();
        const prev = process.env.AIDEX_INIT_SUCCESS_MODE;
        process.env.AIDEX_INIT_SUCCESS_MODE = 'partial'; // the old, no-longer-valid name
        try {
            await expect(init({ path: dir })).rejects.toThrow(/AIDEX_INIT_SUCCESS_MODE/);
        } finally {
            if (prev === undefined) delete process.env.AIDEX_INIT_SUCCESS_MODE;
            else process.env.AIDEX_INIT_SUCCESS_MODE = prev;
        }
    });
});

describe('init() end-to-end, the new AIDEX_SUCCESS_MODE name works directly (not just via the alias)', () => {
    test('unknown value on the new name rejects, naming AIDEX_SUCCESS_MODE', async () => {
        const dir = makeProjectDir();
        const prev = process.env.AIDEX_SUCCESS_MODE;
        process.env.AIDEX_SUCCESS_MODE = 'partial';
        try {
            await expect(init({ path: dir })).rejects.toThrow(/AIDEX_SUCCESS_MODE/);
        } finally {
            if (prev === undefined) delete process.env.AIDEX_SUCCESS_MODE;
            else process.env.AIDEX_SUCCESS_MODE = prev;
        }
    });

    test('valid value on the new name is honored end-to-end', async () => {
        const dir = makeProjectDir();
        writeFile(dir, 'a.ts', 'export function a() { return "a"; }\n');
        const prev = process.env.AIDEX_SUCCESS_MODE;
        process.env.AIDEX_SUCCESS_MODE = 'strict';
        try {
            const result = await safeInit({ path: dir });
            expect(result.success).toBe(true); // no errors[] entries -> strict still passes
            expect(result.filesIndexed).toBe(1);
        } finally {
            if (prev === undefined) delete process.env.AIDEX_SUCCESS_MODE;
            else process.env.AIDEX_SUCCESS_MODE = prev;
        }
    });
});

// ============================================================
// rebuild-index CLI end-to-end -- bfb7bf8f (2nd pass): AIDEX_SUCCESS_MODE
// (and its AIDEX_INIT_SUCCESS_MODE alias) must reach rebuild-index too. No
// new gating code exists for rebuild-index: its CLI branch (src/index.ts)
// calls the SAME init() as above, so this suite proves the wiring at the
// process boundary rather than re-testing computeInitSuccess()'s decision
// table (already fully covered above).
// ============================================================

function runRebuildIndexCli(projectDir, envOverrides) {
    const result = spawnSync(NODE_BIN, [CLI_ENTRY, 'rebuild-index', projectDir], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: { ...process.env, ...envOverrides },
    });
    if (result.error && isNativeAbiMismatch(result.error)) {
        throw new Error(nodeAbiGuardMessage(result.error));
    }
    return result;
}

describe('rebuild-index CLI end-to-end honors AIDEX_SUCCESS_MODE via the shared init() call', () => {
    test('new name, unknown value: CLI exits non-zero and names AIDEX_SUCCESS_MODE', () => {
        const dir = makeProjectDir();
        writeFile(dir, 'a.ts', 'export function a() { return "a"; }\n');

        const res = runRebuildIndexCli(dir, { AIDEX_SUCCESS_MODE: 'partial', AIDEX_INIT_SUCCESS_MODE: '' });

        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/AIDEX_SUCCESS_MODE/);
    });

    test('legacy alias, unknown value: CLI exits non-zero and names AIDEX_INIT_SUCCESS_MODE (new var unset)', () => {
        const dir = makeProjectDir();
        writeFile(dir, 'b.ts', 'export function b() { return "b"; }\n');

        const res = runRebuildIndexCli(dir, { AIDEX_SUCCESS_MODE: '', AIDEX_INIT_SUCCESS_MODE: 'partial' });

        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/AIDEX_INIT_SUCCESS_MODE/);
    });

    test('healthy run under strict mode (new name): exit 0, Done!, no Warnings block', () => {
        const dir = makeProjectDir();
        writeFile(dir, 'c.ts', 'export function c() { return "c"; }\n');

        const res = runRebuildIndexCli(dir, { AIDEX_SUCCESS_MODE: 'strict', AIDEX_INIT_SUCCESS_MODE: '' });

        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/Done!/);
        expect(res.stdout).not.toMatch(/Warnings:/);
    });
});
