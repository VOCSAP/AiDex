/**
 * Dedicated reranker backend — cross-encoder scoring over HTTP.
 *
 * Alternative to LLM-as-judge reranking (rerank.ts): instead of prompting a
 * chat model to emit an ordering, POST the query + candidate documents to a
 * rerank API and sort by the returned relevance scores. Compatible with the
 * Cohere-style contract served by LiteLLM (`/rerank`, `/v1/rerank`),
 * llama.cpp server (`/v1/rerank`) and Jina, plus the TEI bare-array variant.
 *
 * Request:  POST <endpoint>  { model?, query, documents: string[], top_n }
 * Response: { results: [{ index, relevance_score }] }  — Cohere/LiteLLM/llama.cpp
 *           [{ index, score }]                          — TEI
 *
 * Configured in ~/.aidex/llm.json under the `reranker` key (Settings tab →
 * "Use a dedicated reranker"). When enabled it REPLACES the LLM-as-judge
 * pass in the pipeline; the chat LLM keeps translation/expansion. On any
 * failure the caller keeps the RRF-fused order — the reranker never breaks
 * a search.
 *
 * Privacy: documents are built from SafeCandidate, so the per-project
 * `llm_send_code` switch applies exactly as it does for LLM reranking —
 * snippets are only included when the switch is on.
 */

import type { SafeCandidate } from './safety.js';
import { readLlmConfigFile } from './config.js';

export interface RerankerConfig {
    enabled: boolean;
    endpoint: string;
    model: string | null;
    apiKey: string | null;
}

/** Read the reranker block of ~/.aidex/llm.json. Null when absent/unusable. */
export function readRerankerConfig(): RerankerConfig | null {
    const file = readLlmConfigFile();
    const r = file?.reranker;
    if (!r || typeof r !== 'object') return null;
    const endpoint = typeof r.endpoint === 'string' ? r.endpoint.trim() : '';
    if (!endpoint) return null;
    return {
        enabled: r.enabled === true,
        endpoint,
        model: (typeof r.model === 'string' && r.model.trim()) || null,
        apiKey: (typeof r.api_key === 'string' && r.api_key.trim()) || null,
    };
}

/**
 * Render one candidate as the document string the cross-encoder scores.
 * Metadata-only unless a snippet survived the safety filter (sendCode=true).
 */
export function candidateDocument(c: SafeCandidate): string {
    const head = [c.sourceKind, c.sourceType].filter(Boolean).join('/');
    const name = c.name ?? c.anchor ?? '';
    const loc = c.path ? `${c.path}${c.line != null ? ':' + c.line : ''}` : '';
    const parts = [head, name, loc].filter(s => s.length > 0);
    let doc = parts.join(' — ');
    if (c.snippet) doc += '\n' + c.snippet;
    return doc.length > 0 ? doc : c.id;
}

const TIMEOUT_MS = 10_000;

/**
 * Score candidates against the query via the configured endpoint and return
 * candidate ids best-first. Ids the API didn't score (or dropped) are
 * appended in their original order — same never-drop contract as the
 * LLM-as-judge parser. Throws on HTTP/parse/timeout failure; the caller
 * decides the fallback.
 */
export async function rerankViaEndpoint(
    cfg: RerankerConfig,
    query: string,
    candidates: SafeCandidate[]
): Promise<string[]> {
    if (candidates.length === 0) return [];

    const documents = candidates.map(candidateDocument);
    const body: Record<string, unknown> = {
        query,
        documents,
        top_n: documents.length,
    };
    if (cfg.model) body.model = cfg.model;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
        res = await fetch(cfg.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`reranker HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }

    const scores = parseScores(await res.json(), candidates.length);
    if (!scores) throw new Error('reranker returned no parsable scores');

    scores.sort((a, b) => b.score - a.score);
    const ordered: string[] = [];
    const seen = new Set<number>();
    for (const { index } of scores) {
        if (seen.has(index)) continue;
        seen.add(index);
        ordered.push(candidates[index].id);
    }
    // Never drop a candidate the API forgot — append in original order.
    candidates.forEach((c, i) => {
        if (!seen.has(i)) ordered.push(c.id);
    });
    return ordered;
}

/** Accepts {results:[...]}, {data:[...]} or a bare array of {index, relevance_score|score}. */
function parseScores(
    payload: unknown,
    count: number
): Array<{ index: number; score: number }> | null {
    let list: unknown = null;
    if (Array.isArray(payload)) {
        list = payload;
    } else if (payload && typeof payload === 'object') {
        const obj = payload as Record<string, unknown>;
        if (Array.isArray(obj.results)) list = obj.results;
        else if (Array.isArray(obj.data)) list = obj.data;
    }
    if (!Array.isArray(list)) return null;

    const out: Array<{ index: number; score: number }> = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const index = rec.index;
        const score = typeof rec.relevance_score === 'number' ? rec.relevance_score
            : typeof rec.score === 'number' ? rec.score
            : null;
        if (typeof index !== 'number' || !Number.isInteger(index)) continue;
        if (index < 0 || index >= count) continue;
        if (score === null) continue;
        out.push({ index, score });
    }
    return out.length > 0 ? out : null;
}
