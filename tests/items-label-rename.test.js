/**
 * Two "items" counters carried the same word for two incomparable
 * quantities -- roadmap card 740c6f5d.
 *
 * WHY THIS EXISTS
 * `aidex_init` / CLI init / CLI rebuild-index print a SUM OF PER-FILE Sets
 * (raw case, one entry per term-file pair -- src/commands/init.ts:556/902),
 * while CLI scan / `aidex_status` / `aidex_global_init` print
 * `SELECT COUNT(*) FROM items` on a COLLATE NOCASE table (globally distinct
 * terms, case-folded -- src/db/database.ts:242). Both were rendered under
 * the literal word "Items", so a reader comparing the two outputs concluded
 * a growth/shrink that never happened (hyp_f372407c, 2026-08-13). This
 * suite pins the two now-distinct labels/keys so a future edit cannot
 * silently collapse them back onto the same word.
 *
 * Scope: text/JSON-key only. The indexing mechanism itself is untouched
 * (out of scope per card 740c6f5d) -- these tests do not re-verify counts,
 * only the words/keys the two counts are rendered under.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

import { handleToolCall } from '../build/server/tools.js';
import { isNativeAbiMismatch, nodeAbiGuardMessage, resolveAidexNode } from './helpers/node-interpreter-guard.js';

// Anchored on this file's own location, not process.cwd() -- matches the
// convention already used by tests/init-success-modes.test.js.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = join(REPO_ROOT, 'build', 'index.js');
const NODE_BIN = resolveAidexNode();

const tempDirs = [];

function makeProjectDir() {
    const dir = mkdtempSync(join(tmpdir(), 'aidex-items-label-'));
    tempDirs.push(dir);
    return dir;
}

function writeFile(dir, relPath, content) {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
}

async function safeCall(name, args) {
    try {
        return await handleToolCall(name, args);
    } catch (err) {
        if (isNativeAbiMismatch(err)) throw new Error(nodeAbiGuardMessage(err));
        throw err;
    }
}

function runCli(subcommand, projectDir) {
    const result = spawnSync(NODE_BIN, [CLI_ENTRY, subcommand, projectDir], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
    });
    if (result.error && isNativeAbiMismatch(result.error)) {
        throw new Error(nodeAbiGuardMessage(result.error));
    }
    return result;
}

afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('740c6f5d: term-file pairs vs distinct terms are labeled differently', () => {
    test('aidex_init reports "Term-file pairs" (raw case), not bare "Items"', async () => {
        const dir = makeProjectDir();
        writeFile(dir, 'a.ts', 'export function alpha() { return 1; }\n');

        const res = await safeCall('aidex_init', { path: dir });
        const text = res.content[0].text;

        expect(text).toMatch(/Term-file pairs found \(raw case\): \d+/);
        // The old collapsed wording must not resurface verbatim.
        expect(text).not.toMatch(/Items found: \d+/);
    });

    test('aidex_scan reports "Distinct terms" (case-folded), not bare "Items"', async () => {
        const dir = makeProjectDir();
        writeFile(dir, 'b.ts', 'export function beta() { return 1; }\n');
        await safeCall('aidex_init', { path: dir });

        const res = await safeCall('aidex_scan', { path: dir });
        const text = res.content[0].text;

        expect(text).toMatch(/\*\*Distinct terms \(case-folded\):\*\* \d+/);
        expect(text).not.toMatch(/\*\*Items:\*\*/);
    });

    test('aidex_status JSON exposes distinctTerms, not a bare "items" key', async () => {
        const dir = makeProjectDir();
        writeFile(dir, 'c.ts', 'export function gamma() { return 1; }\n');
        await safeCall('aidex_init', { path: dir });

        const res = await safeCall('aidex_status', { path: dir });
        const parsed = JSON.parse(res.content[0].text);

        expect(parsed.statistics).toHaveProperty('distinctTerms');
        expect(parsed.statistics).not.toHaveProperty('items');
        expect(typeof parsed.statistics.distinctTerms).toBe('number');
    });
});

// The MCP-side assertions above go through handleToolCall() in-process, which
// does NOT exercise src/index.ts's CLI printers at all -- a distinct code
// path with its own copy of the label text (verified drifted once already:
// "Term-file pairs (raw case): " on the CLI side vs "Term-file pairs found
// (raw case): " on the MCP side). The acceptance criterion for card 740c6f5d
// ("a run's last line next to aidex_status's output") names the CLI line
// specifically, so it needs its own, separately-spawned proof.
describe('740c6f5d pass 2: CLI init/scan labels are pinned by a real spawned process', () => {
    test('CLI init prints "Term-file pairs (raw case)", not bare "Items"', () => {
        const dir = makeProjectDir();
        writeFile(dir, 'd.ts', 'export function delta() { return 1; }\n');

        const res = runCli('init', dir);

        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/Term-file pairs \(raw case\): \d+/);
        expect(res.stdout).not.toMatch(/^\s*Items: \d+/m);
    });

    test('CLI scan prints "Distinct terms (case-folded)", not bare "Items"', () => {
        const dir = makeProjectDir();
        writeFile(dir, 'e.ts', 'export function epsilon() { return 1; }\n');
        runCli('init', dir);

        const res = runCli('scan', dir);

        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/Distinct terms \(case-folded\): \d+/);
        expect(res.stdout).not.toMatch(/\|\s*Items:\s*\d+/);
    });
});
