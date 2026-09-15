import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

import { jest, describe, test, expect, afterAll } from '@jest/globals';
import Database from 'better-sqlite3';

import { resolveAidexNode } from './helpers/node-interpreter-guard.js';

jest.setTimeout(120000);

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, 'build', 'index.js');
const NODE_BIN = resolveAidexNode();

const tempDirs = [];
afterAll(() => {
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function cli(argv, home) {
    const r = spawnSync(NODE_BIN, [CLI_ENTRY, ...argv], {
        encoding: 'utf-8',
        timeout: 110000,
        env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function startSettingsViewer(home) {
    const script = join(tempDir('aidex-settings-ack-'), 'acknowledge.mjs');
    const moduleUrl = pathToFileURL(join(REPO_ROOT, 'build', 'cli', 'run-tool.js')).href;
    const databaseUrl = pathToFileURL(join(REPO_ROOT, 'node_modules', 'better-sqlite3', 'lib', 'index.js')).href;
    const dbPath = join(home, '.aidex', 'global.db');
    writeFileSync(script, [
        `import { startSettingsCliViewer } from ${JSON.stringify(moduleUrl)};`,
        `import Database from ${JSON.stringify(databaseUrl)};`,
        `const dbPath = ${JSON.stringify(dbPath)};`,
        "await startSettingsCliViewer('/fixture', async () => {",
        "    const db = new Database(dbPath, { readonly: true });",
        "    const seen = db.prepare(\"SELECT value FROM metadata WHERE key = 'last_seen_version'\").get();",
        "    db.close();",
        "    if (seen) throw new Error('version acknowledged before viewer start');",
        "    return 'fake viewer';",
        "});",
    ].join('\n'), 'utf-8');
    return spawnSync(NODE_BIN, [script], {
        encoding: 'utf-8',
        timeout: 110000,
        env: { ...process.env, HOME: home, USERPROFILE: home },
    });
}

function sourceTree(root) {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'widget.ts'), 'export function widget(): number { return 1; }\n', 'utf-8');
    return root;
}

describe.each([
    ['remove', ['<dir>', 'src/widget.ts']],
    ['session', ['<dir>']],
    ['settings', ['<dir>']],
    ['global-status', []],
    ['global-refresh', []],
    ['viewer', ['<dir>', '--action', 'close']],
])('%s', (subcommand, errorArgv) => {
    test('--help prints the usage and exits 0', () => {
        const r = cli([subcommand, '--help'], tempDir('aidex-sub-home-'));
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`Usage: aidex ${subcommand}`);
    });

    test('an unknown flag exits 2 with the usage', () => {
        const r = cli([subcommand, '--no-such-flag'], tempDir('aidex-sub-home-'));
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('unknown option --no-such-flag');
        expect(r.stderr).toContain(`Usage: aidex ${subcommand}`);
    });

    test('a real failure exits 1 with a text starting with Error', () => {
        const unindexed = sourceTree(tempDir('aidex-sub-unindexed-'));
        const argv = errorArgv.map((a) => (a === '<dir>' ? unindexed : a));
        const r = cli([subcommand, ...argv], tempDir('aidex-sub-home-'));
        expect({ status: r.status, stderr: r.stderr.slice(0, 5) }).toEqual({ status: 1, stderr: 'Error' });
    });
});

describe('indexed project', () => {
    test('remove drops the file, session and settings answer, viewer close says how to stop a CLI viewer', () => {
        const home = tempDir('aidex-sub-home-');
        const dir = sourceTree(tempDir('aidex-sub-project-'));
        expect(cli(['init', dir], home).status).toBe(0);

        const removed = cli(['remove', dir, 'src/widget.ts'], home);
        expect(removed.status).toBe(0);

        const session = cli(['session', dir], home);
        expect(session.status).toBe(0);
        expect(session.stdout.trim().length).toBeGreaterThan(0);

        expect(cli(['global-init', dir], home).status).toBe(0);
        expect(cli(['settings', dir], home).status).toBe(0);

        const closed = cli(['viewer', dir, '--action', 'close'], home);
        expect(closed.status).toBe(0);
        expect(closed.stdout).toContain('Viewer was not running');
        expect(closed.stdout).toContain('stops when its last browser tab closes');
    });
});

describe('settings --open', () => {
    test('starts the viewer with the exit-on-last-tab option', async () => {
        const { startCliViewer } = await import('../build/cli/run-tool.js');
        const calls = [];
        const fakeStart = async (...received) => {
            calls.push(received);
            return 'fake viewer';
        };
        expect(await startCliViewer('/work/project', 'settings', fakeStart)).toBe('fake viewer');
        expect(calls).toEqual([['/work/project', 'settings', { exitOnLastClientClose: true }]]);
    });

    test('takes the CLI viewer path, not the MCP handler', () => {
        const unindexed = sourceTree(tempDir('aidex-sub-unindexed-'));
        const r = cli(['settings', unindexed, '--open'], tempDir('aidex-sub-home-'));
        expect(r.stdout).toContain(`Starting Viewer for: ${unindexed}`);
        expect(r.status).toBe(1);
    });

    test('marks the version seen in a fake home after the viewer starts', () => {
        const home = tempDir('aidex-sub-home-');
        const project = sourceTree(tempDir('aidex-sub-project-'));
        expect(cli(['init', project], home).status).toBe(0);
        expect(cli(['global-init', project], home).status).toBe(0);

        const dbPath = join(home, '.aidex', 'global.db');
        let db = new Database(dbPath, { readonly: true });
        try {
            expect(db.prepare("SELECT value FROM metadata WHERE key = 'last_seen_version'").get()).toBeUndefined();
        } finally {
            db.close();
        }

        expect(startSettingsViewer(home).status).toBe(0);

        db = new Database(dbPath, { readonly: true });
        try {
            expect(db.prepare("SELECT value FROM metadata WHERE key = 'last_seen_version'").get()?.value).toBeTruthy();
        } finally {
            db.close();
        }
    });
});

describe('scan and global-init flags', () => {
    test('scan --max-depth limits how deep indexed projects are found', () => {
        const home = tempDir('aidex-sub-home-');
        const root = tempDir('aidex-sub-scan-');
        const deep = sourceTree(join(root, 'a', 'b', 'c'));
        expect(cli(['init', deep], home).status).toBe(0);

        const unbounded = cli(['scan', root], home);
        expect(unbounded.status).toBe(0);
        expect(unbounded.stdout).toContain('Indexes Found: 1');
        expect(unbounded.stdout).toMatch(/Distinct terms \(case-folded\): \d+/);

        const shallow = cli(['scan', root, '--max-depth', '1'], home);
        expect(shallow.status).toBe(0);
        expect(shallow.stdout).toContain('Indexes Found: 0');
    });

    test('global-init --tags reaches the registry and --exclude skips an unindexed project', () => {
        const home = tempDir('aidex-sub-home-');
        const root = tempDir('aidex-sub-global-');
        expect(cli(['init', sourceTree(join(root, 'indexed-one'))], home).status).toBe(0);
        for (const name of ['listed-unindexed', 'skipped-unindexed']) {
            sourceTree(join(root, name));
            writeFileSync(join(root, name, 'package.json'), '{"name":"fixture"}\n', 'utf-8');
        }

        const plain = cli(['global-init', root], home);
        expect(plain.status).toBe(0);
        expect(plain.stdout).toContain('listed-unindexed');
        expect(plain.stdout).toContain('skipped-unindexed');

        const registered = cli(['global-init', root, '--exclude', 'skipped-unindexed', '--tags', 'parity-tag'], home);
        expect(registered.status).toBe(0);
        expect(registered.stdout).toContain('listed-unindexed');
        expect(registered.stdout).not.toContain('skipped-unindexed');

        const status = cli(['global-status', '--tag-filter', 'parity-tag'], home);
        expect(status.status).toBe(0);
        expect(status.stdout).toContain('indexed-one');

        expect(cli(['global-refresh'], home).status).toBe(0);
    });

    test('scan and global-init without a path exit 2', () => {
        const home = tempDir('aidex-sub-home-');
        expect(cli(['scan'], home).status).toBe(2);
        expect(cli(['global-init'], home).status).toBe(2);
    });
});
