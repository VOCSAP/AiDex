/**
 * Database module exports
 */

export { AiDexDatabase, openDatabase, createDatabase } from './database.js';
export { Queries, createQueries } from './queries.js';
export type {
    FileRow,
    LineRow,
    ItemRow,
    OccurrenceRow,
    SignatureRow,
    MethodRow,
    TypeRow,
    DependencyRow,
    TaskRow,
    TaskLogRow,
    CandidateEdgeKind,
    CandidateEdgeRow,
    CandidateEdgeViewRow,
    CandidateEdgeInput,
    CandidateEdgeQuery,
} from './queries.js';
export { GlobalDatabase, openGlobalDatabase, globalDbExists, getGlobalDbPath, getGlobalDir, readProjectStats } from './global-database.js';
export type { GlobalProject, ProjectStats } from './global-database.js';
