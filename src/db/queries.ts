/**
 * Prepared statements and query helpers for AiDex
 */

import type Database from 'better-sqlite3';
import type { AiDexDatabase } from './database.js';

/** Escape a term for SQLite LIKE queries (with ESCAPE '\'). */
function escapeLike(term: string): string {
    return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Fold ASCII letters only, mirroring SQLite's built-in `COLLATE NOCASE`
 * (stock SQLite, no ICU extension, folds A-Z/a-z only). `.toLowerCase()`
 * folds full Unicode and would silently diverge from what the LIKE clause
 * it must stay byte-identical with actually matches.
 */
function asciiLower(term: string): string {
    return term.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Overlapping 3-char substrings of `text`, deduplicated, in first-seen order. */
function trigramsOf(text: string): string[] {
    const grams: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i + 3 <= text.length; i++) {
        const g = text.slice(i, i + 3);
        if (!seen.has(g)) {
            seen.add(g);
            grams.push(g);
        }
    }
    return grams;
}

// ============================================================
// Type definitions
// ============================================================

export interface FileRow {
    id: number;
    path: string;
    hash: string;
    last_indexed: number;
}

export interface LineRow {
    id: number;
    file_id: number;
    line_number: number;
    line_type: 'code' | 'comment' | 'struct' | 'method' | 'property' | 'string';
    line_hash: string | null;
    modified: number | null;
}

export interface ItemRow {
    id: number;
    term: string;
}

/** Why an occurrence exists. 'both' = the same term on one line, as each. */
export type OccurrenceKind = 'symbol' | 'literal' | 'both';

export interface OccurrenceRow {
    item_id: number;
    file_id: number;
    line_id: number;
    kind: OccurrenceKind;
}

export interface SignatureRow {
    file_id: number;
    header_comments: string | null;
}

export interface MethodRow {
    id: number;
    file_id: number;
    name: string;
    prototype: string;
    line_number: number;
    visibility: string | null;
    is_static: number;
    is_async: number;
    body_text: string | null;
    body_lines: number | null;
    body_truncated: number;
}

export interface TypeRow {
    id: number;
    file_id: number;
    name: string;
    kind: 'class' | 'struct' | 'interface' | 'enum' | 'type';
    line_number: number;
}

export interface DependencyRow {
    id: number;
    path: string;
    name: string | null;
    last_checked: number | null;
}

export interface ProjectFileRow {
    id: number;
    path: string;
    type: 'dir' | 'code' | 'config' | 'doc' | 'asset' | 'test' | 'other';
    extension: string | null;
    indexed: number;
}

export interface TaskRow {
    id: number;
    title: string;
    description: string | null;
    summary: string | null;
    priority: 1 | 2 | 3;
    status: 'backlog' | 'active' | 'done' | 'cancelled';
    tags: string | null;
    source: string | null;
    sort_order: number;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
    due: number | null;
    interval: string | null;
    action: string | null;
    auto_go: number;
}

export interface TaskLogRow {
    id: number;
    task_id: number;
    note: string;
    created_at: number;
}

// ============================================================
// Query class with prepared statements
// ============================================================

export class Queries {
    private db: Database.Database;

    // Prepared statements (lazily initialized)
    private _insertFile?: Database.Statement;
    private _updateFileHash?: Database.Statement;
    private _getFileByPath?: Database.Statement;
    private _getFileById?: Database.Statement;
    private _getAllFiles?: Database.Statement;
    private _deleteFile?: Database.Statement;

    private _insertLine?: Database.Statement;
    private _getLinesByFile?: Database.Statement;
    private _deleteLinesByFile?: Database.Statement;
    private _updateLineNumbers?: Database.Statement;

    private _insertItem?: Database.Statement;
    private _getItemByTerm?: Database.Statement;
    private _getItemById?: Database.Statement;
    private _deleteUnusedItems?: Database.Statement;

    // Trigram prefilter for contains-mode search (Lot B). Lazily built from
    // items.term, invalidated on any items-table mutation (insertItem,
    // deleteUnusedItems) -- see invalidateTrigramIndex.
    private _trigramIndex?: { postings: Map<string, number[]>; total: number };
    private static readonly TRIGRAM_GUARD_FRAC = 0.10;

    private _insertOccurrence?: Database.Statement;
    private _hasOccurrenceKind?: boolean;
    private _getOccurrencesByItem?: Database.Statement;
    private _getOccurrencesByFile?: Database.Statement;
    private _deleteOccurrencesByFile?: Database.Statement;

    private _insertSignature?: Database.Statement;
    private _getSignatureByFile?: Database.Statement;
    private _deleteSignatureByFile?: Database.Statement;

    private _insertMethod?: Database.Statement;
    private _getMethodsByFile?: Database.Statement;
    private _deleteMethodsByFile?: Database.Statement;

    private _insertType?: Database.Statement;
    private _getTypesByFile?: Database.Statement;
    private _deleteTypesByFile?: Database.Statement;

    constructor(database: AiDexDatabase) {
        this.db = database.getDb();
    }

    // --------------------------------------------------------
    // Files
    // --------------------------------------------------------

    insertFile(path: string, hash: string): number {
        this._insertFile ??= this.db.prepare(
            'INSERT INTO files (path, hash, last_indexed) VALUES (?, ?, ?)'
        );
        const result = this._insertFile.run(path, hash, Date.now());
        return result.lastInsertRowid as number;
    }

    updateFileHash(id: number, hash: string): void {
        this._updateFileHash ??= this.db.prepare(
            'UPDATE files SET hash = ?, last_indexed = ? WHERE id = ?'
        );
        this._updateFileHash.run(hash, Date.now(), id);
    }

    getFileByPath(path: string): FileRow | undefined {
        this._getFileByPath ??= this.db.prepare(
            'SELECT * FROM files WHERE path = ?'
        );
        return this._getFileByPath.get(path) as FileRow | undefined;
    }

    getFileById(id: number): FileRow | undefined {
        this._getFileById ??= this.db.prepare(
            'SELECT * FROM files WHERE id = ?'
        );
        return this._getFileById.get(id) as FileRow | undefined;
    }

    getAllFiles(): FileRow[] {
        this._getAllFiles ??= this.db.prepare('SELECT * FROM files ORDER BY path');
        return this._getAllFiles.all() as FileRow[];
    }

    deleteFile(id: number): void {
        this._deleteFile ??= this.db.prepare('DELETE FROM files WHERE id = ?');
        this._deleteFile.run(id);
    }

    // --------------------------------------------------------
    // Lines
    // --------------------------------------------------------

    insertLine(fileId: number, lineId: number, lineNumber: number, lineType: LineRow['line_type'], lineHash?: string, modified?: number): void {
        this._insertLine ??= this.db.prepare(
            'INSERT INTO lines (file_id, id, line_number, line_type, line_hash, modified) VALUES (?, ?, ?, ?, ?, ?)'
        );
        this._insertLine.run(fileId, lineId, lineNumber, lineType, lineHash ?? null, modified ?? Date.now());
    }

    getLinesByFile(fileId: number): LineRow[] {
        this._getLinesByFile ??= this.db.prepare(
            'SELECT * FROM lines WHERE file_id = ? ORDER BY line_number'
        );
        return this._getLinesByFile.all(fileId) as LineRow[];
    }

    deleteLinesByFile(fileId: number): void {
        this._deleteLinesByFile ??= this.db.prepare(
            'DELETE FROM lines WHERE file_id = ?'
        );
        this._deleteLinesByFile.run(fileId);
    }

    updateLineNumbers(fileId: number, fromLine: number, offset: number): void {
        this._updateLineNumbers ??= this.db.prepare(
            'UPDATE lines SET line_number = line_number + ? WHERE file_id = ? AND line_number >= ?'
        );
        this._updateLineNumbers.run(offset, fileId, fromLine);
    }

    // --------------------------------------------------------
    // Items
    // --------------------------------------------------------

    insertItem(term: string): number {
        this._insertItem ??= this.db.prepare(
            'INSERT INTO items (term) VALUES (?)'
        );
        const result = this._insertItem.run(term);
        this.invalidateTrigramIndex();
        return result.lastInsertRowid as number;
    }

    getOrCreateItem(term: string): number {
        const existing = this.getItemByTerm(term);
        if (existing) {
            return existing.id;
        }
        return this.insertItem(term);
    }

    getItemByTerm(term: string): ItemRow | undefined {
        this._getItemByTerm ??= this.db.prepare(
            'SELECT * FROM items WHERE term = ? COLLATE NOCASE'
        );
        return this._getItemByTerm.get(term) as ItemRow | undefined;
    }

    getItemById(id: number): ItemRow | undefined {
        this._getItemById ??= this.db.prepare(
            'SELECT * FROM items WHERE id = ?'
        );
        return this._getItemById.get(id) as ItemRow | undefined;
    }

    deleteUnusedItems(): number {
        this._deleteUnusedItems ??= this.db.prepare(
            'DELETE FROM items WHERE NOT EXISTS (SELECT 1 FROM occurrences WHERE occurrences.item_id = items.id)'
        );
        const result = this._deleteUnusedItems.run();
        if (result.changes > 0) {
            this.invalidateTrigramIndex();
        }
        return result.changes;
    }

    // --------------------------------------------------------
    // Trigram prefilter (contains-mode search)
    // --------------------------------------------------------

    private invalidateTrigramIndex(): void {
        this._trigramIndex = undefined;
    }

    private buildTrigramIndex(): { postings: Map<string, number[]>; total: number } {
        const postings = new Map<string, number[]>();
        const rows = this.db.prepare('SELECT id, term FROM items').all() as Array<{ id: number; term: string }>;
        for (const row of rows) {
            for (const g of trigramsOf(asciiLower(row.term))) {
                let bucket = postings.get(g);
                if (!bucket) {
                    bucket = [];
                    postings.set(g, bucket);
                }
                bucket.push(row.id);
            }
        }
        return { postings, total: rows.length };
    }

    private getTrigramIndex(): { postings: Map<string, number[]>; total: number } {
        this._trigramIndex ??= this.buildTrigramIndex();
        return this._trigramIndex;
    }

    /**
     * Candidate item ids for a contains-mode needle, or `null` to signal
     * "fall back to the full LIKE scan" (needle too short to trigram, or its
     * rarest trigram's posting list still exceeds TRIGRAM_GUARD_FRAC of the
     * corpus -- the guard only reads posting-list lengths, never intersects,
     * so it stays cheap regardless of outcome).
     *
     * A needle whose trigrams are all present but intersect to nothing (or
     * whose trigrams are all absent from the index) is a definite zero-match
     * case -- returns an empty Set, NOT null, since that is not a reason to
     * fall back.
     */
    private trigramCandidates(needle: string): Set<number> | null {
        const text = asciiLower(needle);
        if (text.length < 3) return null;

        const { postings, total } = this.getTrigramIndex();
        if (total === 0) return new Set();

        const grams = trigramsOf(text);
        const buckets: number[][] = [];
        const presentLens: number[] = [];
        let hasMissingGram = false;
        for (const g of grams) {
            const bucket = postings.get(g);
            if (bucket) {
                buckets.push(bucket);
                presentLens.push(bucket.length);
            } else {
                hasMissingGram = true;
            }
        }

        // Every trigram absent from the index: needle matches nothing, but
        // that is not a reason to fall back to a full scan.
        if (presentLens.length === 0) return new Set();

        const thresh = total * Queries.TRIGRAM_GUARD_FRAC;
        if (Math.min(...presentLens) > thresh) return null;

        // A trigram of the needle occurs nowhere in the index: no term can
        // contain the whole needle either, so the answer is a definite zero,
        // not a fallback.
        if (hasMissingGram) return new Set();

        buckets.sort((a, b) => a.length - b.length);
        let hit = new Set<number>(buckets[0]);
        for (let i = 1; i < buckets.length && hit.size > 0; i++) {
            const next = new Set<number>();
            for (const id of buckets[i]) {
                if (hit.has(id)) next.add(id);
            }
            hit = next;
        }
        return hit;
    }

    // --------------------------------------------------------
    // Occurrences
    // --------------------------------------------------------

    /**
     * Insert an occurrence.
     *
     * `INSERT OR IGNORE` on a row that already exists with a DIFFERENT kind
     * would silently keep the first one, so the conflict is resolved explicitly:
     * a term seen both as a symbol and as a literal on one line becomes 'both'.
     * Losing that would make `kinds` lie on 1.5% of literal occurrences.
     */
    insertOccurrence(itemId: number, fileId: number, lineId: number, kind: OccurrenceKind = 'symbol'): void {
        this._insertOccurrence ??= this.db.prepare(`
            INSERT INTO occurrences (item_id, file_id, line_id, kind) VALUES (?, ?, ?, ?)
            ON CONFLICT(item_id, file_id, line_id) DO UPDATE SET
                kind = CASE WHEN occurrences.kind = excluded.kind THEN occurrences.kind ELSE 'both' END
        `);
        this._insertOccurrence.run(itemId, fileId, lineId, kind);
    }

    getOccurrencesByItem(itemId: number): Array<{ file_id: number; line_id: number; line_number: number; path: string; line_type: string; modified: number | null }> {
        this._getOccurrencesByItem ??= this.db.prepare(`
            SELECT o.file_id, o.line_id, l.line_number, f.path, l.line_type, l.modified
            FROM occurrences o
            JOIN lines l ON o.file_id = l.file_id AND o.line_id = l.id
            JOIN files f ON o.file_id = f.id
            WHERE o.item_id = ?
            ORDER BY f.path, l.line_number
        `);
        return this._getOccurrencesByItem.all(itemId) as Array<{ file_id: number; line_id: number; line_number: number; path: string; line_type: string; modified: number | null }>;
    }

    /**
     * Get occurrences for multiple items at once (eliminates N+1 queries).
     * Returns results grouped by item_id.
     */
    /**
     * Does this database have `occurrences.kind` yet?
     *
     * It is added by migrateLegacySchema, which openDatabase only runs on a
     * WRITEABLE handle -- and a readonly connection cannot ALTER anything. So
     * every read path has to cope with an index built before Lot 2 instead of
     * assuming the column exists: `hyp_bde59155`, caught by probing the real
     * koryphaios index, not by the test fixture, which is always freshly created
     * from the current schema.
     */
    private hasOccurrenceKind(): boolean {
        if (this._hasOccurrenceKind === undefined) {
            const cols = this.db.prepare('PRAGMA table_info(occurrences)').all() as Array<{ name: string }>;
            this._hasOccurrenceKind = cols.some(c => c.name === 'kind');
        }
        return this._hasOccurrenceKind;
    }

    getOccurrencesByItems(itemIds: number[]): Array<{ item_id: number; file_id: number; line_id: number; line_number: number; path: string; line_type: string; kind: OccurrenceKind; modified: number | null }> {
        if (itemIds.length === 0) return [];
        // A pre-Lot-2 index holds symbols only, so the constant is the truth
        // there, not a placeholder.
        const kindExpr = this.hasOccurrenceKind() ? 'o.kind' : `'symbol' AS kind`;
        // SQLite has a max variable limit (~999), batch if needed
        const results: Array<{ item_id: number; file_id: number; line_id: number; line_number: number; path: string; line_type: string; kind: OccurrenceKind; modified: number | null }> = [];
        const batchSize = 500;
        for (let i = 0; i < itemIds.length; i += batchSize) {
            const batch = itemIds.slice(i, i + batchSize);
            const placeholders = batch.map(() => '?').join(',');
            const sql = `
                SELECT o.item_id, o.file_id, o.line_id, l.line_number, f.path, l.line_type, ${kindExpr}, l.modified
                FROM occurrences o
                JOIN lines l ON o.file_id = l.file_id AND o.line_id = l.id
                JOIN files f ON o.file_id = f.id
                WHERE o.item_id IN (${placeholders})
                ORDER BY f.path, l.line_number
            `;
            const rows = this.db.prepare(sql).all(...batch) as Array<{ item_id: number; file_id: number; line_id: number; line_number: number; path: string; line_type: string; kind: OccurrenceKind; modified: number | null }>;
            results.push(...rows);
        }
        return results;
    }

    getOccurrencesByFile(fileId: number): OccurrenceRow[] {
        this._getOccurrencesByFile ??= this.db.prepare(
            'SELECT * FROM occurrences WHERE file_id = ?'
        );
        return this._getOccurrencesByFile.all(fileId) as OccurrenceRow[];
    }

    deleteOccurrencesByFile(fileId: number): void {
        this._deleteOccurrencesByFile ??= this.db.prepare(
            'DELETE FROM occurrences WHERE file_id = ?'
        );
        this._deleteOccurrencesByFile.run(fileId);
    }

    // --------------------------------------------------------
    // Signatures
    // --------------------------------------------------------

    insertSignature(fileId: number, headerComments: string | null): void {
        this._insertSignature ??= this.db.prepare(
            'INSERT OR REPLACE INTO signatures (file_id, header_comments) VALUES (?, ?)'
        );
        this._insertSignature.run(fileId, headerComments);
    }

    getSignatureByFile(fileId: number): SignatureRow | undefined {
        this._getSignatureByFile ??= this.db.prepare(
            'SELECT * FROM signatures WHERE file_id = ?'
        );
        return this._getSignatureByFile.get(fileId) as SignatureRow | undefined;
    }

    deleteSignatureByFile(fileId: number): void {
        this._deleteSignatureByFile ??= this.db.prepare(
            'DELETE FROM signatures WHERE file_id = ?'
        );
        this._deleteSignatureByFile.run(fileId);
    }

    // --------------------------------------------------------
    // Methods
    // --------------------------------------------------------

    insertMethod(
        fileId: number,
        name: string,
        prototype: string,
        lineNumber: number,
        visibility: string | null = null,
        isStatic = false,
        isAsync = false,
        bodyText: string | null = null,
        bodyLines: number | null = null,
        bodyTruncated = false
    ): number {
        this._insertMethod ??= this.db.prepare(
            'INSERT INTO methods (file_id, name, prototype, line_number, visibility, is_static, is_async, body_text, body_lines, body_truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const result = this._insertMethod.run(
            fileId, name, prototype, lineNumber,
            visibility, isStatic ? 1 : 0, isAsync ? 1 : 0,
            bodyText, bodyLines, bodyTruncated ? 1 : 0
        );
        return result.lastInsertRowid as number;
    }

    getMethodsByFile(fileId: number): MethodRow[] {
        this._getMethodsByFile ??= this.db.prepare(
            'SELECT * FROM methods WHERE file_id = ? ORDER BY line_number'
        );
        return this._getMethodsByFile.all(fileId) as MethodRow[];
    }

    deleteMethodsByFile(fileId: number): void {
        this._deleteMethodsByFile ??= this.db.prepare(
            'DELETE FROM methods WHERE file_id = ?'
        );
        this._deleteMethodsByFile.run(fileId);
    }

    // --------------------------------------------------------
    // Types
    // --------------------------------------------------------

    insertType(
        fileId: number,
        name: string,
        kind: TypeRow['kind'],
        lineNumber: number
    ): number {
        this._insertType ??= this.db.prepare(
            'INSERT INTO types (file_id, name, kind, line_number) VALUES (?, ?, ?, ?)'
        );
        const result = this._insertType.run(fileId, name, kind, lineNumber);
        return result.lastInsertRowid as number;
    }

    getTypesByFile(fileId: number): TypeRow[] {
        this._getTypesByFile ??= this.db.prepare(
            'SELECT * FROM types WHERE file_id = ? ORDER BY line_number'
        );
        return this._getTypesByFile.all(fileId) as TypeRow[];
    }

    deleteTypesByFile(fileId: number): void {
        this._deleteTypesByFile ??= this.db.prepare(
            'DELETE FROM types WHERE file_id = ?'
        );
        this._deleteTypesByFile.run(fileId);
    }

    // --------------------------------------------------------
    // Query: Search items
    // --------------------------------------------------------

    /**
     * The WHERE clause shared by item search and item counting, so a filter can
     * never apply to one and not the other -- which would make the announced
     * total disagree with the rows returned under it.
     *
     * `includeLiteralOnly: false` drops items whose every occurrence is a
     * literal. Without it those items take seats in the window even when the
     * caller only asked for symbols, and the eviction is silent.
     */
    private itemMatchClause(mode: 'exact' | 'contains' | 'starts_with', includeLiteralOnly: boolean): string {
        const match = mode === 'exact'
            ? 'i.term = ? COLLATE NOCASE'
            : "i.term LIKE ? ESCAPE '\\' COLLATE NOCASE";
        // Omitted on a pre-Lot-2 index: there is no `kind` column to filter on,
        // and everything such an index holds is a symbol anyway.
        const literalFilter = (!includeLiteralOnly && this.hasOccurrenceKind())
            ? ` AND EXISTS (SELECT 1 FROM occurrences o WHERE o.item_id = i.id AND o.kind IN ('symbol', 'both'))`
            : '';
        return `${match}${literalFilter}`;
    }

    private itemMatchParam(term: string, mode: 'exact' | 'contains' | 'starts_with'): string {
        if (mode === 'exact') return term;
        return mode === 'contains' ? `%${escapeLike(term)}%` : `${escapeLike(term)}%`;
    }

    /**
     * `contains`-mode candidate id restriction, shared by countItems and
     * searchItems so total and window can never disagree about which items
     * survived the trigram prefilter.
     *
     * Returns `{ clause: '', params: [] }` for every mode other than
     * `contains`, and whenever the trigram guard says "fall back" -- in both
     * cases the caller's existing LIKE-only WHERE runs unmodified. This never
     * touches ORDER BY: it only narrows the candidate set the existing SQL
     * already filters and orders.
     */
    private trigramCandidateClause(term: string, mode: 'exact' | 'contains' | 'starts_with'): { clause: string; params: string[] } {
        if (mode !== 'contains') return { clause: '', params: [] };
        const candidates = this.trigramCandidates(term);
        if (!candidates) return { clause: '', params: [] };
        return {
            clause: ' AND i.id IN (SELECT value FROM json_each(?))',
            params: [JSON.stringify([...candidates])],
        };
    }

    /** How many items match, BEFORE the window is applied. */
    countItems(
        term: string,
        mode: 'exact' | 'contains' | 'starts_with' = 'exact',
        includeLiteralOnly = true
    ): number {
        const candidate = this.trigramCandidateClause(term, mode);
        const sql = `SELECT COUNT(*) n FROM items i WHERE ${this.itemMatchClause(mode, includeLiteralOnly)}${candidate.clause}`;
        return (this.db.prepare(sql).get(this.itemMatchParam(term, mode), ...candidate.params) as { n: number }).n;
    }

    searchItems(
        term: string,
        mode: 'exact' | 'contains' | 'starts_with' = 'exact',
        limit = 100,
        offset = 0,
        includeLiteralOnly = true
    ): ItemRow[] {
        // ORDER BY is not cosmetic here, it is what makes `offset` mean
        // anything: SQL guarantees no row order without it, so paging through
        // an unordered LIMIT can repeat rows and skip others.
        //
        // The ranking itself uses the only signal a substring search carries --
        // how close a term is to what was typed. On `contains`, `getUser` is a
        // likelier target than `internalGetUserPreferencesCache`. The last two
        // keys exist to make the order TOTAL: without a tiebreak, equal-ranking
        // rows are free to swap between two calls, and the paging breaks again
        // for a subtler reason.
        //
        // The trigram prefilter (trigramCandidateClause) only ever narrows the
        // WHERE's candidate set -- it never rewrites or reorders this ORDER BY,
        // so pagination stays stable whether or not it fires.
        const candidate = this.trigramCandidateClause(term, mode);
        const sql = `
            SELECT i.* FROM items i
            WHERE ${this.itemMatchClause(mode, includeLiteralOnly)}${candidate.clause}
            ORDER BY
                CASE WHEN i.term = ? COLLATE NOCASE THEN 0 ELSE 1 END,
                CASE WHEN i.term LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 0 ELSE 1 END,
                LENGTH(i.term),
                i.term COLLATE NOCASE,
                i.id
            LIMIT ? OFFSET ?
        `;
        return this.db.prepare(sql).all(
            this.itemMatchParam(term, mode),
            ...candidate.params,
            term,
            `${escapeLike(term)}%`,
            limit,
            offset
        ) as ItemRow[];
    }

    // --------------------------------------------------------
    // Bulk operations
    // --------------------------------------------------------

    /**
     * Clear all data for a file (before re-indexing)
     */
    clearFileData(fileId: number): void {
        this.db.transaction(() => {
            // Order matters due to foreign keys
            this.deleteOccurrencesByFile(fileId);
            this.deleteMethodsByFile(fileId);
            this.deleteTypesByFile(fileId);
            this.deleteSignatureByFile(fileId);
            this.deleteLinesByFile(fileId);
        })();
    }

    /**
     * Bulk insert lines
     */
    bulkInsertLines(fileId: number, lines: Array<{ lineId: number; lineNumber: number; lineType: LineRow['line_type']; lineHash?: string; modified?: number }>): void {
        const stmt = this.db.prepare(
            'INSERT INTO lines (file_id, id, line_number, line_type, line_hash, modified) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const now = Date.now();
        this.db.transaction(() => {
            for (const line of lines) {
                stmt.run(fileId, line.lineId, line.lineNumber, line.lineType, line.lineHash ?? null, line.modified ?? now);
            }
        })();
    }

    /**
     * Bulk insert occurrences
     */
    bulkInsertOccurrences(occurrences: Array<{ itemId: number; fileId: number; lineId: number }>): void {
        const stmt = this.db.prepare(
            'INSERT OR IGNORE INTO occurrences (item_id, file_id, line_id) VALUES (?, ?, ?)'
        );
        this.db.transaction(() => {
            for (const occ of occurrences) {
                stmt.run(occ.itemId, occ.fileId, occ.lineId);
            }
        })();
    }

    // --------------------------------------------------------
    // Project Files (project structure)
    // --------------------------------------------------------

    private _insertProjectFile?: Database.Statement;
    private _getProjectFiles?: Database.Statement;
    private _getProjectFilesByType?: Database.Statement;
    private _clearProjectFiles?: Database.Statement;

    private _insertTask?: Database.Statement;
    private _deleteTask?: Database.Statement;
    private _getTaskById?: Database.Statement;
    private _getTasksByStatus?: Database.Statement;
    private _getAllTasks?: Database.Statement;
    private _insertTaskLog?: Database.Statement;
    private _getTaskLog?: Database.Statement;

    insertProjectFile(path: string, type: ProjectFileRow['type'], extension: string | null, indexed: boolean): void {
        this._insertProjectFile ??= this.db.prepare(
            'INSERT OR REPLACE INTO project_files (path, type, extension, indexed) VALUES (?, ?, ?, ?)'
        );
        this._insertProjectFile.run(path, type, extension, indexed ? 1 : 0);
    }

    getProjectFiles(): ProjectFileRow[] {
        this._getProjectFiles ??= this.db.prepare(
            'SELECT * FROM project_files ORDER BY path'
        );
        return this._getProjectFiles.all() as ProjectFileRow[];
    }

    getProjectFilesByType(type: ProjectFileRow['type']): ProjectFileRow[] {
        this._getProjectFilesByType ??= this.db.prepare(
            'SELECT * FROM project_files WHERE type = ? ORDER BY path'
        );
        return this._getProjectFilesByType.all(type) as ProjectFileRow[];
    }

    clearProjectFiles(): void {
        this._clearProjectFiles ??= this.db.prepare('DELETE FROM project_files');
        this._clearProjectFiles.run();
    }

    // --------------------------------------------------------
    // Tasks
    // --------------------------------------------------------

    insertTask(
        title: string,
        description: string | null,
        summary: string | null,
        priority: 1 | 2 | 3,
        status: 'backlog' | 'active' | 'done' | 'cancelled',
        tags: string | null,
        source: string | null,
        sortOrder: number,
        due: number | null = null,
        interval: string | null = null,
        action: string | null = null,
        autoGo: number = 0
    ): number {
        this._insertTask ??= this.db.prepare(
            'INSERT INTO tasks (title, description, summary, priority, status, tags, source, sort_order, created_at, updated_at, due, interval, action, auto_go) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const now = Date.now();
        const result = this._insertTask.run(title, description, summary, priority, status, tags, source, sortOrder, now, now, due, interval, action, autoGo);
        return result.lastInsertRowid as number;
    }

    updateTask(id: number, fields: Partial<Pick<TaskRow, 'title' | 'description' | 'summary' | 'priority' | 'status' | 'tags' | 'source' | 'sort_order' | 'due' | 'interval' | 'action' | 'auto_go'>>): boolean {
        const ALLOWED_FIELDS = new Set(['title', 'description', 'summary', 'status', 'priority', 'tags', 'source', 'sort_order', 'completed_at', 'due', 'interval', 'action', 'auto_go']);
        const sets: string[] = [];
        const values: unknown[] = [];
        for (const [key, value] of Object.entries(fields)) {
            if (!ALLOWED_FIELDS.has(key)) continue;
            sets.push(`${key} = ?`);
            values.push(value);
        }
        if (sets.length === 0) return false;
        sets.push('updated_at = ?');
        values.push(Date.now());
        if (fields.status === 'done') {
            sets.push('completed_at = ?');
            values.push(Date.now());
        } else if (fields.status === 'active' || fields.status === 'backlog') {
            sets.push('completed_at = ?');
            values.push(null);
        }
        values.push(id);
        const sql = `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`;
        const result = this.db.prepare(sql).run(...values);
        return result.changes > 0;
    }

    deleteTask(id: number): boolean {
        this._deleteTask ??= this.db.prepare('DELETE FROM tasks WHERE id = ?');
        const result = this._deleteTask.run(id);
        return result.changes > 0;
    }

    getTaskById(id: number): TaskRow | undefined {
        this._getTaskById ??= this.db.prepare('SELECT * FROM tasks WHERE id = ?');
        return this._getTaskById.get(id) as TaskRow | undefined;
    }

    getAllTasks(): TaskRow[] {
        this._getAllTasks ??= this.db.prepare(
            'SELECT * FROM tasks ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'backlog\' THEN 1 WHEN \'done\' THEN 2 END, priority ASC, sort_order ASC, created_at DESC'
        );
        return this._getAllTasks.all() as TaskRow[];
    }

    getTasksByStatus(status: string): TaskRow[] {
        this._getTasksByStatus ??= this.db.prepare(
            'SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, sort_order ASC, created_at DESC'
        );
        return this._getTasksByStatus.all(status) as TaskRow[];
    }

    // --------------------------------------------------------
    // Task Log
    // --------------------------------------------------------

    insertTaskLog(taskId: number, note: string): number {
        this._insertTaskLog ??= this.db.prepare(
            'INSERT INTO task_log (task_id, note, created_at) VALUES (?, ?, ?)'
        );
        const result = this._insertTaskLog.run(taskId, note, Date.now());
        return result.lastInsertRowid as number;
    }

    getTaskLog(taskId: number): TaskLogRow[] {
        this._getTaskLog ??= this.db.prepare(
            'SELECT * FROM task_log WHERE task_id = ? ORDER BY created_at DESC'
        );
        return this._getTaskLog.all(taskId) as TaskLogRow[];
    }
}

/**
 * Create a Queries instance for the given database
 */
export function createQueries(database: AiDexDatabase): Queries {
    return new Queries(database);
}
