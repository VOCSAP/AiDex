import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterAll, describe, expect, test } from '@jest/globals';

import * as config from '../build/llm/config.js';
import { resolveAidexNode } from './helpers/node-interpreter-guard.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE_BIN = resolveAidexNode();
const MAX_EMBEDDING_TIMEOUT_MINUTES = 2_147_483_647 / 60_000;
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
    const dir = tempDir('aidex-embedding-timeout-project-');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'widget.ts'), 'export const widget = 1;\n', 'utf-8');
    return dir;
}

describe('embedding timeout configuration', () => {
    test('uses a positive configured minute value and defaults invalid values to ten minutes', () => {
        const resolve = config.resolveEmbeddingTimeoutMinutes;

        expect(resolve({ embedding_timeout_minutes: 2.5 })).toBe(2.5);
        expect(resolve({ embedding_timeout_minutes: 'later' })).toBe(10);
        expect(resolve({ embedding_timeout_minutes: 0 })).toBe(10);
        expect(resolve({ embedding_timeout_minutes: -1 })).toBe(10);
        expect(resolve(null)).toBe(10);
    });

    test('clamps configured and submitted values above Node timer capacity', async () => {
        const aboveMaximum = MAX_EMBEDDING_TIMEOUT_MINUTES + 1;
        expect(config.resolveEmbeddingTimeoutMinutes({ embedding_timeout_minutes: aboveMaximum })).toBe(MAX_EMBEDDING_TIMEOUT_MINUTES);

        const { validateSetSettingsPayload } = await import('../build/llm/settings.js');
        expect(validateSetSettingsPayload({ embeddingTimeoutMinutes: aboveMaximum })).toEqual({
            embeddingTimeoutMinutes: MAX_EMBEDDING_TIMEOUT_MINUTES,
        });
    });

    test('allows an injected worker to complete at the maximum Node timer capacity', () => {
        const home = tempDir('aidex-embedding-timeout-max-home-');
        mkdirSync(join(home, '.aidex'), { recursive: true });
        writeFileSync(
            join(home, '.aidex', 'llm.json'),
            JSON.stringify({ embedding_timeout_minutes: MAX_EMBEDDING_TIMEOUT_MINUTES + 1 }),
            'utf-8'
        );

        const script = join(tempDir('aidex-embedding-timeout-max-probe-'), 'probe.mjs');
        const initUrl = pathToFileURL(join(REPO_ROOT, 'build', 'commands', 'init.js')).href;
        const workerPath = join(REPO_ROOT, 'tests', 'fixtures', 'delayed-success-embed-worker.mjs');
        writeFileSync(script, [
            `import { indexProjectInWorker } from ${JSON.stringify(initUrl)};`,
            `const result = await indexProjectInWorker(${JSON.stringify(project())}, false, ${JSON.stringify(workerPath)});`,
            'console.log(JSON.stringify(result));',
        ].join('\n'), 'utf-8');

        const result = spawnSync(NODE_BIN, [script], {
            encoding: 'utf-8',
            timeout: 5000,
            env: { ...process.env, HOME: home, USERPROFILE: home },
        });

        expect(result.stderr).not.toContain('TimeoutOverflowWarning');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ embedded: 1, skipped: 0, removed: 0, durationMs: 50 });
    });

    test('applies the configured deadline to an injected embedding worker', () => {
        const home = tempDir('aidex-embedding-timeout-home-');
        mkdirSync(join(home, '.aidex'), { recursive: true });
        writeFileSync(
            join(home, '.aidex', 'llm.json'),
            JSON.stringify({ embedding_timeout_minutes: 0.001 }),
            'utf-8'
        );

        const script = join(tempDir('aidex-embedding-timeout-probe-'), 'probe.mjs');
        const initUrl = pathToFileURL(join(REPO_ROOT, 'build', 'commands', 'init.js')).href;
        const workerPath = join(REPO_ROOT, 'tests', 'fixtures', 'sleeping-embed-worker.mjs');
        writeFileSync(script, [
            `import { indexProjectInWorker } from ${JSON.stringify(initUrl)};`,
            `try { await indexProjectInWorker(${JSON.stringify(project())}, false, ${JSON.stringify(workerPath)}); process.exitCode = 1; }`,
            "catch (error) { console.error(error instanceof Error ? error.message : String(error)); }",
        ].join('\n'), 'utf-8');

        const result = spawnSync(NODE_BIN, [script], {
            encoding: 'utf-8',
            timeout: 5000,
            env: { ...process.env, HOME: home, USERPROFILE: home },
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toContain('Embedding timed out after 0.001 minutes');
        expect(result.stderr).toContain('embedding_timeout_minutes');
    });
});
