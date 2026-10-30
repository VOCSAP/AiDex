/**
 * cliCommand: the CLI command a server message hands to an agent must run as-is
 * on a station where `aidex` is not on PATH.
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { cliCommand, noIndexError } from '../build/commands/shared.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const slash = (p) => p.split('\\').join('/');
const NODE = slash(process.execPath);
const ENTRY = slash(join(REPO, 'build', 'index.js'));

describe('cliCommand', () => {
    test('names this process node binary and the entry point of the build', () => {
        expect(existsSync(NODE)).toBe(true);
        expect(existsSync(ENTRY)).toBe(true);
        expect(cliCommand('init', ['/work/project'])).toBe(`"${NODE}" "${ENTRY}" init "/work/project"`);
    });

    test('quotes every argument and leaves the subcommand bare', () => {
        expect(cliCommand('viewer', ['<path>', '--tab=settings'])).toBe(`"${NODE}" "${ENTRY}" viewer "<path>" "--tab=settings"`);
    });

    test('a Windows path argument gets forward slashes and loses its trailing separator', () => {
        expect(cliCommand('init', ['D:\\AI\\proj\\'])).toBe(`"${NODE}" "${ENTRY}" init "D:/AI/proj"`);
        expect(cliCommand('init', ['D:\\'])).toBe(`"${NODE}" "${ENTRY}" init "D:/"`);
        expect(cliCommand('init', ['<path>'])).toBe(`"${NODE}" "${ENTRY}" init "<path>"`);
    });

    test('falls back to the short form, labelled before the command, when the entry is missing', () => {
        const missing = join(tmpdir(), 'aidex-no-such-entry', 'index.js');
        expect(cliCommand('init', ['/work/project'], missing)).toBe('AiDex CLI: aidex init "/work/project"');
    });

    test('the shared no-index message carries the runnable command', () => {
        const message = noIndexError('/work/project');
        expect(message).toContain(cliCommand('init', ['/work/project']));
        expect(message).toContain(`"${ENTRY}"`);
    });
});
