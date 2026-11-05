/**
 * Prompt registry for the LLM layer — defaults + per-station overrides.
 *
 * The four system prompts used by translate / expand / rerank live here.
 * Each one can be overridden in ~/.aidex/llm-prompts.json, so the operator
 * can experiment with phrasings that work better for the configured model
 * (small local models are sensitive to prompt wording):
 *
 *   {
 *     "translate_system": "...",
 *     "expand_system": "...",
 *     "rerank_system_full": "...",
 *     "rerank_system_metadata": "..."
 *   }
 *
 * Only keys present as non-empty strings override; every other prompt keeps
 * its default. A missing or malformed file silently falls back to defaults —
 * the resolved state (which keys are overridden, parse errors) is exposed in
 * aidex_settings under llm.prompts so a typo'd file is visible, not silent.
 *
 * The USER message of each call is data, not prose (the raw query for
 * translate/expand, a JSON {query, items} payload for rerank). It is not
 * overridable: the response parsers depend on its structure.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface LlmPrompts {
    translateSystem: string;
    expandSystem: string;
    rerankSystemFull: string;
    rerankSystemMetadata: string;
}

/** JSON keys of the override file, mapped to LlmPrompts fields. */
const FILE_KEYS: Array<{ fileKey: string; field: keyof LlmPrompts }> = [
    { fileKey: 'translate_system',        field: 'translateSystem' },
    { fileKey: 'expand_system',           field: 'expandSystem' },
    { fileKey: 'rerank_system_full',      field: 'rerankSystemFull' },
    { fileKey: 'rerank_system_metadata',  field: 'rerankSystemMetadata' },
];

const MAX_PROMPT_LEN = 8192;

export const DEFAULT_PROMPTS: LlmPrompts = {
    translateSystem: `You translate code-search queries into English.
Output STRICT JSON with this shape: {"queries": ["...", "..."]}.
Rules:
- Up to 3 queries, lowercase, English.
- Keep the original meaning, prefer short phrases (3-8 words).
- If the input is already a clean English search phrase, return just one item.
- No prose, no code fences, no commentary — just the JSON.`,

    expandSystem: `You expand a vague code-search query into concrete English search phrases.
Output STRICT JSON: {"queries": ["...", "..."]}.
Rules:
- 2 to 4 phrases, complementary not redundant.
- Each phrase 3-10 words, English, lowercase.
- Concrete: include likely identifier-style words ("retry backoff exponential" beats "how to retry").
- No prose, no code fences.`,

    rerankSystemFull: `You rerank code-search results by relevance to the user's query.
You see snippets, names, paths.
Output STRICT JSON: {"order": ["id1", "id2", ...]}.
Rules:
- Best match first.
- Include only the ids that are actually relevant — drop noise.
- IDs are exactly the strings provided in the input items.
- No commentary.`,

    rerankSystemMetadata: `You rerank code-search results by relevance using ONLY metadata.
You will NOT see source code, doc bodies, or task descriptions — by user policy.
You see: kind, type, name, anchor, path, line.
Output STRICT JSON: {"order": ["id1", "id2", ...]}.
Rules:
- Lean on names, anchors, and paths to judge relevance.
- Best match first; drop irrelevant items.
- IDs are exactly the strings provided in the input items.
- No commentary.`,
};

export interface LoadedPrompts {
    prompts: LlmPrompts;
    /** File keys (snake_case) that actually overrode a default. */
    overridden: string[];
    /** True when the file exists but could not be parsed as a JSON object. */
    parseError: boolean;
}

export function llmPromptsPath(): string {
    return join(homedir(), '.aidex', 'llm-prompts.json');
}

/**
 * Load prompts, applying overrides from the file when present.
 *
 * @param path Override file location — defaults to ~/.aidex/llm-prompts.json.
 *             Parameterized for tests.
 */
export function loadLlmPrompts(path: string = llmPromptsPath()): LoadedPrompts {
    const prompts: LlmPrompts = { ...DEFAULT_PROMPTS };
    const overridden: string[] = [];

    if (!existsSync(path)) {
        return { prompts, overridden, parseError: false };
    }

    let data: unknown;
    try {
        data = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        return { prompts, overridden, parseError: true };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { prompts, overridden, parseError: true };
    }

    const src = data as Record<string, unknown>;
    for (const { fileKey, field } of FILE_KEYS) {
        const val = src[fileKey];
        if (typeof val !== 'string') continue;
        const trimmed = val.trim();
        if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_LEN) continue;
        prompts[field] = trimmed;
        overridden.push(fileKey);
    }

    return { prompts, overridden, parseError: false };
}
