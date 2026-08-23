/**
 * Tests for the dedicated reranker backend (src/llm/reranker.ts).
 *
 * rerankViaEndpoint POSTs {model?, query, documents, top_n} to a rerank
 * API and returns candidate ids best-first. Contract under test:
 *   - Cohere/LiteLLM shape {results:[{index, relevance_score}]} → order by score
 *   - TEI bare-array shape [{index, score}] → same
 *   - indices the API skipped are appended in original order (never drop)
 *   - out-of-range / duplicate indices are ignored
 *   - Bearer header sent iff apiKey configured; model passed through
 *   - HTTP error or unparsable body → throws (caller falls back)
 */

import { createServer } from 'http';

import { rerankViaEndpoint, candidateDocument } from '../build/llm/reranker.js';

const CANDIDATES = [
    { id: 'a', sourceKind: 'code', sourceType: 'method', name: 'login', anchor: null, path: 'src/auth.ts', line: 10 },
    { id: 'b', sourceKind: 'code', sourceType: 'method', name: 'logout', anchor: null, path: 'src/auth.ts', line: 30 },
    { id: 'c', sourceKind: 'docs', sourceType: 'section', name: null, anchor: 'auth-setup', path: 'README.md', line: 5 },
];

/** Spin a one-shot HTTP server; returns { url, lastRequest, close }. */
function serve(handler) {
    const state = { lastRequest: null };
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            state.lastRequest = { headers: req.headers, body: body ? JSON.parse(body) : null };
            handler(res);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}/rerank`,
                state,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

const json = (payload) => (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
};

const cfg = (endpoint, extra = {}) => ({ enabled: true, endpoint, model: null, apiKey: null, ...extra });

describe('rerankViaEndpoint', () => {
    test('Cohere/LiteLLM shape → ordered by relevance_score desc', async () => {
        const srv = await serve(json({
            results: [
                { index: 0, relevance_score: 0.2 },
                { index: 1, relevance_score: 0.9 },
                { index: 2, relevance_score: 0.5 },
            ],
        }));
        try {
            const order = await rerankViaEndpoint(cfg(srv.url), 'auth', CANDIDATES);
            expect(order).toEqual(['b', 'c', 'a']);
        } finally {
            await srv.close();
        }
    });

    test('TEI bare-array shape with score field', async () => {
        const srv = await serve(json([
            { index: 2, score: 0.99 },
            { index: 0, score: 0.1 },
            { index: 1, score: 0.4 },
        ]));
        try {
            const order = await rerankViaEndpoint(cfg(srv.url), 'auth', CANDIDATES);
            expect(order).toEqual(['c', 'b', 'a']);
        } finally {
            await srv.close();
        }
    });

    test('missing indices appended in original order; bad indices ignored', async () => {
        const srv = await serve(json({
            results: [
                { index: 1, relevance_score: 0.8 },
                { index: 1, relevance_score: 0.7 },   // duplicate → ignored
                { index: 99, relevance_score: 1.0 },  // out of range → ignored
                { index: -1, relevance_score: 1.0 },  // out of range → ignored
            ],
        }));
        try {
            const order = await rerankViaEndpoint(cfg(srv.url), 'auth', CANDIDATES);
            expect(order).toEqual(['b', 'a', 'c']);
        } finally {
            await srv.close();
        }
    });

    test('request carries query, rendered documents, top_n, model and Bearer key', async () => {
        const srv = await serve(json({ results: [{ index: 0, relevance_score: 1 }] }));
        try {
            await rerankViaEndpoint(
                cfg(srv.url, { model: 'bge-reranker-v2-m3', apiKey: 'sk-test' }),
                'who handles auth',
                CANDIDATES
            );
            const req = srv.state.lastRequest;
            expect(req.headers.authorization).toBe('Bearer sk-test');
            expect(req.body.model).toBe('bge-reranker-v2-m3');
            expect(req.body.query).toBe('who handles auth');
            expect(req.body.top_n).toBe(3);
            expect(req.body.documents).toHaveLength(3);
            expect(req.body.documents[0]).toContain('login');
            expect(req.body.documents[0]).toContain('src/auth.ts:10');
        } finally {
            await srv.close();
        }
    });

    test('no Authorization header without apiKey', async () => {
        const srv = await serve(json({ results: [{ index: 0, relevance_score: 1 }] }));
        try {
            await rerankViaEndpoint(cfg(srv.url), 'q', CANDIDATES);
            expect(srv.state.lastRequest.headers.authorization).toBeUndefined();
        } finally {
            await srv.close();
        }
    });

    test('HTTP 500 → throws', async () => {
        const srv = await serve((res) => { res.writeHead(500); res.end('boom'); });
        try {
            await expect(rerankViaEndpoint(cfg(srv.url), 'q', CANDIDATES)).rejects.toThrow(/500/);
        } finally {
            await srv.close();
        }
    });

    test('unparsable payload → throws', async () => {
        const srv = await serve(json({ nothing: 'useful' }));
        try {
            await expect(rerankViaEndpoint(cfg(srv.url), 'q', CANDIDATES)).rejects.toThrow(/no parsable scores/);
        } finally {
            await srv.close();
        }
    });

    test('empty candidate list → empty order, no request', async () => {
        const order = await rerankViaEndpoint(cfg('http://127.0.0.1:1/nope'), 'q', []);
        expect(order).toEqual([]);
    });
});

describe('candidateDocument', () => {
    test('metadata-only rendering (sendCode=false path)', () => {
        const doc = candidateDocument(CANDIDATES[2]);
        expect(doc).toContain('docs/section');
        expect(doc).toContain('auth-setup');
        expect(doc).toContain('README.md:5');
    });

    test('snippet appended when the safety filter let it through', () => {
        const doc = candidateDocument({ ...CANDIDATES[0], snippet: 'function login() {}' });
        expect(doc).toContain('function login() {}');
    });
});
