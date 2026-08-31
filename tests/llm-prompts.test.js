/**
 * Tests for the LLM prompt registry (src/llm/prompts.ts).
 *
 * The four system prompts of the LLM layer (translate / expand /
 * rerank full / rerank metadata) can be overridden per-station via
 * ~/.aidex/llm-prompts.json. Contract under test:
 *   - no file            → defaults, nothing overridden
 *   - partial overrides  → only listed keys replaced, rest keeps default
 *   - malformed file     → defaults + parseError flag (never a throw)
 *   - empty / oversized  → ignored, default kept
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { DEFAULT_PROMPTS, loadLlmPrompts } from '../build/llm/prompts.js';

describe('loadLlmPrompts', () => {
    let dir;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'aidex-llm-prompts-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const fileIn = (content) => {
        const path = join(dir, 'llm-prompts.json');
        writeFileSync(path, content, 'utf-8');
        return path;
    };

    test('missing file → defaults, no overrides, no parseError', () => {
        const res = loadLlmPrompts(join(dir, 'does-not-exist.json'));
        expect(res.prompts).toEqual(DEFAULT_PROMPTS);
        expect(res.overridden).toEqual([]);
        expect(res.parseError).toBe(false);
    });

    test('partial override replaces only the given keys', () => {
        const path = fileIn(JSON.stringify({
            translate_system: 'Réponds en JSON strict: {"queries": [...]}',
        }));
        const res = loadLlmPrompts(path);
        expect(res.prompts.translateSystem).toBe('Réponds en JSON strict: {"queries": [...]}');
        expect(res.prompts.expandSystem).toBe(DEFAULT_PROMPTS.expandSystem);
        expect(res.prompts.rerankSystemFull).toBe(DEFAULT_PROMPTS.rerankSystemFull);
        expect(res.prompts.rerankSystemMetadata).toBe(DEFAULT_PROMPTS.rerankSystemMetadata);
        expect(res.overridden).toEqual(['translate_system']);
        expect(res.parseError).toBe(false);
    });

    test('all four keys override', () => {
        const path = fileIn(JSON.stringify({
            translate_system: 't',
            expand_system: 'e',
            rerank_system_full: 'rf',
            rerank_system_metadata: 'rm',
        }));
        const res = loadLlmPrompts(path);
        expect(res.prompts.translateSystem).toBe('t');
        expect(res.prompts.expandSystem).toBe('e');
        expect(res.prompts.rerankSystemFull).toBe('rf');
        expect(res.prompts.rerankSystemMetadata).toBe('rm');
        expect(res.overridden.sort()).toEqual([
            'expand_system', 'rerank_system_full', 'rerank_system_metadata', 'translate_system',
        ]);
    });

    test('malformed JSON → defaults + parseError, no throw', () => {
        const res = loadLlmPrompts(fileIn('{ not json'));
        expect(res.prompts).toEqual(DEFAULT_PROMPTS);
        expect(res.overridden).toEqual([]);
        expect(res.parseError).toBe(true);
    });

    test('JSON array instead of object → parseError', () => {
        const res = loadLlmPrompts(fileIn('["translate_system"]'));
        expect(res.prompts).toEqual(DEFAULT_PROMPTS);
        expect(res.parseError).toBe(true);
    });

    test('empty, non-string, oversized and unknown values are ignored', () => {
        const path = fileIn(JSON.stringify({
            translate_system: '   ',              // whitespace-only → ignored
            expand_system: 42,                    // non-string → ignored
            rerank_system_full: 'x'.repeat(9000), // over 8192 → ignored
            unknown_key: 'whatever',              // unknown → ignored
        }));
        const res = loadLlmPrompts(path);
        expect(res.prompts).toEqual(DEFAULT_PROMPTS);
        expect(res.overridden).toEqual([]);
        expect(res.parseError).toBe(false);
    });

    test('override value is trimmed', () => {
        const res = loadLlmPrompts(fileIn(JSON.stringify({ expand_system: '  padded  ' })));
        expect(res.prompts.expandSystem).toBe('padded');
        expect(res.overridden).toEqual(['expand_system']);
    });
});
