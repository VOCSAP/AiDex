/**
 * Line ranges in aidex_signature / aidex_signatures -- spec_f4fd3132.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

import { afterEach, describe, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';

import { init, LINE_RANGES_SCHEMA } from '../build/commands/init.js';
import { update } from '../build/commands/update.js';
import { handleToolCall } from '../build/server/tools.js';
import { createDatabase } from '../build/db/index.js';

const SOURCE = [
    'export class Widget {',
    '    render(): string {',
    "        return 'w';",
    '    }',
    '}',
    '',
    'export function one(): number { return 1; }',
    '',
].join('\n');

const tempDirs = [];

function project() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-line-ranges-'));
    tempDirs.push(dir);
    return dir;
}

function write(dir, relativePath, content) {
    const absolutePath = join(dir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf-8');
}

function withDb(dir, fn) {
    const db = new Database(join(dir, '.aidex', 'index.db'));
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

async function signatureText(dir) {
    const res = await handleToolCall('aidex_signature', { path: dir, file: 'src/widget.ts' });
    return res.content[0].text;
}

function lineWith(text, needle) {
    const lines = text.split('\n').filter(l => l.includes(needle));
    expect(lines).toHaveLength(1);
    return lines[0];
}

afterEach(() => {
    while (tempDirs.length) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('signature line ranges', () => {
    test('aidex_signature puts the range on the existing type and method lines, without stored bodies', async () => {
        const dir = project();
        write(dir, 'src/widget.ts', SOURCE);
        await init({ path: dir });

        const bodies = withDb(dir, db => db.prepare('SELECT COUNT(*) AS n FROM methods WHERE body_text IS NOT NULL').get().n);
        expect(bodies).toBe(0);

        const text = await signatureText(dir);
        expect(lineWith(text, '`Widget`')).toContain('(line 1-5)');
        expect(lineWith(text, 'render()')).toContain('(line 2-4)');
        expect(lineWith(text, 'one()')).toContain('(line 7)');
    });

    test('aidex_signatures puts the range on the existing summary and method lines', async () => {
        const dir = project();
        write(dir, 'src/widget.ts', SOURCE);
        await init({ path: dir });

        const res = await handleToolCall('aidex_signatures', { path: dir, files: ['src/widget.ts'] });
        const text = res.content[0].text;
        expect(lineWith(text, 'Types:')).toContain('class Widget :1-5');
        expect(lineWith(text, 'render()')).toMatch(/:2-4$/);
        expect(lineWith(text, 'one()')).toMatch(/:7$/);
    });

    test('a legacy index without types.end_line still serves signatures, then migrates on a writable open', async () => {
        const dir = project();
        write(dir, 'src/widget.ts', SOURCE);
        await init({ path: dir });
        withDb(dir, db => {
            db.exec('ALTER TABLE types DROP COLUMN end_line');
            db.exec('UPDATE methods SET body_lines = NULL');
        });

        const legacy = await signatureText(dir);
        expect(legacy).not.toMatch(/^Error/);
        expect(lineWith(legacy, '`Widget`')).toContain('(line 1)');
        expect(lineWith(legacy, 'render()')).toContain('(line 2)');

        const pluralRes = await handleToolCall('aidex_signatures', { path: dir, files: ['src/widget.ts'] });
        const pluralText = pluralRes.content[0].text;
        expect(lineWith(pluralText, 'Types:')).toMatch(/class Widget(?=\s\||$)/);
        expect(lineWith(pluralText, 'render()')).toMatch(/:2$/);

        write(dir, 'src/widget.ts', SOURCE + '// touched\n');
        const result = update({ path: dir, file: 'src/widget.ts' });
        expect(result.success).toBe(true);

        const columns = withDb(dir, db => db.prepare('PRAGMA table_info(types)').all().map(c => c.name));
        expect(columns).toContain('end_line');
        expect(lineWith(await signatureText(dir), '`Widget`')).toContain('(line 1-5)');
    });
});

describe('schema migration to line ranges', () => {
    function readMeta(dir, key) {
        return withDb(dir, db => db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value ?? null);
    }

    function filledRanges(dir) {
        return withDb(dir, db => ({
            types: db.prepare('SELECT COUNT(*) AS n FROM types WHERE end_line IS NOT NULL').get().n,
            methods: db.prepare('SELECT COUNT(*) AS n FROM methods WHERE body_lines IS NOT NULL').get().n,
        }));
    }

    test('init re-parses an index declaring an older schema, fills the ranges, then goes back to incremental', async () => {
        const dir = project();
        write(dir, 'src/widget.ts', SOURCE);
        write(dir, 'src/other.ts', 'export function other(): number { return 2; }\n');
        expect((await init({ path: dir })).success).toBe(true);
        const storeBodies = readMeta(dir, 'store_bodies');

        withDb(dir, db => {
            db.exec('UPDATE types SET end_line = NULL');
            db.exec('UPDATE methods SET body_lines = NULL');
            db.prepare("UPDATE metadata SET value = '1.4' WHERE key = 'schema_version'").run();
            db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('probe_key', 'kept')").run();
        });
        expect(filledRanges(dir)).toEqual({ types: 0, methods: 0 });

        const migrated = await init({ path: dir });
        expect(migrated.success).toBe(true);
        expect(migrated.lineRangesUpgraded).toBe(true);
        expect(migrated.filesSkipped).toBe(0);
        const filled = filledRanges(dir);
        expect(filled.types).toBeGreaterThan(0);
        expect(filled.methods).toBeGreaterThan(0);
        expect(readMeta(dir, 'schema_version')).toBe(LINE_RANGES_SCHEMA);
        expect(readMeta(dir, 'probe_key')).toBe('kept');
        expect(readMeta(dir, 'store_bodies')).toBe(storeBodies);
        expect(lineWith(await signatureText(dir), '`Widget`')).toContain('(line 1-5)');

        const again = await init({ path: dir });
        expect(again.lineRangesUpgraded).toBe(false);
        expect(again.filesSkipped).toBeGreaterThan(0);
    });

    test('an interrupted run leaves an index that the next init re-parses', async () => {
        const dir = project();
        write(dir, 'src/widget.ts', SOURCE);
        expect((await init({ path: dir })).success).toBe(true);
        withDb(dir, db => {
            db.prepare("UPDATE metadata SET value = '1.4' WHERE key = 'schema_version'").run();
        });

        const opened = createDatabase(join(dir, '.aidex', 'index.db'), 'widget', dir, false);
        opened.close();

        const resumed = await init({ path: dir });
        expect(resumed.success).toBe(true);
        expect(resumed.lineRangesUpgraded).toBe(true);
        expect(readMeta(dir, 'schema_version')).toBe(LINE_RANGES_SCHEMA);
        expect(filledRanges(dir).types).toBeGreaterThan(0);
    });

    test('a complete run never lowers a newer declared schema', async () => {
        const dir = project();
        write(dir, 'src/widget.ts', SOURCE);
        expect((await init({ path: dir })).success).toBe(true);
        withDb(dir, db => {
            db.prepare("UPDATE metadata SET value = '1.6' WHERE key = 'schema_version'").run();
        });

        const rebuilt = await init({ path: dir, fresh: true });
        expect(rebuilt.success).toBe(true);
        expect(rebuilt.filesSkipped).toBe(0);
        expect(readMeta(dir, 'schema_version')).toBe('1.6');
    });

    test('init on an index already at the current schema stays incremental', async () => {
        const dir = project();
        write(dir, 'src/widget.ts', SOURCE);
        expect((await init({ path: dir })).success).toBe(true);
        expect(readMeta(dir, 'schema_version')).toBe(LINE_RANGES_SCHEMA);

        const first = await init({ path: dir });
        expect(first.lineRangesUpgraded).toBe(false);
        expect(first.filesSkipped).toBeGreaterThan(0);
    });
});
