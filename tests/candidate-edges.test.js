/**
 * Candidate relationship graph regressions -- spec_0093d7f3.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

import { describe, test, afterEach, expect } from '@jest/globals';
import Database from 'better-sqlite3';

import { init } from '../build/commands/init.js';
import { update, remove } from '../build/commands/update.js';
import { session } from '../build/commands/session.js';
import { handleToolCall } from '../build/server/tools.js';

const tempDirs = [];

function project() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-candidate-edges-'));
    tempDirs.push(dir);
    return dir;
}

function write(dir, relativePath, content) {
    const absolutePath = join(dir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
}

function readEdges(dir) {
    const db = new Database(join(dir, '.aidex', 'index.db'), { readonly: true });
    try {
        return db.prepare(`
            SELECT
                e.kind,
                e.confidence,
                e.source_symbol,
                e.target_symbol,
                e.source_line,
                e.target_line,
                e.provenance,
                sf.path AS source_file,
                tf.path AS target_file
            FROM candidate_edges e
            JOIN files sf ON sf.id = e.source_file_id
            LEFT JOIN files tf ON tf.id = e.target_file_id
            ORDER BY e.kind, e.source_line, e.target_symbol
        `).all();
    } finally {
        db.close();
    }
}

afterEach(() => {
    while (tempDirs.length) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('candidate import and call edges', () => {
    test('full init persists resolved project-local import and direct-call candidates', async () => {
        const dir = project();
        write(dir, 'src/math.ts', 'export function add(a: number, b: number) { return a + b; }\n');
        write(dir, 'src/app.ts', [
            'import { add } from "./math.js";',
            'export function run() {',
            '  return add(1, 2);',
            '}',
            '',
        ].join('\n'));

        const result = await init({ path: dir });
        expect(result.success).toBe(true);

        expect(readEdges(dir)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'call',
                confidence: 'candidate',
                source_file: 'src/app.ts',
                target_file: 'src/math.ts',
                source_symbol: 'run',
                target_symbol: 'add',
                source_line: 3,
                provenance: 'tree-sitter:direct-call',
            }),
            expect.objectContaining({
                kind: 'import',
                confidence: 'candidate',
                source_file: 'src/app.ts',
                target_file: 'src/math.ts',
                target_symbol: './math.js',
                source_line: 1,
                provenance: 'tree-sitter:relative-import',
            }),
        ]));
    });

    test('resolves Python from-relative imports and their direct calls', async () => {
        const dir = project();
        write(dir, 'pkg/math.py', 'def add(a, b):\n    return a + b\n');
        write(dir, 'pkg/app.py', 'from .math import add\n\ndef run():\n    return add(1, 2)\n');

        expect((await init({ path: dir })).success).toBe(true);
        expect(readEdges(dir)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'import',
                source_file: 'pkg/app.py',
                target_file: 'pkg/math.py',
                target_symbol: '.math',
            }),
            expect.objectContaining({
                kind: 'call',
                source_file: 'pkg/app.py',
                target_file: 'pkg/math.py',
                target_symbol: 'add',
            }),
        ]));
    });

    test('incremental update replaces stale outgoing observations and targets', async () => {
        const dir = project();
        write(dir, 'src/math.ts', 'export function add(a: number, b: number) { return a + b; }\n');
        write(dir, 'src/app.ts', 'import { add } from "./math";\nexport function run() { return add(1, 2); }\n');
        expect((await init({ path: dir })).success).toBe(true);
        expect(readEdges(dir).length).toBeGreaterThan(0);

        write(dir, 'src/app.ts', 'export function run() { return 42; }\n');
        expect(update({ path: dir, file: 'src/app.ts' }).success).toBe(true);

        expect(readEdges(dir).filter(edge => edge.source_file === 'src/app.ts')).toEqual([]);
    });


    test('incremental target changes rebuild existing call resolution', async () => {
        const dir = project();
        write(dir, 'src/math.ts', 'export function add() { return 1; }\n');
        write(dir, 'src/app.ts', 'export function run() { return add(); }\n');
        expect((await init({ path: dir })).success).toBe(true);
        expect(readEdges(dir)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'call',
                target_symbol: 'add',
                target_file: 'src/math.ts',
            }),
        ]));

        write(dir, 'src/math.ts', 'export function renamed() { return 1; }\n');
        expect(update({ path: dir, file: 'src/math.ts' }).success).toBe(true);

        expect(readEdges(dir)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'call',
                target_symbol: 'add',
                target_file: null,
                target_line: null,
            }),
        ]));
    });

    test('ambiguous project-wide declarations stay unresolved', async () => {
        const dir = project();
        write(dir, 'src/a.ts', 'export function shared() { return 1; }\n');
        write(dir, 'src/b.ts', 'export function shared() { return 2; }\n');
        write(dir, 'src/app.ts', 'export function run() { return shared(); }\n');
        expect((await init({ path: dir })).success).toBe(true);

        expect(readEdges(dir)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'call',
                target_symbol: 'shared',
                target_file: null,
                target_line: null,
            }),
        ]));
    });
    test('MCP edge query exposes confidence and refuses to claim completeness', async () => {
        const dir = project();
        write(dir, 'src/math.ts', 'export function add(a: number, b: number) { return a + b; }\n');
        write(dir, 'src/app.ts', 'import { add } from "./math";\nexport function run() { return add(1, 2); }\n');
        expect((await init({ path: dir })).success).toBe(true);

        const response = await handleToolCall('aidex_edges', {
            path: dir,
            file: 'src/math.ts',
            direction: 'incoming',
        });
        const text = response.content[0].text;

        expect(text).toMatch(/candidate/);
        expect(text).toMatch(/src\/app\.ts/);
        expect(text).toMatch(/syntax-derived/i);
        expect(text).toMatch(/does not prove semantic absence/i);

        const limited = await handleToolCall('aidex_edges', {
            path: dir,
            file: 'src/math.ts',
            direction: 'incoming',
            limit: 1.5,
        });
        expect(limited.content[0].text).not.toMatch(/^Error:/);

        expect(remove({ path: dir, file: 'src/math.ts' }).success).toBe(true);
        const remaining = readEdges(dir);
        expect(remaining.every(edge => edge.target_file === null)).toBe(true);
    });

    test('session cleanup removes candidate edges from externally deleted files', async () => {
        const dir = project();
        write(dir, 'src/math.ts', 'export function add() { return 1; }\n');
        write(dir, 'src/app.ts', 'import { add } from "./math";\nexport function run() { return add(); }\n');
        expect((await init({ path: dir })).success).toBe(true);

        const db = new Database(join(dir, '.aidex', 'index.db'));
        const expired = (Date.now() - 10 * 60 * 1000).toString();
        db.prepare('UPDATE metadata SET value = ? WHERE key = ?')
            .run(expired, 'current_session_start');
        db.prepare('UPDATE metadata SET value = ? WHERE key = ?')
            .run(expired, 'last_session_end');
        db.close();

        unlinkSync(join(dir, 'src/app.ts'));
        const result = session({ path: dir });

        expect(result.success).toBe(true);
        expect(result.externalChanges).toContainEqual({
            path: 'src/app.ts',
            reason: 'deleted',
        });
        expect(readEdges(dir).some(edge => edge.source_file === 'src/app.ts')).toBe(false);
    });

    test('opening a legacy index migrates the candidate edge table and indexes idempotently', async () => {
        const dir = project();
        write(dir, 'src/legacy.ts', 'export function legacy() { return 1; }\n');
        expect((await init({ path: dir })).success).toBe(true);

        const dbPath = join(dir, '.aidex', 'index.db');
        const legacy = new Database(dbPath);
        legacy.exec('DROP TABLE candidate_edges');
        legacy.prepare('UPDATE metadata SET value = ? WHERE key = ?')
            .run('1.3', 'schema_version');
        legacy.close();

        const response = await handleToolCall('aidex_edges', {
            path: dir,
            file: 'src/legacy.ts',
        });
        expect(response.content[0].text).not.toMatch(/^Error:/);

        const migrated = new Database(dbPath, { readonly: true });
        const table = migrated.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'candidate_edges'"
        ).get();
        const index = migrated.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_methods_name_nocase'"
        ).get();
        migrated.close();

        expect(table).toEqual({ name: 'candidate_edges' });
        expect(index).toEqual({ name: 'idx_methods_name_nocase' });
    });
});

