/**
 * Contract test for the `update` CLI's --verbose stdout/stderr shape -- spec_a745959c.
 *
 * WHY THIS EXISTS
 * `hooks/claude/aidex-queue-drain.py` (a Stop hook, out of scope here) keeps a
 * queue of files to reindex. It re-tries a file only if the previous reindex
 * batch failed. It CANNOT use the CLI's process exit code for that, because
 * src/index.ts's `update` branch forces `process.exitCode = 0` unconditionally
 * BY DESIGN (so a git hook never fails a commit over an indexing problem).
 * Detection goes entirely through the TEXT of the --verbose summary line on
 * STDOUT: `Done. Updated: N, Removed: N, Skipped: N, Errors: N`.
 *
 * Nothing in the source protects that exact shape. Reformulating it (renaming
 * a counter, moving it to stderr, dropping the Errors field) would silently
 * blind the hook: files stop being retried, are never reindexed again, and
 * nothing visible reports it -- this is the exact incident this suite exists
 * to prevent from recurring. Each assertion below fails with a message naming
 * that hook dependency, not a bare string-equality mismatch, on the doctrine
 * that a test that fails loudly is worth more than a hook that fails quietly.
 *
 * Two short-circuits (documented in tests/cli-update.test.js and
 * .claude/agent-memory/test-engineer/cli_update_contract.md) can make a file
 * "succeed" WITHOUT ever touching the database, and would produce a false
 * green here if not defeated on purpose:
 *   - existsSync() no-op: a file argument that does not exist on disk never
 *     reaches update()/the DB read-write path.
 *   - hash-diff short-circuit in commands/update.ts: a file whose content is
 *     byte-identical to what was indexed returns success without touching the
 *     DB write path.
 * Every case below creates real files, indexes them via a real init(), then
 * MODIFIES their content afterwards before invoking `update`, so the batch
 * actually reaches the database layer.
 *
 * A corrupted index.db can also fail to rebuild SILENTLY on the next init()
 * (no exception, just a stale file left in place). Reusing a directory across
 * cases would then poison the "healthy" case with the "corrupted" case's
 * state. Every case gets its own disposable mkdtempSync project, and the
 * seeding helper hard-aborts (throws, not a soft warning) if the rebuilt
 * index does not visibly contain the expected number of files.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { jest, describe, test, beforeAll, afterAll, expect } from '@jest/globals';
import Database from 'better-sqlite3';

import { init } from '../build/commands/init.js';
import { resolveAidexNode, isNativeAbiMismatch, nodeAbiGuardMessage } from './helpers/node-interpreter-guard.js';

jest.setTimeout(60000);

const REPO_ROOT = process.cwd();
const CLI_ENTRY = join(REPO_ROOT, 'build', 'index.js');
const NODE_BIN = resolveAidexNode();

const HOOK_PATH = 'hooks/claude/aidex-queue-drain.py';

// ============================================================
// Disposable project helpers -- never the AiDex repo's own index.
// ============================================================

const tempDirs = [];

function makeProjectDir() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-cli-summary-'));
    tempDirs.push(dir);
    return dir;
}

function writeProjectFile(projectDir, relPath, content) {
    const abs = join(projectDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    return abs;
}

function dbPathFor(projectDir) {
    return join(projectDir, '.aidex', 'index.db');
}

function countFilesRow(projectDir) {
    const db = new Database(dbPathFor(projectDir), { readonly: true });
    try {
        return db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
    } finally {
        db.close();
    }
}

/**
 * Seeds a FRESH index and hard-aborts (throws) if the rebuild did not
 * visibly succeed -- a corrupted .aidex left over from a prior case, or a
 * silently-failed init(), must never be mistaken for a healthy fixture.
 */
async function hardSeedIndex(projectDir, expectedFileCount) {
    rmSync(join(projectDir, '.aidex'), { recursive: true, force: true });
    const res = await init({ path: projectDir });
    if (!res.success) {
        throw new Error(`hardSeedIndex: init() reported failure for ${projectDir}: ${JSON.stringify(res)}`);
    }
    if (!existsSync(dbPathFor(projectDir))) {
        throw new Error(`hardSeedIndex: index.db does not exist after init() at ${projectDir} -- fixture is not usable.`);
    }
    const actual = countFilesRow(projectDir);
    if (actual !== expectedFileCount) {
        throw new Error(
            `hardSeedIndex: expected ${expectedFileCount} rows in files table after init(), got ${actual} at ${projectDir} -- ` +
            `fixture did not rebuild as expected, aborting before this poisons the test case.`
        );
    }
}

/** Runs `node build/index.js update <projectDir> --verbose <fileArgs...>` as a real child process. */
function runUpdateCli(projectDir, fileArgs) {
    const result = spawnSync(NODE_BIN, [CLI_ENTRY, 'update', projectDir, '--verbose', ...fileArgs], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
    });
    if (result.error && isNativeAbiMismatch(result.error)) {
        throw new Error(nodeAbiGuardMessage(result.error));
    }
    return result;
}

const SAMPLE_TS = (label) => `export function ${label}() {\n    return "${label}";\n}\n`;
const SAMPLE_TS_V2 = (label) => `export function ${label}() {\n    return "${label}-modified";\n}\n`;

afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ============================================================
// Contract assertion helpers -- every failure message names the hook
// dependency it protects, per the team-lead's explicit requirement.
// ============================================================

const SUMMARY_LINE_RE = /^Done\. Updated: (\d+), Removed: (\d+), Skipped: (\d+), Errors: (\d+)$/m;

function assertSummaryLineShape(stdout) {
    const match = stdout.match(SUMMARY_LINE_RE);
    if (!match) {
        throw new Error(
            `${HOOK_PATH} parses a stdout line shaped exactly ` +
            `"Done. Updated: N, Removed: N, Skipped: N, Errors: N" to decide whether to keep a file queued. ` +
            `No such line was found on stdout. Got stdout:\n${stdout}`
        );
    }
    return { updated: Number(match[1]), removed: Number(match[2]), skipped: Number(match[3]), errors: Number(match[4]) };
}

function assertErrorsCount(stdout, expected) {
    const { errors } = assertSummaryLineShape(stdout);
    if (errors !== expected) {
        throw new Error(
            `${HOOK_PATH} reads the "Errors: N" counter on the summary line to decide whether the batch failed ` +
            `(it cannot use the process exit code, which this CLI forces to 0 unconditionally). ` +
            `Expected Errors: ${expected}, got Errors: ${errors}. Full stdout:\n${stdout}`
        );
    }
}

function assertExitCodeZero(status) {
    if (status !== 0) {
        throw new Error(
            `The update branch is documented (src/index.ts) to force process.exitCode = 0 unconditionally, ` +
            `specifically so a git hook never fails a commit over an indexing problem. ` +
            `${HOOK_PATH} therefore does NOT check the exit code at all -- if this ever stops being 0, ` +
            `the git hook chain this CLI is invoked from would start failing commits/merges/checkouts station-wide. ` +
            `Got exit code ${status}.`
        );
    }
}

function assertStdoutHasNoPerFileErrorLines(stdout) {
    if (/^error: /m.test(stdout)) {
        throw new Error(
            `${HOOK_PATH} parses ONLY stdout for the summary line and never reads per-file detail lines from it. ` +
            `A per-file "error: <file>: <message>" line leaked onto stdout, which the hook's stdout-only parser ` +
            `was never written to filter out and could misinterpret. Got stdout:\n${stdout}`
        );
    }
}

function assertStderrHasPerFileErrorLine(stderr, relFile) {
    const re = new RegExp(`^error: ${relFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .+$`, 'm');
    if (!re.test(stderr)) {
        throw new Error(
            `Per-file failure detail for "${relFile}" is expected on stderr (src/index.ts's per-file catch paths), ` +
            `since ${HOOK_PATH} reads only the stdout summary line and relies on stderr being where the ` +
            `human-readable diagnostic for a specific failing file lives. Got stderr:\n${stderr}`
        );
    }
}

// ============================================================
// Case A: healthy batch -- Errors: 0, exit 0, no per-file noise anywhere.
// ============================================================

describe('healthy batch: summary line shape the hook depends on', () => {
    test('Errors: 0, exit 0, no per-file detail lines on stdout or stderr', async () => {
        const dir = makeProjectDir();
        writeProjectFile(dir, 'alpha.ts', SAMPLE_TS('alpha'));
        writeProjectFile(dir, 'beta.ts', SAMPLE_TS('beta'));
        await hardSeedIndex(dir, 2);

        // Modify content AFTER indexing so the hash-diff short-circuit in
        // commands/update.ts cannot turn this into a DB-untouched no-op.
        writeProjectFile(dir, 'alpha.ts', SAMPLE_TS_V2('alpha'));
        writeProjectFile(dir, 'beta.ts', SAMPLE_TS_V2('beta'));

        const res = runUpdateCli(dir, ['alpha.ts', 'beta.ts']);

        assertExitCodeZero(res.status);
        assertErrorsCount(res.stdout, 0);
        const { updated } = assertSummaryLineShape(res.stdout);
        expect(updated).toBe(2);
        assertStdoutHasNoPerFileErrorLines(res.stdout);

        if (res.stderr.length !== 0) {
            throw new Error(
                `A healthy batch produced non-empty stderr; ${HOOK_PATH} does not read stderr at all for its ` +
                `pass/fail decision but a human operator watching a hook run would see unexplained noise on a ` +
                `success. Got stderr:\n${res.stderr}`
            );
        }
    });
});

// ============================================================
// Case B: failing batch -- Errors: N > 0, exit STILL 0, per-file detail on
// stderr only. This is the scenario the hook exists to detect.
// ============================================================

describe('failing batch: summary line still reports the failure with exit 0', () => {
    test('corrupted index.db: Errors: 2, exit 0, per-file detail on stderr not stdout', async () => {
        const dir = makeProjectDir();
        writeProjectFile(dir, 'gamma.ts', SAMPLE_TS('gamma'));
        writeProjectFile(dir, 'delta.ts', SAMPLE_TS('delta'));
        await hardSeedIndex(dir, 2);

        // Modify content AFTER indexing (same short-circuit defeat as case A).
        writeProjectFile(dir, 'gamma.ts', SAMPLE_TS_V2('gamma'));
        writeProjectFile(dir, 'delta.ts', SAMPLE_TS_V2('delta'));

        // Simplest proven failure scenario: replace index.db with a plain
        // text file. validateIndex() only checks existsSync, so this still
        // passes the "no index -> no-op" gate and reaches the per-file loop,
        // where opening the DB throws for every file.
        writeFileSync(dbPathFor(dir), 'not a real sqlite database file at all');

        const res = runUpdateCli(dir, ['gamma.ts', 'delta.ts']);

        assertExitCodeZero(res.status);
        assertErrorsCount(res.stdout, 2);
        assertStdoutHasNoPerFileErrorLines(res.stdout);
        assertStderrHasPerFileErrorLine(res.stderr, 'gamma.ts');
        assertStderrHasPerFileErrorLine(res.stderr, 'delta.ts');

        // Measured, not guessed: the underlying better-sqlite3 error for a
        // non-sqlite file is SQLITE_NOTADB / "file is not a database",
        // surfaced verbatim by src/index.ts's outer per-file catch block.
        if (!/file is not a database/.test(res.stderr)) {
            throw new Error(
                `Expected the per-file stderr detail to include the underlying "file is not a database" message ` +
                `(measured directly against better-sqlite3 for a corrupted index.db). If this message text changed, ` +
                `it is not itself a hook-breaking change (the hook only reads the stdout summary line), but it means ` +
                `this test's failure fixture no longer represents the scenario it claims to. Got stderr:\n${res.stderr}`
            );
        }
    });
});
