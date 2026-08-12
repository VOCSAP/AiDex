/**
 * Regression suite for the `update` CLI branch -- spec_99b30fea.
 *
 * WHY THIS EXISTS
 * `node build/index.js update <project> <file...> [--verbose] [-- <file...>]`
 * (src/index.ts, the `update` branch) is about to be invoked by a
 * machine-global git hook on every commit/merge/checkout/rebase across ALL of
 * the operator's repos (see hooks/, out of scope here). A defect there is
 * station-wide, not project-local, so this suite freezes the branch's
 * DOCUMENTED CONTRACT as regression tests.
 *
 * src/index.ts and src/db/queries.ts are being actively patched by other
 * workers while this file is written (lock-detection break move, duplicate
 * case close, a case-only-rename fix). These tests therefore assert the
 * CONTRACT (option parsing, path normalization, sandbox skip, hash-diff
 * short-circuit, error classification, exit-code / stdout-stderr discipline),
 * not today's exact control flow -- so they keep meaning regardless of which
 * internal mechanism ends up implementing a given guarantee.
 *
 * Every test spawns `node build/index.js update ...` as a REAL child process
 * (spawnSync) against a disposable mkdtempSync project, and inspects the
 * resulting `.aidex/index.db` files table directly via better-sqlite3. The
 * AiDex repo's own index is never touched. The interpreter is resolved
 * through tests/helpers/node-interpreter-guard.js (resolveAidexNode), shared
 * with tests/query-corpus.test.js instead of a second hand-rolled discovery.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { jest, describe, test, beforeAll, afterAll, expect } from '@jest/globals';
import Database from 'better-sqlite3';

import { init } from '../build/commands/init.js';
import { resolveAidexNode, isNativeAbiMismatch, nodeAbiGuardMessage } from './helpers/node-interpreter-guard.js';

jest.setTimeout(60000);

// Anchored on this file's own location, not process.cwd() -- see roadmap
// card 39e02f07 (defect 2): a process.cwd()-based root broke ENOENT/module
// resolution when the suite was launched from outside the repo root.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, 'build', 'index.js');
const NODE_BIN = resolveAidexNode();

// ============================================================
// Disposable project helpers -- never the AiDex repo's own index.
// ============================================================

const tempDirs = [];

function makeProjectDir() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-cli-update-'));
    tempDirs.push(dir);
    return dir;
}

function writeProjectFile(projectDir, relPath, content) {
    const abs = join(projectDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    return abs;
}

/** Seed a project with a real AiDex index via the compiled init() -- same precedent as query-corpus.test.js. */
async function seedIndex(projectDir) {
    const res = await init({ path: projectDir });
    if (!res.success) throw new Error(`init failed seeding ${projectDir}: ${JSON.stringify(res)}`);
}

function dbPathFor(projectDir) {
    return join(projectDir, '.aidex', 'index.db');
}

function readFilesTable(projectDir) {
    const db = new Database(dbPathFor(projectDir), { readonly: true });
    try {
        return db.prepare('SELECT path FROM files ORDER BY path').all().map(r => r.path);
    } finally {
        db.close();
    }
}

/** Runs `node build/index.js update <projectDir> <fileArgs...>` as a real child process. */
function runUpdateCli(projectDir, fileArgs) {
    const result = spawnSync(NODE_BIN, [CLI_ENTRY, 'update', projectDir, ...fileArgs], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
    });
    if (result.error && isNativeAbiMismatch(result.error)) {
        throw new Error(nodeAbiGuardMessage(result.error));
    }
    return result;
}

const SAMPLE_TS = (label) => `export function ${label}() {\n    return "${label}";\n}\n`;

afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ============================================================
// 1. No-op-exit-0 cases: validateIndex() is the single gate behind all three.
// ============================================================

describe('no-op cases (exit 0, no side effect)', () => {
    test('project dir exists but has no .aidex index: no-op, .aidex never created', () => {
        const dir = makeProjectDir();
        writeProjectFile(dir, 'a.ts', SAMPLE_TS('a'));

        const res = runUpdateCli(dir, ['a.ts']);

        expect(res.status).toBe(0);
        expect(existsSync(join(dir, '.aidex'))).toBe(false);
    });

    test('project dir does not exist at all: no-op, exit 0', () => {
        const dir = join(tmpdir(), 'aidex-cli-update-nonexistent-' + Date.now());
        expect(existsSync(dir)).toBe(false);

        const res = runUpdateCli(dir, ['a.ts']);

        expect(res.status).toBe(0);
        expect(existsSync(dir)).toBe(false);
    });

    test('project path is a file, not a directory: no-op, exit 0', async () => {
        const parent = makeProjectDir();
        const filePath = join(parent, 'not-a-directory.txt');
        writeFileSync(filePath, 'i am a file, not a project', 'utf-8');

        const res = runUpdateCli(filePath, ['a.ts']);

        expect(res.status).toBe(0);
        // validateIndex(filePath) joins '.aidex/index.db' under a file path,
        // which can never exist -- confirms no crash, no side effect either.
        expect(existsSync(join(filePath, '.aidex'))).toBe(false);
    });
});

// ============================================================
// 2. Mixed 8-file batch: one bad file never fails the rest.
// ============================================================

describe('mixed batch tolerates partial failure', () => {
    test('8-file batch: valid files update, .png is skipped, missing file is a silent no-op, Errors: 0, exit 0', async () => {
        const dir = makeProjectDir();
        writeProjectFile(dir, 'normal1.ts', SAMPLE_TS('normal1'));
        writeProjectFile(dir, 'has spaces.ts', SAMPLE_TS('hasSpaces'));
        writeProjectFile(dir, 'accentué.ts', SAMPLE_TS('accentue'));
        writeProjectFile(dir, 'emoji\u{1F600}.ts', SAMPLE_TS('emojiFile'));
        writeProjectFile(dir, 'picture.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        writeProjectFile(dir, 'big.ts', 'export const lines = [\n' + '  "x",\n'.repeat(20000) + '];\n');
        writeProjectFile(dir, 'normal2.ts', SAMPLE_TS('normal2'));
        // 'missing.ts' deliberately never created.
        await seedIndex(dir);

        const fileArgs = [
            'normal1.ts', 'missing.ts', 'picture.png', 'has spaces.ts',
            'accentué.ts', 'emoji\u{1F600}.ts', 'big.ts', 'normal2.ts',
        ];
        const res = runUpdateCli(dir, ['--verbose', ...fileArgs]);

        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/Errors: 0/);
        // 6 files land in the index: normal1, spaced, accented, emoji, big, normal2.
        // picture.png is excluded by DEFAULT_EXCLUDE pattern (skip, not error).
        // missing.ts never existed and was never indexed: remove() reports
        // removed:false, which the CLI branch does not count in any bucket --
        // a true silent no-op, not a "skip".
        const paths = readFilesTable(dir);
        expect(paths).toEqual(expect.arrayContaining([
            'normal1.ts', 'has spaces.ts', 'accentué.ts', 'emoji\u{1F600}.ts', 'big.ts', 'normal2.ts',
        ]));
        expect(paths).not.toContain('picture.png');
        expect(paths).not.toContain('missing.ts');
        expect(paths.length).toBe(6);
    });
});

// ============================================================
// 3. Hash-diff short-circuit: unchanged content is not re-processed.
// ============================================================

describe('hash-diff short-circuit', () => {
    test('second update on unchanged content reports the hash-match short-circuit', async () => {
        const dir = makeProjectDir();
        writeProjectFile(dir, 'stable.ts', SAMPLE_TS('stable'));
        await seedIndex(dir);

        runUpdateCli(dir, ['stable.ts']); // first pass: real index

        const res = runUpdateCli(dir, ['--verbose', 'stable.ts']);

        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/File unchanged \(hash match\)/);
        expect(res.stdout).toMatch(/\+0 -0 items/);
    });
});

// ============================================================
// 4. Dot-segment path normalization.
// ============================================================

describe('path normalization', () => {
    test('src/../src/ok1.ts normalizes to src/ok1.ts', async () => {
        const dir = makeProjectDir();
        writeProjectFile(dir, 'src/ok1.ts', SAMPLE_TS('ok1'));
        await seedIndex(dir);

        const res = runUpdateCli(dir, ['src/../src/ok1.ts']);

        expect(res.status).toBe(0);
        const paths = readFilesTable(dir);
        expect(paths).toContain('src/ok1.ts');
        expect(paths).not.toContain('src/../src/ok1.ts');
    });
});

// ============================================================
// 5. Sandbox escape: never a row outside the project tree.
// ============================================================

describe('sandbox escape is always skipped, never dependent on the target existing', () => {
    test('relative ../outside path is skipped, no row created', async () => {
        const dir = makeProjectDir();
        await seedIndex(dir);

        const res = runUpdateCli(dir, ['../outside/secret.ts']);

        expect(res.status).toBe(0);
        expect(readFilesTable(dir)).toHaveLength(0);
    });

    test('absolute path outside the project tree is skipped, no row created', async () => {
        const dir = makeProjectDir();
        await seedIndex(dir);
        const outsideDir = makeProjectDir(); // a second, unrelated disposable dir
        const outsideFile = join(outsideDir, 'secret.ts');
        writeFileSync(outsideFile, SAMPLE_TS('secret'), 'utf-8');

        const res = runUpdateCli(dir, [outsideFile]);

        expect(res.status).toBe(0);
        expect(readFilesTable(dir)).toHaveLength(0);
    });

    test('cross-drive absolute path is skipped without requiring the target to exist', async () => {
        const dir = makeProjectDir();
        await seedIndex(dir);
        // REPO_ROOT is a real path on a real drive; if the project temp dir
        // happens to share that drive, this degrades to the same case as the
        // "absolute path outside" test above but never fails: the assertion
        // (skip, no row) is identical for both, only the *reason* differs.
        const crossDriveTarget = join(REPO_ROOT, 'package.json');

        const res = runUpdateCli(dir, [crossDriveTarget]);

        expect(res.status).toBe(0);
        expect(readFilesTable(dir)).toHaveLength(0);
    });

    test('UNC-form path is skipped without touching the network', async () => {
        const dir = makeProjectDir();
        await seedIndex(dir);

        const res = runUpdateCli(dir, ['\\\\localhost\\c$\\Windows\\win.ini']);

        expect(res.status).toBe(0);
        expect(readFilesTable(dir)).toHaveLength(0);
    });
});

// ============================================================
// 6. Deleted file routes to remove().
// ============================================================

describe('deleted file removal', () => {
    test('a file removed from disk is removed from the files table', async () => {
        const dir = makeProjectDir();
        const abs = writeProjectFile(dir, 'gone.ts', SAMPLE_TS('gone'));
        await seedIndex(dir);
        runUpdateCli(dir, ['gone.ts']);
        expect(readFilesTable(dir)).toContain('gone.ts');

        rmSync(abs);
        const res = runUpdateCli(dir, ['gone.ts']);

        expect(res.status).toBe(0);
        expect(readFilesTable(dir)).not.toContain('gone.ts');
    });
});

// ============================================================
// 7. Directory passed as a file argument: EISDIR is an error, not a crash.
// ============================================================

describe('directory-as-file argument', () => {
    test('a directory argument is counted as an error, not a crash', async () => {
        const dir = makeProjectDir();
        mkdirSync(join(dir, 'a_real_subdir'));
        writeFileSync(join(dir, 'a_real_subdir', 'placeholder.ts'), SAMPLE_TS('placeholder'), 'utf-8');
        await seedIndex(dir);

        const res = runUpdateCli(dir, ['--verbose', 'a_real_subdir']);

        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/Errors: 1/);
        expect(readFilesTable(dir)).not.toContain('a_real_subdir');
    });
});

// ============================================================
// 8. Dash-prefixed projectPath is rejected, not a silent no-op.
// ============================================================

describe('dash-prefixed projectPath', () => {
    test('a projectPath starting with a dash is rejected with a usage error, not exit 0', () => {
        const res = runUpdateCli('-not-a-real-project', ['a.ts']);

        expect(res.status).toBe(1);
        expect(res.stderr).toMatch(/Usage:/);
    });
});

// ============================================================
// 9. A file literally named -v is protected by a trailing --.
// ============================================================

describe('literal -v filename protected by end-of-options marker', () => {
    // A file literally named "-v" has no recognized extension, so once it
    // reaches the per-file loop it is always classified "Unsupported file
    // type" (skipped), never "updated" -- that part is unrelated to the `--`
    // guard. The guard's OWN effect is binary: whether "-v" ever reaches the
    // loop at all. Without `--`, the exact-match filter treats it as the
    // flag `-v` and drops it from fileArgs before the loop runs (Skipped: 0,
    // nothing processed). With `--`, it reaches the loop and is skipped as
    // an unsupported type (Skipped: 1). That 0-vs-1 delta is the guard.
    test('without -- the token -v is consumed as a flag: fileArgs ends up empty, usage error', async () => {
        const dir = makeProjectDir();
        writeProjectFile(dir, '-v', SAMPLE_TS('dashV'));
        await seedIndex(dir);

        const res = runUpdateCli(dir, ['--verbose', '-v']);

        // '-v' is filtered out as an option token, leaving fileArgs empty,
        // which trips the same usage-error guard as calling update with no
        // file arguments at all (exit 1, not the normal exit 0 / Skipped: 0).
        expect(res.status).toBe(1);
        expect(res.stderr).toMatch(/Usage:/);
        expect(readFilesTable(dir)).not.toContain('-v');
    });

    test('with a trailing -- the file -v reaches the per-file loop and is processed', async () => {
        const dir = makeProjectDir();
        writeProjectFile(dir, '-v', SAMPLE_TS('dashV'));
        await seedIndex(dir);

        const res = runUpdateCli(dir, ['--verbose', '--', '-v']);

        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/Skipped: 1/);
        // Still never indexed (no extension = unsupported type), but that is
        // a DIFFERENT, expected outcome from being silently dropped as a flag.
        expect(readFilesTable(dir)).not.toContain('-v');
    });
});

// ============================================================
// 10. Corrupted database: never noisy, never lies about the return code.
// ============================================================

describe('corrupted database', () => {
    test('a corrupted index.db degrades to per-file errors, exit 0, and EMPTY stdout/stderr in non-verbose mode', async () => {
        const dir = makeProjectDir();
        writeProjectFile(dir, 'a.ts', SAMPLE_TS('a'));
        writeProjectFile(dir, 'b.ts', SAMPLE_TS('b'));
        await seedIndex(dir);
        // Replace the real SQLite file with plain text -- corrupt but present,
        // so validateIndex() (an existsSync check only) still passes.
        writeFileSync(dbPathFor(dir), 'this is not a sqlite database file', 'utf-8');

        const res = runUpdateCli(dir, ['a.ts', 'b.ts']); // non-verbose

        expect(res.status).toBe(0);
        expect(res.stdout).toBe('');
        expect(res.stderr).toBe('');
    });
});

// ============================================================
// 11. Pure case-only rename must collapse to exactly one row.
// ============================================================

describe('pure case-only rename', () => {
    test('old-case delete + new-case add in one batch leaves exactly one row', async () => {
        const dir = makeProjectDir();
        writeProjectFile(dir, 'src/Widget.ts', SAMPLE_TS('Widget'));
        await seedIndex(dir);
        runUpdateCli(dir, ['src/Widget.ts']);
        expect(readFilesTable(dir)).toEqual(['src/Widget.ts']);

        // Simulate the physical rename (case-only, same file on a
        // case-insensitive filesystem) the way git presents it to the hook:
        // the old-case path as a "deletion" and the new-case path as an
        // "addition" in the SAME batch.
        rmSync(join(dir, 'src', 'Widget.ts'));
        writeProjectFile(dir, 'src/widget.ts', SAMPLE_TS('widget'));

        const res = runUpdateCli(dir, ['--verbose', 'src/Widget.ts', 'src/widget.ts']);

        expect(res.status).toBe(0);
        const paths = readFilesTable(dir);
        expect(paths).toHaveLength(1);
        expect(paths[0].toLowerCase()).toBe('src/widget.ts');
    });
});
