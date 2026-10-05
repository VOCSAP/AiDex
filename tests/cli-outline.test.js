/**
 * Contract of `node build/index.js outline <file>`: exit 0 with a plan on
 * stdout, exit 3 with empty stdout when no plan exists, exit 2 on usage error.
 * A Read hook stays silent on anything but exit 0, so the empty-stdout rule
 * is asserted on every non-zero path.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { jest, describe, test, beforeAll, afterAll, expect } from '@jest/globals';
import Database from 'better-sqlite3';

import { init } from '../build/commands/init.js';
import { resolveAidexNode } from './helpers/node-interpreter-guard.js';

jest.setTimeout(60000);

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, 'build', 'index.js');
const NODE_BIN = resolveAidexNode();

const CODE = [
    'export interface Shape {',
    '    name: string;',
    '}',
    '',
    'export function outer(x: number): number {',
    '    const y = x + 1;',
    '    return y;',
    '}',
    '',
].join('\n');

const MARKDOWN = [
    '# Title',
    'intro',
    '## A',
    'text',
    '```bash',
    '# not a heading',
    '```',
    '## B',
    'end',
    '',
].join('\n');

const tempDirs = [];
let projectDir;

function makeDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function writeFile(root, rel, content) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    return abs;
}

function runOutline(args, cwd) {
    const r = spawnSync(NODE_BIN, [CLI_ENTRY, 'outline', ...args], { cwd, encoding: 'utf-8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(async () => {
    projectDir = makeDir('aidex-cli-outline-');
    writeFile(projectDir, 'src/a.ts', CODE);
    writeFile(projectDir, 'docs/guide.md', MARKDOWN);
    writeFile(projectDir, 'src/edited.ts', CODE);
    const res = await init({ path: projectDir, store_bodies: true });
    if (!res.success) throw new Error(`init failed: ${JSON.stringify(res)}`);
    writeFile(projectDir, 'src/late.ts', CODE);
});

afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('outline of an indexed code file', () => {
    test('prints types and methods with their line range, sorted by start line', () => {
        const r = runOutline(['src/a.ts'], projectDir);
        expect(r.status).toBe(0);
        const lines = r.stdout.trimEnd().split('\n');
        expect(lines[0]).toBe('src/a.ts: 8 lines, 2 symbol(s)');
        expect(lines[1]).toMatch(/^\s+1-3\s+interface Shape$/);
        expect(lines[2]).toMatch(/^\s+5-8\s+export function outer/);
    });

    test('a legacy index without types.end_line nor methods.body_lines degrades to start lines instead of failing', async () => {
        const legacy = makeDir('aidex-cli-outline-legacy-');
        writeFile(legacy, 'src/a.ts', CODE);
        const res = await init({ path: legacy });
        if (!res.success) throw new Error(`init failed: ${JSON.stringify(res)}`);
        const db = new Database(join(legacy, '.aidex', 'index.db'));
        try {
            db.exec('ALTER TABLE types DROP COLUMN end_line');
            db.exec('UPDATE methods SET body_lines = NULL');
        } finally {
            db.close();
        }
        const r = runOutline(['src/a.ts'], legacy);
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
        const lines = r.stdout.trimEnd().split('\n');
        expect(lines[1]).toMatch(/^\s+1\s+interface Shape$/);
        expect(lines[2]).toMatch(/^\s+5\s+export function outer/);
    });

    test('an absolute path from another cwd resolves the same index row', () => {
        const r = runOutline([join(projectDir, 'src', 'a.ts')], REPO_ROOT);
        expect(r.status).toBe(0);
        expect(r.stdout.split('\n')[0]).toBe('src/a.ts: 8 lines, 2 symbol(s)');
    });

    test('--limit caps the entries and the header announces it', () => {
        const r = runOutline(['src/a.ts', '--limit', '1'], projectDir);
        expect(r.status).toBe(0);
        const lines = r.stdout.trimEnd().split('\n');
        expect(lines[0]).toBe('src/a.ts: 8 lines, 2 symbol(s) [showing first 1]');
        expect(lines).toHaveLength(2);
    });
});

describe('outline of a markdown file', () => {
    test('heading ranges extend to the next heading of equal or higher level, fenced lines ignored', () => {
        const r = runOutline(['docs/guide.md', '--project', projectDir], projectDir);
        expect(r.status).toBe(0);
        const lines = r.stdout.trimEnd().split('\n');
        expect(lines[0]).toBe('docs/guide.md: 9 lines, 3 heading(s)');
        expect(lines.slice(1).map(l => l.trim().replace(/\s+/, ' '))).toEqual([
            '1-9 # Title',
            '3-7 ## A',
            '8-9 ## B',
        ]);
    });
});

describe('no plan available', () => {
    test.each([
        ['file outside any indexed project', () => [writeFile(makeDir('aidex-cli-outline-noidx-'), 'x.ts', CODE)], /no indexed project/],
        ['file created after init', () => ['src/late.ts'], /file not in index/],
        ['missing file', () => ['src/nope.ts'], /file not found/],
        ['markdown without headings', () => [writeFile(projectDir, 'docs/plain.md', 'just text\n')], /no headings/],
        ['file outside the --project root', () => [writeFile(makeDir('aidex-cli-outline-out-'), 'y.ts', CODE), '--project', projectDir], /file outside project/],
    ])('%s: exit 3, empty stdout', (_name, makeArgs, reason) => {
        const r = runOutline(makeArgs(), projectDir);
        expect(r.status).toBe(3);
        expect(r.stdout).toBe('');
        expect(r.stderr).toMatch(reason);
    });

    test('file edited after indexing: exit 3 stale index, so no shifted range is ever printed', () => {
        writeFile(projectDir, 'src/edited.ts', `// shifted\n${CODE}`);
        const r = runOutline(['src/edited.ts'], projectDir);
        expect(r.status).toBe(3);
        expect(r.stdout).toBe('');
        expect(r.stderr).toMatch(/stale index/);
    });

    test.each([
        ['missing file argument', []],
        ['--project without a value', ['src/a.ts', '--project']],
        ['--project followed by another flag', ['src/a.ts', '--project', '--limit', '1']],
    ])('%s is a usage error: exit 2, empty stdout', (_name, args) => {
        const r = runOutline(args, projectDir);
        expect(r.status).toBe(2);
        expect(r.stdout).toBe('');
    });
});
