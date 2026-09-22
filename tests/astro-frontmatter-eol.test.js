/**
 * .astro frontmatter fence scan -- EOL and trailing-whitespace contract.
 *
 * WHY THIS EXISTS
 * `.astro` support (upstream commit 31d478c) shipped with ZERO tests. That is
 * not incidental to the defect this file pins, it IS the reason the defect
 * lived: the suite stayed green while every single .astro file on a Windows
 * working tree failed to index.
 *
 * THE DEFECT (hyp_7d7728d9, measured 2026-08-13)
 * extractAstroFrontmatter matched its two fences with two DIFFERENT rules:
 *   - opening fence: `lines[0]?.trimEnd() === '---'`  -> tolerated a trailing CR
 *   - closing fence: `lines.indexOf('---', 1)`        -> exact array equality,
 *                                                        never matches '---\r'
 * `source.split('\n')` leaves a trailing '\r' on every line of a CRLF file.
 * git stores these blobs in LF; a Windows checkout with core.autocrlf=true
 * materialises them as CRLF (`git ls-files --eol` -> `i/lf  w/crlf`). So the
 * OPENING fence passed and the CLOSING fence never matched: closeIdx === -1,
 * return null, parseFile returns null, extract returns null, and init.ts
 * reports "Unsupported file type or parse error" on a perfectly well-formed,
 * officially supported file. Measured: 31 of 31 .astro files of the cocoindex
 * corpus, 30 of them surfaced as errors[] entries by a "successful" init.
 *
 * THE FIX, and the decision this file FREEZES
 * Both fences now use the same rule: `trimEnd() === '---'`. That is a
 * deliberate widening on the closing fence -- it now also accepts '---   '
 * with trailing spaces, which the strict indexOf refused. It is intentional,
 * by symmetry with the opening fence, which has tolerated exactly that since
 * the feature shipped. The 'trailing whitespace' cases below exist so nobody
 * reverts that half believing they are tightening a laxity.
 *
 * `trimEnd()` and NOT `trim()`: the fence stays anchored at column 0. This is a
 * conservative INDEXER choice, deliberately STRICTER than the Astro grammar --
 * it is not a restatement of what Astro accepts, and the cases below pin our
 * rule, not the grammar's. Do not "fix" them against a reading of the spec.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { extractAstroFrontmatter, parseFile } from '../build/parser/tree-sitter.js';
import { extract } from '../build/parser/extractor.js';
import { init } from '../build/commands/init.js';
import { isNativeAbiMismatch, nodeAbiGuardMessage } from './helpers/node-interpreter-guard.js';

// ============================================================
// Fixture: one source, two line endings. The ONLY difference between the
// two variants under test is the EOL, which is what makes any divergence
// below attributable to the EOL and nothing else.
// ============================================================

const ASTRO_LF = [
    '---',
    'import Sidebar from "./Sidebar.astro";',
    'const navTitle = "AstroFrontmatterProbe";',
    'export interface AstroProbeProps { navTitle: string; }',
    '---',
    '<div class="probe">{navTitle}</div>',
    '<Sidebar />',
    '',
].join('\n');

const toCrlf = (s) => s.split('\n').join('\r\n');
const ASTRO_CRLF = toCrlf(ASTRO_LF);

const tempDirs = [];

afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ============================================================
// [1] The regression itself: same source, two EOLs, same outcome
// ============================================================

describe('extractAstroFrontmatter is EOL-agnostic', () => {
    test('LF source yields frontmatter', () => {
        expect(extractAstroFrontmatter(ASTRO_LF)).not.toBeNull();
    });

    // THE regression. Before the fix this returned null.
    test('CRLF source yields frontmatter', () => {
        expect(extractAstroFrontmatter(ASTRO_CRLF)).not.toBeNull();
    });

    test('both EOLs yield the same frontmatter once CR is normalised', () => {
        const lf = extractAstroFrontmatter(ASTRO_LF);
        const crlf = extractAstroFrontmatter(ASTRO_CRLF);
        expect(crlf.split('\r').join('')).toBe(lf);
    });

    test('CRLF frontmatter still preserves line numbers (fences and template blanked)', () => {
        const lines = extractAstroFrontmatter(ASTRO_CRLF).split('\n');
        // Same line count as the source: the blank-out keeps positions.
        expect(lines.length).toBe(ASTRO_CRLF.split('\n').length);
        expect(lines[0]).toBe('');                                  // opening fence blanked
        expect(lines[1]).toContain('import Sidebar');               // frontmatter kept in place
        expect(lines[4]).toBe('');                                  // closing fence blanked
        expect(lines[5]).toBe('');                                  // template blanked
    });
});

// ============================================================
// [2] The whole downstream chain, which is what production actually hit:
// extractAstroFrontmatter -> parseFile -> extract -> init's errors[]
// ============================================================

describe('CRLF .astro flows through the whole parse chain', () => {
    test('parseFile returns a tree for both EOLs', () => {
        expect(parseFile(ASTRO_LF, 'Probe.astro')).not.toBeNull();
        expect(parseFile(ASTRO_CRLF, 'Probe.astro')).not.toBeNull();
    });

    // Asserted as one object keyed by EOL rather than inside the loop, so a
    // failure names WHICH line ending broke instead of just "expected true".
    test('extract returns a result for both EOLs, with the frontmatter symbols', () => {
        const sawNavTitle = {};
        for (const [label, src] of [['LF', ASTRO_LF], ['CRLF', ASTRO_CRLF]]) {
            const result = extract(src, 'Probe.astro');
            sawNavTitle[label] = result !== null
                && result.items.length > 0
                && result.items.map((i) => i.term.toLowerCase()).includes('navtitle');
        }
        expect(sawNavTitle).toEqual({ LF: true, CRLF: true });
    });
});

// ============================================================
// [3] The widening this fix introduces, frozen on purpose.
// The closing fence now accepts trailing whitespace, exactly like the
// opening fence already did. Do not "tighten" this back.
// ============================================================

describe('fence matching tolerates trailing whitespace on BOTH fences (deliberate)', () => {
    test('trailing spaces on the closing fence are accepted', () => {
        const src = '---\nconst a = 1;\n---   \n<p />\n';
        expect(extractAstroFrontmatter(src)).not.toBeNull();
    });

    test('trailing spaces on the opening fence are accepted (pre-existing behaviour)', () => {
        const src = '---  \nconst a = 1;\n---\n<p />\n';
        expect(extractAstroFrontmatter(src)).not.toBeNull();
    });

    test('trailing tab on the closing fence is accepted', () => {
        const src = '---\nconst a = 1;\n---\t\n<p />\n';
        expect(extractAstroFrontmatter(src)).not.toBeNull();
    });

    // trimEnd(), NOT trim(): OUR fence stays anchored at column 0. Pinned in
    // both directions so a future edit cannot slide `trimEnd` into `trim`.
    // These two cases pin AiDex's rule, which is stricter than the Astro
    // grammar on purpose. They are not a claim about what Astro accepts.
    test('an INDENTED closing fence is rejected (stricter than Astro, deliberate)', () => {
        const src = '---\nconst a = 1;\n   ---\n<p />\n';
        expect(extractAstroFrontmatter(src)).toBeNull();
    });

    test('an INDENTED opening fence is rejected (stricter than Astro, deliberate)', () => {
        const src = '   ---\nconst a = 1;\n---\n<p />\n';
        expect(extractAstroFrontmatter(src)).toBeNull();
    });
});

// ============================================================
// [4] Negative cases, unchanged by the fix -- pinned so a future widening
// of the fence scan cannot swallow them silently.
// ============================================================

describe('genuinely fenceless sources still return null', () => {
    test('no opening fence', () => {
        expect(extractAstroFrontmatter('<div>template only</div>\n')).toBeNull();
    });

    test('opening fence but no closing fence, LF', () => {
        expect(extractAstroFrontmatter('---\nconst a = 1;\n<p />\n')).toBeNull();
    });

    test('opening fence but no closing fence, CRLF', () => {
        expect(extractAstroFrontmatter(toCrlf('---\nconst a = 1;\n<p />\n'))).toBeNull();
    });

    test('empty source', () => {
        expect(extractAstroFrontmatter('')).toBeNull();
    });
});

// ============================================================
// [5] Integration: a real CRLF .astro file on disk, indexed by init().
// This is the shape production hit -- the unit cases above prove the fence
// scan, this one proves nothing downstream re-breaks it, and that errors[]
// stays empty (the bloc that surfaced the defect in the first place).
// ============================================================

describe('init() indexes a CRLF .astro file without filling errors[]', () => {
    test('errors[] is empty and the file is counted as indexed', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'aidex-astro-eol-'));
        tempDirs.push(dir);
        mkdirSync(join(dir, 'src'), { recursive: true });
        // Written byte-for-byte as CRLF, which is what core.autocrlf=true
        // materialises on this platform.
        writeFileSync(join(dir, 'src', 'Probe.astro'), ASTRO_CRLF, 'utf-8');

        let result;
        try {
            result = await init({ path: dir, name: 'astro-eol-probe' });
        } catch (err) {
            if (isNativeAbiMismatch(err)) throw new Error(nodeAbiGuardMessage(err));
            throw err;
        }

        expect(result.errors).toEqual([]);
        expect(result.filesIndexed).toBeGreaterThanOrEqual(1);
        expect(result.itemsFound).toBeGreaterThan(0);
    }, 60000);
});
