/**
 * Read syntax-derived candidate relationships.
 */

import { withProjectDb } from './shared.js';
import type {
    CandidateEdgeKind,
    CandidateEdgeViewRow,
} from '../db/queries.js';

export type EdgeDirection = 'incoming' | 'outgoing' | 'both';

export interface EdgesParams {
    path: string;
    file?: string;
    symbol?: string;
    direction?: EdgeDirection;
    kind?: CandidateEdgeKind;
    limit?: number;
}

export interface EdgesResult {
    success: boolean;
    edges: CandidateEdgeViewRow[];
    error?: string;
}

export function edges(params: EdgesParams): EdgesResult {
    const file = params.file?.replace(/\\/g, '/');
    if (!file && !params.symbol) {
        return { success: false, edges: [], error: 'file or symbol parameter is required' };
    }

    return withProjectDb(
        params.path,
        false,
        error => ({ success: false, edges: [], error }),
        (_db, queries) => {
            const fileRow = file ? queries.getFileByPath(file) : undefined;
            if (file && !fileRow) {
                return {
                    success: false,
                    edges: [],
                    error: `File is not indexed: ${file}`,
                };
            }
            return {
                success: true,
                edges: queries.findCandidateEdges({
                    fileId: fileRow?.id,
                    direction: params.direction,
                    kind: params.kind,
                    symbol: params.symbol,
                    limit: params.limit,
                }),
            };
        }
    );
}

