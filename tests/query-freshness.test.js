/**
 * aidex_query checks every file it returns against the disk -- spec_b51b792e.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

import { afterEach, describe, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';

import { init } from '../build/commands/init.js';
import { query } from '../build/commands/query.js';
import { handleToolCall } from '../build/server/tools.js';

const tempDirs = [];

function project() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-query-freshness-'));
    tempDirs.push(dir);
    return dir;
}

function write(dir, relativePath, content) {
    const absolutePath = join(dir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
}

function source(name, padding = 0) {
    return [
        ...Array.from({ length: padding }, (_, i) => `// padding ${i}`),
        `export function ${name}(): number {`,
        '    return 1;',
        '}',
        '',
    ].join('\n');
}

function filesTable(dir) {
    const db = new Database(join(dir, '.aidex', 'index.db'), { readonly: true });
    try {
        return db.prepare('SELECT path, hash, last_indexed FROM files ORDER BY path').all();
    } finally {
        db.close();
    }
}

async function queryText(dir, term) {
    const res = await handleToolCall('aidex_query', { path: dir, term });
    return res.content[0].text;
}

afterEach(() => {
    while (tempDirs.length) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('aidex_query freshness', () => {
    test('a file edited on disk after indexing is answered with its current line numbers', async () => {
        const dir = project();
        write(dir, 'src/a.ts', source('freshTarget'));
        expect((await init({ path: dir })).success).toBe(true);

        write(dir, 'src/a.ts', source('freshTarget', 3));

        const text = await queryText(dir, 'freshTarget');
        expect(text).toContain('src/a.ts\n  :4 (method)');
        expect(text).not.toContain(':1 (method)');
        expect(text).not.toContain('[stale]');
    });

    test('a returned file deleted from disk leaves the result and the index', async () => {
        const dir = project();
        write(dir, 'src/a.ts', source('goneTarget'));
        write(dir, 'src/b.ts', source('goneTarget'));
        expect((await init({ path: dir })).success).toBe(true);

        unlinkSync(join(dir, 'src', 'b.ts'));

        const result = query({ path: dir, term: 'goneTarget' });
        expect(result.success).toBe(true);
        expect(result.matches.map(m => m.file)).toEqual(['src/a.ts']);
        expect(result.staleFiles).toEqual([]);
        expect(filesTable(dir).map(f => f.path)).toEqual(['src/a.ts']);
    });

    test('a returned file now excluded by .gitignore is dropped from the index', async () => {
        const dir = project();
        write(dir, 'src/a.ts', source('ignoredTarget'));
        write(dir, 'gen/b.ts', source('ignoredTarget'));
        expect((await init({ path: dir })).success).toBe(true);

        write(dir, '.gitignore', 'gen/\n');
        write(dir, 'gen/b.ts', source('ignoredTarget', 2));

        const result = query({ path: dir, term: 'ignoredTarget' });
        expect(result.matches.map(m => m.file)).toEqual(['src/a.ts']);
        expect(filesTable(dir).map(f => f.path)).toEqual(['src/a.ts']);
    });

    test('beyond three stale files, three are reindexed and the rest are marked [stale]', async () => {
        const dir = project();
        const names = ['a', 'b', 'c', 'd', 'e'];
        for (const n of names) write(dir, `src/${n}.ts`, source('manyTarget'));
        expect((await init({ path: dir })).success).toBe(true);
        const before = new Map(filesTable(dir).map(f => [f.path, f.hash]));

        for (const n of names) write(dir, `src/${n}.ts`, source('manyTarget', 5));

        const text = await queryText(dir, 'manyTarget');
        const after = filesTable(dir);
        const reindexed = after.filter(f => f.hash !== before.get(f.path)).map(f => f.path);
        expect(reindexed).toHaveLength(3);

        const staleLines = text.split('\n').filter(l => l.includes('[stale]'));
        expect(staleLines).toHaveLength(2);
        for (const path of reindexed) {
            expect(text).toContain(`${path}\n  :6 (method)`);
        }
        expect(text).toMatch(/2 file\(s\) changed on disk/);
    });

    test('an unreadable returned file is marked [stale] without an error', async () => {
        const dir = project();
        write(dir, 'src/a.ts', source('lockedTarget'));
        expect((await init({ path: dir })).success).toBe(true);
        const before = filesTable(dir);

        unlinkSync(join(dir, 'src', 'a.ts'));
        mkdirSync(join(dir, 'src', 'a.ts'));

        const text = await queryText(dir, 'lockedTarget');
        expect(text).toContain('src/a.ts [stale]');
        expect(filesTable(dir)).toEqual(before);
    });

    test('an unchanged project is answered without touching the index', async () => {
        const dir = project();
        write(dir, 'src/a.ts', source('calmTarget'));
        write(dir, 'src/b.ts', source('calmTarget', 1));
        expect((await init({ path: dir })).success).toBe(true);
        const before = filesTable(dir);

        const text = await queryText(dir, 'calmTarget');

        expect(text).toBe(
            'Found 2 match(es) for "calmTarget" (mode: exact, kinds: symbol)\n\n'
            + 'src/a.ts\n  :1 (method)\n'
            + 'src/b.ts\n  :2 (method)',
        );
        expect(filesTable(dir)).toEqual(before);
    });
});
