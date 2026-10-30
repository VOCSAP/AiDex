/**
 * Translate / normalize — turn an arbitrary user query into 1-3 English search
 * queries optimized for the embedding model.
 *
 * Examples:
 *   "wie speichere ich Logs lokal" → ["save logs locally", "log persistence"]
 *   "how do we cache the model"     → ["how do we cache the model"]
 *   "schneller als grep"            → ["faster than grep", "grep alternative"]
 *
 * The LLM only ever sees the query — never code/docs.
 */

import type { Provider } from './providers.js';
import { loadLlmPrompts } from './prompts.js';

export async function translateQuery(provider: Provider, query: string): Promise<string[]> {
    try {
        const res = await provider.call({
            system: loadLlmPrompts().prompts.translateSystem,
            user: query,
            maxTokens: 200,
            temperature: 0.1,
        });
        const queries = parseQueries(res.text);
        if (queries.length === 0) return [query];
        return queries.slice(0, 3);
    } catch {
        // Provider failure — fall back to identity. Search still works.
        return [query];
    }
}

export async function expandQuery(provider: Provider, query: string): Promise<string[]> {
    try {
        const res = await provider.call({
            system: loadLlmPrompts().prompts.expandSystem,
            user: query,
            maxTokens: 250,
            temperature: 0.2,
        });
        const queries = parseQueries(res.text);
        if (queries.length === 0) return [query];
        return queries.slice(0, 4);
    } catch {
        return [query];
    }
}

function parseQueries(text: string): string[] {
    if (!text) return [];
    const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
        const obj = JSON.parse(trimmed) as { queries?: unknown };
        if (Array.isArray(obj.queries)) {
            return obj.queries
                .filter((q): q is string => typeof q === 'string')
                .map(s => s.trim())
                .filter(s => s.length > 0);
        }
    } catch {
        // Some models return bare arrays — try that fallback.
        try {
            const obj = JSON.parse(trimmed) as unknown;
            if (Array.isArray(obj)) {
                return obj.filter((q): q is string => typeof q === 'string').map(s => s.trim());
            }
        } catch { /* fall through */ }
    }
    // Last resort: lines starting with "-" or "1)" etc.
    return trimmed
        .split('\n')
        .map(l => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(l => l.length > 2);
}
