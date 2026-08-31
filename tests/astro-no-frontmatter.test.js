/**
 * .astro file with NO frontmatter fence -- classification contract.
 *
 * WHY THIS EXISTS (roadmap card a9d43516, spec_20e43cf4)
 * A `.astro` component that is a pure template (no `---` fence at all, e.g. a
 * shared layout partial or a purely presentational component) is a perfectly
 * NORMAL, officially-supported Astro file: there is nothing to index in it,
 * because AiDex only extracts symbols from the TypeScript frontmatter block.
 *
 * Today that normal case is misclassified as a FAILURE. The chain, measured
 * 2026-08-13:
 *   - extractAstroFrontmatter (src/parser/tree-sitter.ts:145..147) returns
 *     null whenever `lines[0]?.trimEnd() !== '---'` -- by design, there is no
 *     frontmatter block to extract.
 *   - parseFile (tree-sitter.ts:203..214) propagates that null unchanged.
 *   - extract (src/parser/extractor.ts:166..176) propagates it again.
 *   - indexFile in src/commands/init.ts (~799-831) then reports the file
 *     under the SAME generic message a real parse failure would get:
 *     "Unsupported file type or parse error", pushed into errors[].
 * Repro measured via the CLI:
 *   node build/index.js init <dir-with-one-fenceless-.astro>
 *     -> Warnings: 1 file(s) reported errors during indexing
 *        - pure-template.astro: Unsupported file type or parse error
 *
 * THE FIX THIS FILE PINS
 * The distinction lives in RESULT CLASSIFICATION, not in the parser: a
 * fenceless .astro file is "nothing to index, normal" and must NOT appear in
 * errors[], while a genuinely broken/truncated .astro file (opening fence
 * present, closing fence missing -- content was clearly meant to have
 * frontmatter but doesn't parse) must still be reported, through the exact
 * same generic message, because that message is shared with real failures on
 * other languages and must not be silenced globally to fix the Astro case.
 * Implemented in src/parser/tree-sitter.ts (astroHasNoFrontmatterFence, a
 * pure classification predicate reusing the existing fence rule) and
 * src/commands/init.ts (indexFile: routes the fenceless case to a new
 * `{success: true, empty: true}` outcome instead of `{success: false,
 * error: ...}`, tracked separately as InitResult.filesEmpty).
 *
 * DISTINCT from the CRLF fence bug fixed the same day in the same function
 * (astro-frontmatter-eol.test.js, commit 651f23c). That bug was about a
 * WELL-FORMED frontmatter block failing to be recognised because of a CRLF
 * checkout. This one is about a file that never had a frontmatter block to
 * begin with, and should never have been treated as a failure.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { extractAstroFrontmatter } from '../build/parser/tree-sitter.js';
import { extract } from '../build/parser/extractor.js';
import { init } from '../build/commands/init.js';
import { isNativeAbiMismatch, nodeAbiGuardMessage } from './helpers/node-interpreter-guard.js';

// ============================================================
// Fixtures
// ============================================================

// A pure-template Astro component: no frontmatter fence anywhere. Valid,
// idiomatic Astro (e.g. a presentational partial). Nothing to index.
const ASTRO_NO_FRONTMATTER = [
    '<div class="hero">',
    '  <h1>Hello world</h1>',
    '  <p>No frontmatter fence here at all.</p>',
    '</div>',
    '',
].join('\n');

// A genuinely broken Astro file: it DOES open a frontmatter block but never
// closes it. This is a real authoring mistake / truncated file, not a
// template-only component, and must keep surfacing as an error.
const ASTRO_UNCLOSED_FRONTMATTER = [
    '---',
    'const navTitle = "AstroFrontmatterProbe";',
    '<div class="probe">{navTitle}</div>',
    '',
].join('\n');

// a9d43516 review fix (blocking): a VALID frontmatter fence, but the file is
// saved with a leading UTF-8 BOM (U+FEFF). Before the review fix, this was
// silently swallowed into filesEmpty -- astroHasNoFrontmatterFence saw
// "﻿---" as lines[0], trimEnd() only trims the end, so the check
// concluded "no fence" for a file that plainly has one. This file was
// already unindexed before this whole card (BOM breaks tree-sitter parsing
// too), but it used to be VISIBLE in errors[]; going silent was a regression
// introduced by this card's own fix, not a pre-existing gap.
const ASTRO_BOM_WITH_VALID_FRONTMATTER = '﻿' + [
    '---',
    'const x = 1;',
    '---',
    '<div>{x}</div>',
    '',
].join('\n');

const tempDirs = [];

afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ============================================================
// [1] Unit level: both cases currently collapse to the same `null`, which is
// exactly why the classification cannot happen inside extractAstroFrontmatter
// itself -- the fix has to happen downstream, where the two cases are still
// distinguishable (fenceless vs opening-fence-without-closing-fence).
// ============================================================

describe('extractAstroFrontmatter cannot distinguish the two cases by itself', () => {
    test('no frontmatter fence at all returns null', () => {
        expect(extractAstroFrontmatter(ASTRO_NO_FRONTMATTER)).toBeNull();
    });

    test('opening fence without a closing fence also returns null', () => {
        expect(extractAstroFrontmatter(ASTRO_UNCLOSED_FRONTMATTER)).toBeNull();
    });
});

describe('extract still propagates null for both cases (classification lives one layer up, in init.ts)', () => {
    test('no frontmatter fence at all', () => {
        expect(extract(ASTRO_NO_FRONTMATTER, 'NoFrontmatter.astro')).toBeNull();
    });

    test('opening fence without a closing fence', () => {
        expect(extract(ASTRO_UNCLOSED_FRONTMATTER, 'Unclosed.astro')).toBeNull();
    });
});

// ============================================================
// [2] Integration: the whole chain through init(), which is what the
// operator actually sees in errors[]. THE RED TEST is the first one below.
// ============================================================

describe('init() classifies a fenceless .astro file as normal, not an error', () => {
    // THE regression this card exists for. Before the fix, errors[] contains
    // one entry: "NoFrontmatter.astro: Unsupported file type or parse error".
    test('a pure-template .astro with zero frontmatter fences produces no errors[] entry', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'aidex-astro-no-frontmatter-'));
        tempDirs.push(dir);
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'NoFrontmatter.astro'), ASTRO_NO_FRONTMATTER, 'utf-8');

        let result;
        try {
            result = await init({ path: dir, name: 'astro-no-frontmatter-probe' });
        } catch (err) {
            if (isNativeAbiMismatch(err)) throw new Error(nodeAbiGuardMessage(err));
            throw err;
        }

        expect(result.errors).toEqual([]);
        // a9d43516 review follow-up: pin the API-level field itself, not
        // just its CLI text rendering -- a silent rename of filesEmpty would
        // otherwise pass every other test in this file untouched.
        expect(result.filesEmpty).toBe(1);
    }, 60000);

    // The other branch of the acceptance criterion: a genuinely broken .astro
    // file (opening fence, no closing fence) must still be reported. Proves
    // the fix does not silence real failures while fixing the normal case.
    test('a genuinely broken .astro file (unclosed frontmatter) still produces an errors[] entry', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'aidex-astro-unclosed-'));
        tempDirs.push(dir);
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'Unclosed.astro'), ASTRO_UNCLOSED_FRONTMATTER, 'utf-8');

        let result;
        try {
            result = await init({ path: dir, name: 'astro-unclosed-probe' });
        } catch (err) {
            if (isNativeAbiMismatch(err)) throw new Error(nodeAbiGuardMessage(err));
            throw err;
        }

        expect(result.errors.length).toBe(1);
        expect(result.errors[0]).toContain('Unclosed.astro');
        expect(result.errors[0]).toContain('Unsupported file type or parse error');
    }, 60000);

    // Both cases in the SAME run: proves the fix does not swallow a genuine
    // error just because a normal fenceless file is also present.
    test('mixed run: fenceless file is silent, broken file still errors', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'aidex-astro-mixed-'));
        tempDirs.push(dir);
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'NoFrontmatter.astro'), ASTRO_NO_FRONTMATTER, 'utf-8');
        writeFileSync(join(dir, 'src', 'Unclosed.astro'), ASTRO_UNCLOSED_FRONTMATTER, 'utf-8');

        let result;
        try {
            result = await init({ path: dir, name: 'astro-mixed-probe' });
        } catch (err) {
            if (isNativeAbiMismatch(err)) throw new Error(nodeAbiGuardMessage(err));
            throw err;
        }

        expect(result.errors.length).toBe(1);
        expect(result.errors[0]).toContain('Unclosed.astro');
    }, 60000);

    // a9d43516 review fix (blocking, caught before commit): a VALID
    // frontmatter fence hidden behind a leading UTF-8 BOM must NOT be
    // reclassified as "nothing to index" -- this is neither a pure-template
    // component nor already-indexable, it is a fourth state the card did not
    // originally anticipate. It must stay VISIBLE in errors[], exactly as it
    // was before this whole card, and must NOT be counted in filesEmpty.
    test('a .astro with a leading UTF-8 BOM and a VALID frontmatter fence still produces an errors[] entry, and is not counted as empty', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'aidex-astro-bom-'));
        tempDirs.push(dir);
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'Bom.astro'), ASTRO_BOM_WITH_VALID_FRONTMATTER, 'utf-8');

        let result;
        try {
            result = await init({ path: dir, name: 'astro-bom-probe' });
        } catch (err) {
            if (isNativeAbiMismatch(err)) throw new Error(nodeAbiGuardMessage(err));
            throw err;
        }

        expect(result.errors.length).toBe(1);
        expect(result.errors[0]).toContain('Bom.astro');
        expect(result.errors[0]).toContain('Unsupported file type or parse error');
        expect(result.filesEmpty ?? 0).toBe(0);
    }, 60000);
});
