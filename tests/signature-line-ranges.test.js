/**
 * Line ranges in aidex_signature / aidex_signatures -- spec_f4fd3132.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

import { afterEach, describe, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';

import { init } from '../build/commands/init.js';
import { update } from '../build/commands/update.js';
import { handleToolCall } from '../build/server/tools.js';

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
