/**
 * The CLI `init` announces a forced full re-parse -- spec_a0673900.
 *
 * Spawns `node build/index.js init <dir>` as a real child process on indexes
 * fabricated at an older declaration, and asserts on its stdout.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { jest, describe, test, afterEach, expect } from '@jest/globals';
import Database from 'better-sqlite3';

import { init, LINE_RANGES_SCHEMA } from '../build/commands/init.js';
import { resolveAidexNode } from './helpers/node-interpreter-guard.js';

jest.setTimeout(60000);

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, 'build', 'index.js');
const NODE_BIN = resolveAidexNode();

const SCHEMA_LINE = `Schema migrated: the index declared a schema older than ${LINE_RANGES_SCHEMA}`;
const LITERAL_LINE = 'Literal coverage migrated: the index did not declare it';

const tempDirs = [];

afterEach(() => {
    while (tempDirs.length) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

async function indexedProject() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-cli-init-migration-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'widget.ts'), 'export function widget(): number { return 1; }\n', 'utf-8');
    expect((await init({ path: dir })).success).toBe(true);
    return dir;
}

function declare(dir, version, dropLiteralRecord = false) {
    const db = new Database(join(dir, '.aidex', 'index.db'));
    try {
        db.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run(version);
        if (dropLiteralRecord) db.prepare("DELETE FROM metadata WHERE key = 'literal_coverage'").run();
    } finally {
        db.close();
    }
}

function cliInit(dir) {
    const r = spawnSync(NODE_BIN, [CLI_ENTRY, 'init', dir], { encoding: 'utf-8', timeout: 60000 });
    expect(r.status).toBe(0);
    return r.stdout;
}

describe('CLI init migration announcements', () => {
    test('an index declaring an older schema is announced as re-parsed', async () => {
        const dir = await indexedProject();
        declare(dir, '1.4');

        const out = cliInit(dir);
        expect(out).toContain(SCHEMA_LINE);
        expect(out).not.toContain(LITERAL_LINE);
    });

    test('an index missing literal coverage announces both migrations', async () => {
        const dir = await indexedProject();
        declare(dir, '1.2', true);

        const out = cliInit(dir);
        expect(out).toContain(LITERAL_LINE);
        expect(out).toContain(SCHEMA_LINE);
    });

    test('a current index announces nothing', async () => {
        const dir = await indexedProject();

        const out = cliInit(dir);
        expect(out).not.toContain(SCHEMA_LINE);
        expect(out).not.toContain(LITERAL_LINE);
    });
});
