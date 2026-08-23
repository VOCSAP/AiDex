/**
 * Real LLM module — wires up config discovery, provider, and the three
 * operations (translate / expand / rerank).
 */

import { resolveLlmCreds, type LlmCreds } from './config.js';
import { createProvider, type Provider } from './providers.js';
import { expandQuery, translateQuery } from './translate.js';
import { rerankCandidates } from './rerank.js';
import { readRerankerConfig, rerankViaEndpoint } from './reranker.js';
import { assertNoLeak, safeCandidates } from './safety.js';
import type {
    LlmContext,
    LlmModule,
    LlmStatus,
    RerankCandidate,
    RerankResult,
    TranslateResult,
} from './index.js';

class RealLlm implements LlmModule {
    /**
     * Cache of resolved creds + matching provider. We re-resolve every few
     * seconds so toggling Settings (enabled flag, key, endpoint) takes effect
     * without a process restart, while still avoiding a DB hit per call.
     */
    private cache: { creds: LlmCreds | null; provider: Provider | null; expiresAt: number } | null = null;
    private static readonly CACHE_TTL_MS = 5_000;

    private async resolve(projectPath?: string): Promise<{ creds: LlmCreds | null; provider: Provider | null }> {
        const now = Date.now();
        if (this.cache && this.cache.expiresAt > now) {
            return { creds: this.cache.creds, provider: this.cache.provider };
        }
        const creds = await resolveLlmCreds(projectPath ? { projectPath } : {});
        const provider = creds ? createProvider(creds) : null;
        this.cache = { creds, provider, expiresAt: now + RealLlm.CACHE_TTL_MS };
        return { creds, provider };
    }

    invalidate(): void {
        this.cache = null;
    }

    async status(): Promise<LlmStatus> {
        const { creds } = await this.resolve();
        if (!creds) return { available: false, backend: null, model: null, source: null };
        return {
            available: true,
            backend: creds.backend,
            model: creds.model,
            source: creds.source as LlmStatus['source'],
        };
    }

    async translate(query: string, ctx: LlmContext): Promise<TranslateResult> {
        const { provider } = await this.resolve(ctx.projectPath);
        if (!provider) return { original: query, queries: [query], invoked: false };
        const queries = await translateQuery(provider, query);
        return { original: query, queries, invoked: true };
    }

    async expand(query: string, ctx: LlmContext): Promise<TranslateResult> {
        const { provider } = await this.resolve(ctx.projectPath);
        if (!provider) return { original: query, queries: [query], invoked: false };
        const queries = await expandQuery(provider, query);
        return { original: query, queries, invoked: true };
    }

    async rerank(query: string, candidates: RerankCandidate[], ctx: LlmContext): Promise<RerankResult> {
        if (candidates.length === 0) {
            return { orderedIds: [], invoked: false };
        }

        // Dedicated cross-encoder reranker takes over the whole rerank stage
        // when enabled — the chat LLM keeps translation/expansion only.
        const reranker = readRerankerConfig();
        if (reranker && reranker.enabled) {
            const safe = safeCandidates(candidates, ctx.sendCode);
            assertNoLeak(safe, ctx.sendCode);
            try {
                const orderedIds = await rerankViaEndpoint(reranker, query, safe);
                return { orderedIds, invoked: true };
            } catch {
                // Endpoint down/misbehaving — keep the RRF-fused order rather
                // than silently paying for a second (LLM-as-judge) pass.
                return { orderedIds: candidates.map(c => c.id), invoked: false };
            }
        }

        const { provider } = await this.resolve(ctx.projectPath);
        if (!provider) {
            return { orderedIds: candidates.map(c => c.id), invoked: false };
        }
        const safe = safeCandidates(candidates, ctx.sendCode);
        const orderedIds = await rerankCandidates(provider, query, safe, ctx.sendCode);
        return { orderedIds, invoked: true };
    }
}

/**
 * Discover credentials and build a real module instance. Falls back to a
 * "stub-like" real module (returns identity results) if no backend was found —
 * that way callers still get a valid LlmModule and can call status() to learn why.
 */
export async function createRealModule(): Promise<LlmModule> {
    return new RealLlm();
}
