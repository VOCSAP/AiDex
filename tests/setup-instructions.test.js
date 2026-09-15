import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { describe, test, expect, afterAll } from '@jest/globals';

import { CLAUDE_MD_BLOCK, installInstructionFile, uninstallInstructionFile } from '../build/commands/setup.js';
import { DEFAULT_DISABLED_TOOLS } from '../build/server/tools.js';

const START = '<!-- AIDEX-START -->';
const END = '<!-- AIDEX-END -->';

const tempDirs = [];
afterAll(() => {
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function target({ installed = true, content } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'aidex-setup-instructions-'));
    tempDirs.push(home);
    const file = { name: 'CLAUDE.md', path: join(home, '.claude', 'CLAUDE.md'), detectDir: join(home, '.claude') };
    if (installed) mkdirSync(file.detectDir, { recursive: true });
    if (content !== undefined) writeFileSync(file.path, content, 'utf8');
    return file;
}

describe('CLAUDE.md block', () => {
    test('names advertised tools only', () => {
        const named = [...CLAUDE_MD_BLOCK.matchAll(/aidex_([a-z_]+)/g)].map((m) => m[1]);
        expect(named.length).toBeGreaterThan(0);
        expect(named.filter((n) => DEFAULT_DISABLED_TOOLS.includes(n))).toEqual([]);
    });

    test('does not contain a local path', () => {
        expect(CLAUDE_MD_BLOCK).not.toMatch(/[A-Za-z]:[\\/]|\/(?:Users|home)\//);
    });

    test('sits between its markers', () => {
        expect(CLAUDE_MD_BLOCK.startsWith(START)).toBe(true);
        expect(CLAUDE_MD_BLOCK.endsWith(END)).toBe(true);
    });
});

describe('installing the block', () => {
    test('writes nothing when the client is not installed', () => {
        const file = target({ installed: false });
        expect(installInstructionFile(file).action).toBe('skipped (not installed)');
        expect(existsSync(file.path)).toBe(false);
    });

    test('creates the file', () => {
        const file = target();
        expect(installInstructionFile(file).action).toBe('created');
        expect(readFileSync(file.path, 'utf8')).toBe(`${CLAUDE_MD_BLOCK}\n`);
    });

    test('appends to a file without AiDex instructions', () => {
        const file = target({ content: '# Mine\n' });
        expect(installInstructionFile(file).action).toBe('appended');
        expect(readFileSync(file.path, 'utf8')).toBe(`# Mine\n\n${CLAUDE_MD_BLOCK}\n`);
    });

    test('replaces an existing block between the markers and keeps the text around it', () => {
        const file = target({ content: `# Mine\n\n${START}\nold AiDex block\n${END}\n\n# After\n` });
        expect(installInstructionFile(file).action).toBe('updated');
        expect(readFileSync(file.path, 'utf8')).toBe(`# Mine\n\n${CLAUDE_MD_BLOCK}\n\n# After\n`);
    });

    test('leaves hand-written AiDex instructions without markers alone', () => {
        const file = target({ content: 'Use aidex_query for code.\n' });
        expect(installInstructionFile(file).action).toBe('skipped (existing AiDex instructions found)');
        expect(readFileSync(file.path, 'utf8')).toBe('Use aidex_query for code.\n');
    });

    test('uninstall removes the block and keeps the rest', () => {
        const file = target({ content: '# Mine\n' });
        installInstructionFile(file);
        expect(uninstallInstructionFile(file)).toEqual({ success: true, removed: true });
        expect(readFileSync(file.path, 'utf8')).toBe('# Mine\n');
    });
});
