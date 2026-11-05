import { spawnSync } from 'child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { dirname, join, relative } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { afterAll, describe, expect, test } from '@jest/globals';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SH_LAUNCHER = join(REPO_ROOT, 'bin', 'aidex');
const CMD_LAUNCHER = join(REPO_ROOT, 'bin', 'aidex.cmd');
const tempDirs = [];

function shellFromPath() {
    const probe = spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf-8' });
    if (probe.error || probe.status !== 0) {
        throw new Error(`sh must be available on PATH: ${probe.error?.message ?? `exit ${probe.status}`}`);
    }
    return 'sh';
}

const SH = shellFromPath();

function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function createShSymlinkFixture() {
    const root = tempDir('aidex-launcher-symlink-');
    const relativeLink = join(root, 'relative', 'aidex');
    const chainedLink = join(root, 'chain', 'aidex');

    try {
        mkdirSync(dirname(relativeLink), { recursive: true });
        mkdirSync(dirname(chainedLink), { recursive: true });
        symlinkSync(relative(dirname(relativeLink), SH_LAUNCHER), relativeLink, 'file');
        symlinkSync(relative(dirname(chainedLink), relativeLink), chainedLink, 'file');
        return { relativeLink, chainedLink };
    } catch (error) {
        return { reason: `symlinks unavailable: ${error.message}` };
    }
}

const shSymlinks = createShSymlinkFixture();
const shSymlinkTest = shSymlinks.reason ? test.skip : test;

afterAll(() => {
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function runSh(launcher, args = ['settings', '--help'], env = {}) {
    const command = process.platform === 'win32' ? SH : launcher;
    const commandArgs = process.platform === 'win32' ? [launcher, ...args] : args;
    return spawnSync(command, commandArgs, {
        encoding: 'utf-8',
        env: { ...process.env, ...env },
    });
}

function launcherWithoutBuild(launcher) {
    const root = tempDir('aidex-launcher-');
    const copy = join(root, 'bin', launcher.endsWith('.cmd') ? 'aidex.cmd' : 'aidex');
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(launcher, copy);
    return copy;
}

function expectCanPattern(result, pattern) {
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pattern });
}

function gitLauncherMode() {
    return spawnSync('git', ['ls-files', '-s', '--', 'bin/aidex'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
    });
}

describe('aidex shell launcher', () => {
    test('uses AIDEX_NODE for a help command', () => {
        const result = runSh(SH_LAUNCHER, ['settings', '--help'], { AIDEX_NODE: process.execPath });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Usage: aidex settings');
    });

    test('fails when AIDEX_NODE does not name an executable', () => {
        const result = runSh(SH_LAUNCHER, ['settings', '--help'], { AIDEX_NODE: 'not-a-node-executable' });
        expect(result.status).not.toBe(0);
    });

    test('reports a missing adjacent build', () => {
        const result = runSh(launcherWithoutBuild(SH_LAUNCHER), ['settings', '--help'], { AIDEX_NODE: process.execPath });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('npm run build');
    });

    test('preserves can patterns with spaces, quotes, and parentheses', () => {
        for (const pattern of [')', ')"', '")', 'a b', 'x"y', '(']) {
            expectCanPattern(runSh(SH_LAUNCHER, ['can', pattern], { AIDEX_NODE: process.execPath }), pattern);
        }
    });

    test('propagates the can missing-pattern exit status', () => {
        const result = runSh(SH_LAUNCHER, ['can'], { AIDEX_NODE: process.execPath });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Usage: aidex can <pattern>');
    });

    shSymlinkTest(`resolves a relative symlink${shSymlinks.reason ? ` (${shSymlinks.reason})` : ''}`, () => {
        const result = runSh(shSymlinks.relativeLink, ['settings', '--help'], { AIDEX_NODE: process.execPath });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Usage: aidex settings');
    });

    shSymlinkTest(`resolves a chain of two symlinks${shSymlinks.reason ? ` (${shSymlinks.reason})` : ''}`, () => {
        const result = runSh(shSymlinks.chainedLink, ['settings', '--help'], { AIDEX_NODE: process.execPath });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Usage: aidex settings');
    });

    test('is tracked as an executable Git file', () => {
        const result = gitLauncherMode();
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/^100755\s/);
    });
});

const describeCmd = process.platform === 'win32' ? describe : describe.skip;

describeCmd('aidex cmd launcher', () => {
    function quoteCmdArgument(argument) {
        return `"${argument.replaceAll('"', '\\"')}"`;
    }

    function runCmd(launcher = CMD_LAUNCHER, args = ['settings', '--help'], env = {}) {
        const command = `""${launcher}" ${args.map(quoteCmdArgument).join(' ')}"`;
        return spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
            encoding: 'utf-8',
            windowsVerbatimArguments: true,
            env: { ...process.env, ...env },
        });
    }

    test('uses AIDEX_NODE for a help command', () => {
        const result = runCmd(CMD_LAUNCHER, ['settings', '--help'], { AIDEX_NODE: process.execPath });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Usage: aidex settings');
    });

    test('fails when AIDEX_NODE does not name an executable', () => {
        const result = runCmd(CMD_LAUNCHER, ['settings', '--help'], { AIDEX_NODE: 'not-a-node-executable' });
        expect(result.status).not.toBe(0);
    });

    test('reports a missing adjacent build', () => {
        const result = runCmd(launcherWithoutBuild(CMD_LAUNCHER), ['settings', '--help'], { AIDEX_NODE: process.execPath });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('npm run build');
    });

    test('preserves can patterns with spaces, quotes, and parentheses', () => {
        for (const pattern of [')', ')"', '")', 'a b', 'x"y', '(']) {
            expectCanPattern(runCmd(CMD_LAUNCHER, ['can', pattern], { AIDEX_NODE: process.execPath }), pattern);
        }
    });

    test('propagates the can missing-pattern exit status', () => {
        const result = runCmd(CMD_LAUNCHER, ['can'], { AIDEX_NODE: process.execPath });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Usage: aidex can <pattern>');
    });
});
