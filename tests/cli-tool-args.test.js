/**
 * CLI init and rebuild-index read their flags from the aidex_init inputSchema
 * and hand them to init() through the mapping the MCP handler uses.
 *
 * The embeddings run is spawned with HOME and USERPROFILE on a directory where
 * `.aidex` is a plain file: the worker fails opening the global database, which
 * it does before loading a model, so the path is reached without a download
 * and without touching the real global database.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

import { jest, describe, test, expect, afterAll } from '@jest/globals';
import Database from 'better-sqlite3';

import { parseToolArgs, flagName } from '../build/cli/tool-args.js';
import { declaredTools, initParamsFromArgs } from '../build/server/tools.js';
import { TOOL_PREFIX } from '../build/constants.js';
import { resolveAidexNode } from './helpers/node-interpreter-guard.js';

jest.setTimeout(120000);

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, 'build', 'index.js');
const NODE_BIN = resolveAidexNode();
const INIT_SCHEMA = declaredTools().find((t) => t.name === `${TOOL_PREFIX}init`).inputSchema;

const tempDirs = [];
afterAll(() => {
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function project() {
    const dir = tempDir('aidex-cli-tool-args-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'widget.ts'), 'export function widget(): number { return 1; }\n', 'utf-8');
    return dir;
}

function cli(argv, env = {}) {
    const r = spawnSync(NODE_BIN, [CLI_ENTRY, ...argv], {
        encoding: 'utf-8',
        timeout: 110000,
        env: { ...process.env, ...env },
    });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}`, stderr: r.stderr };
}

function storeBodies(dir) {
    const db = new Database(join(dir, '.aidex', 'index.db'), { readonly: true });
    try {
        return db.prepare("SELECT value FROM metadata WHERE key = 'store_bodies'").get()?.value;
    } finally {
        db.close();
    }
}

function argvForEverySchemaProperty() {
    const argv = ['/work/project'];
    const expected = { path: '/work/project' };
    for (const [property, spec] of Object.entries(INIT_SCHEMA.properties)) {
        if (property === 'path') continue;
        const flag = flagName(property);
        if (spec.type === 'boolean') {
            argv.push(flag);
            expected[property] = true;
        } else if (spec.type === 'number') {
            argv.push(flag, '7');
            expected[property] = 7;
        } else if (spec.type === 'string') {
            argv.push(flag, `value-of-${property}`);
            expected[property] = `value-of-${property}`;
        } else if (spec.type === 'array') {
            argv.push(flag, 'a/**', flag, '{b,c}/**');
            expected[property] = ['a/**', '{b,c}/**'];
        } else {
            throw new Error(`${property} has a schema type with no CLI mapping: ${spec.type}`);
        }
    }
    return { argv, expected };
}

describe('flags derived from the aidex_init schema', () => {
    test('every schema property other than the positional path is read from its flag', () => {
        const { argv, expected } = argvForEverySchemaProperty();
        expect(parseToolArgs(INIT_SCHEMA, argv, ['path'])).toEqual({ ok: true, args: expected });
    });

    test('the shared mapping hands every schema property to init()', () => {
        const { expected } = argvForEverySchemaProperty();
        const params = initParamsFromArgs(expected);
        for (const property of Object.keys(INIT_SCHEMA.properties)) {
            expect([property, params[property]]).toEqual([property, expected[property]]);
        }
    });

    test('explicit boolean and inline values parse', () => {
        expect(parseToolArgs(INIT_SCHEMA, ['/p', '--store-bodies=false', '--name=--odd'], ['path']))
            .toEqual({ ok: true, args: { path: '/p', store_bodies: false, name: '--odd' } });
        const numeric = { properties: { max_depth: { type: 'number' } } };
        expect(parseToolArgs(numeric, ['--max-depth', '3'])).toEqual({ ok: true, args: { max_depth: 3 } });
    });

    test.each([
        ['an unknown flag', ['/p', '--no-such-flag']],
        ['a boolean with a non boolean value', ['/p', '--store-bodies=maybe']],
        ['a value flag without its value', ['/p', '--name']],
        ['a spaced value starting with --', ['/p', '--name', '--embeddings']],
        ['a scalar flag given twice', ['/p', '--name', 'a', '--name', 'b']],
        ['the positional given as a flag', ['--path', '/p']],
        ['a missing positional', ['--embeddings']],
        ['an extra positional', ['/p', '/q']],
    ])('%s is refused', (_label, argv) => {
        expect(parseToolArgs(INIT_SCHEMA, argv, ['path']).ok).toBe(false);
    });

    test('an empty value is refused except for an llm_* property, where it clears the setting', () => {
        expect(parseToolArgs(INIT_SCHEMA, ['/p', '--name='], ['path']).ok).toBe(false);
        expect(parseToolArgs(INIT_SCHEMA, ['/p', '--exclude='], ['path']).ok).toBe(false);
        expect(parseToolArgs(INIT_SCHEMA, ['/p', '--llm-endpoint='], ['path']))
            .toEqual({ ok: true, args: { path: '/p', llm_endpoint: '' } });
    });

    test('--help asks for the usage, and a lone -- ends the options', () => {
        expect(parseToolArgs(INIT_SCHEMA, ['/p', '--help'], ['path'])).toEqual({ ok: false, help: true, error: '' });
        expect(parseToolArgs(INIT_SCHEMA, ['--', '--odd-dir'], ['path'])).toEqual({ ok: true, args: { path: '--odd-dir' } });
        const afterEnd = parseToolArgs(INIT_SCHEMA, ['/p', '--', '--help'], ['path']);
        expect(afterEnd.ok).toBe(false);
        expect(afterEnd.help).toBe(false);
    });

    test('a non numeric value for a number is refused', () => {
        const numeric = { properties: { max_depth: { type: 'number' } } };
        expect(parseToolArgs(numeric, ['--max-depth', 'deep']).ok).toBe(false);
    });
});

describe('CLI init and rebuild-index', () => {
    test.each([
        ['init', '--no-such-flag'],
        ['init', '--store-bodies=maybe'],
        ['rebuild-index', '--no-such-flag'],
    ])('%s %s exits 2 with the usage', (subcommand, flag) => {
        const r = cli([subcommand, project(), flag]);
        expect(r.status).toBe(2);
        expect(r.stderr).toContain(`Usage: aidex ${subcommand} <path> [options]`);
        expect(r.stderr).toContain('--store-bodies');
    });

    test('init without a path exits 2', () => {
        expect(cli(['init']).status).toBe(2);
    });

    test('init --help prints the usage and exits 0', () => {
        const r = cli(['init', '--help']);
        expect(r.status).toBe(0);
        expect(r.out).toContain('Usage: aidex init <path> [options]');
    });

    test('name and exclude reach init() the same way through the MCP handler and the CLI', () => {
        const home = tempDir('aidex-cli-tool-args-home-');
        const env = { HOME: home, USERPROFILE: home };
        const fixture = () => {
            const dir = project();
            mkdirSync(join(dir, 'skip'), { recursive: true });
            writeFileSync(join(dir, 'skip', 'hidden.ts'), 'export function hidden(): number { return 2; }\n', 'utf-8');
            return dir;
        };

        const viaCli = fixture();
        expect(cli(['init', viaCli, '--name', 'parity-name', '--exclude', 'skip/**'], env).status).toBe(0);

        const viaMcp = fixture();
        const toolsUrl = pathToFileURL(join(REPO_ROOT, 'build', 'server', 'tools.js')).href;
        const code = [
            `import { handleToolCall } from ${JSON.stringify(toolsUrl)};`,
            `const r = await handleToolCall('${TOOL_PREFIX}init', JSON.parse(process.env.AIDEX_PARITY_ARGS));`,
            `process.stdout.write(r.content[0].text);`,
        ].join('\n');
        const mcp = spawnSync(NODE_BIN, ['--input-type=module', '-e', code], {
            encoding: 'utf-8',
            timeout: 110000,
            env: {
                ...process.env,
                ...env,
                AIDEX_PARITY_ARGS: JSON.stringify({ path: viaMcp, name: 'parity-name', exclude: ['skip/**'] }),
            },
        });
        expect(mcp.status).toBe(0);

        const indexed = (dir) => {
            const db = new Database(join(dir, '.aidex', 'index.db'), { readonly: true });
            try {
                return {
                    name: db.prepare("SELECT value FROM metadata WHERE key = 'project_name'").get()?.value,
                    files: db.prepare('SELECT path FROM files ORDER BY path').all().map((r) => r.path),
                };
            } finally {
                db.close();
            }
        };
        const cliIndex = indexed(viaCli);
        expect(cliIndex.name).toBe('parity-name');
        expect(cliIndex.files).not.toContain('skip/hidden.ts');
        expect(indexed(viaMcp)).toEqual(cliIndex);
    });

    test('--embeddings reaches the embeddings path of init', () => {
        const home = tempDir('aidex-cli-tool-args-home-');
        writeFileSync(join(home, '.aidex'), 'not a directory\n', 'utf-8');
        const env = { HOME: home, USERPROFILE: home };

        const withFlag = project();
        const embedded = cli(['init', withFlag, '--embeddings'], env);
        expect(embedded.out).toContain('Done!');
        expect(embedded.out).toContain('Embeddings:');
        expect(storeBodies(withFlag)).toBe('1');

        const withoutFlag = project();
        const plain = cli(['init', withoutFlag], env);
        expect(plain.status).toBe(0);
        expect(plain.out).not.toContain('Embeddings:');
        expect(storeBodies(withoutFlag)).toBe('0');
    });
});
