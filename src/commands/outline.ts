/**
 * Outline command for AiDex
 * Line-ranged plan of one file: indexed types and methods, or markdown headings.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { INDEX_DIR } from '../constants.js';
import { splitMarkdown } from '../embeddings/chunker-docs.js';
import { normalizePath, withDatabase } from './shared.js';

export const DEFAULT_OUTLINE_LIMIT = 100;

export interface OutlineParams {
    file: string;
    /** Project root holding the index; found by walking up from the file when omitted. */
    project?: string;
    limit?: number;
}

export interface OutlineEntry {
    startLine: number;
    /** null when the index holds no end line for this symbol. */
    endLine: number | null;
    label: string;
}

export interface OutlineResult {
    status: 'ok' | 'no_outline';
    reason?: string;
    kind?: 'code' | 'markdown';
    file: string;
    fileLines: number;
    total: number;
    entries: OutlineEntry[];
}

function findProjectRoot(fromDir: string): string | null {
    let dir = fromDir;
    for (;;) {
        if (existsSync(join(dir, INDEX_DIR, 'index.db'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function countLines(source: string): number {
    if (source.length === 0) return 0;
    const lines = source.split(/\r?\n/).length;
    return source.endsWith('\n') ? lines - 1 : lines;
}

function markdownEntries(source: string, fileLines: number): OutlineEntry[] {
    const headings = splitMarkdown(source).filter(s => s.level > 0);
    return headings.map((h, i) => {
        const next = headings.slice(i + 1).find(n => n.level <= h.level);
        return {
            startLine: h.startLine,
            endLine: next ? next.startLine - 1 : fileLines,
            label: h.heading,
        };
    });
}

export function outline(params: OutlineParams): OutlineResult {
    const limit = params.limit ?? DEFAULT_OUTLINE_LIMIT;
    const noOutline = (reason: string, file = normalizePath(params.file)): OutlineResult =>
        ({ status: 'no_outline', reason, file, fileLines: 0, total: 0, entries: [] });

    const requested = resolve(params.file);
    if (!existsSync(requested) || !statSync(requested).isFile()) {
        return noOutline('file not found');
    }
    // On-disk casing, because the index stores paths as init found them.
    const absFile = realpathSync.native(requested);

    const root = params.project
        ? (existsSync(join(params.project, INDEX_DIR, 'index.db')) ? realpathSync.native(resolve(params.project)) : null)
        : findProjectRoot(dirname(absFile));
    if (!root) return noOutline('no indexed project');

    const relFile = normalizePath(relative(root, absFile));
    if (relFile === '..' || relFile.startsWith('../') || isAbsolute(relFile)) {
        return noOutline('file outside project', relFile);
    }

    const source = readFileSync(absFile, 'utf-8');
    const fileLines = countLines(source);

    let kind: 'code' | 'markdown';
    let entries: OutlineEntry[];
    if (/\.(md|markdown)$/i.test(relFile)) {
        kind = 'markdown';
        entries = markdownEntries(source, fileLines);
    } else {
        kind = 'code';
        const rows = withDatabase(join(root, INDEX_DIR, 'index.db'), true, (_db, queries) => {
            const fileRow = queries.getFileByPath(relFile);
            if (!fileRow) return null;
            return {
                hash: fileRow.hash,
                methods: queries.getMethodsByFile(fileRow.id),
                types: queries.getTypesByFile(fileRow.id),
            };
        });
        if (!rows) return noOutline('file not in index', relFile);
        // Same digest as shortHash() at indexing time, inlined so this spawn does not load the parser.
        if (rows.hash !== createHash('sha256').update(source).digest('hex').substring(0, 16)) {
            return noOutline('stale index', relFile);
        }
        entries = [
            ...rows.types.map(t => ({ startLine: t.line_number, endLine: t.end_line ?? null, label: `${t.kind} ${t.name}` })),
            ...rows.methods.map(m => ({
                startLine: m.line_number,
                endLine: m.body_lines ? m.line_number + m.body_lines - 1 : null,
                label: m.prototype,
            })),
        ].sort((a, b) => a.startLine - b.startLine);
    }

    if (entries.length === 0) return noOutline(kind === 'markdown' ? 'no headings' : 'no symbols', relFile);

    return {
        status: 'ok',
        kind,
        file: relFile,
        fileLines,
        total: entries.length,
        entries: entries.slice(0, limit),
    };
}

export function formatOutline(result: OutlineResult): string {
    const unit = result.kind === 'markdown' ? 'heading(s)' : 'symbol(s)';
    const capped = result.entries.length < result.total ? ` [showing first ${result.entries.length}]` : '';
    const ranges = result.entries.map(e => e.endLine !== null && e.endLine !== e.startLine
        ? `${e.startLine}-${e.endLine}`
        : `${e.startLine}`);
    const width = Math.max(0, ...ranges.map(r => r.length));
    const lines = [`${result.file}: ${result.fileLines} lines, ${result.total} ${unit}${capped}`];
    result.entries.forEach((e, i) => lines.push(`  ${ranges[i].padEnd(width)}  ${e.label}`));
    return lines.join('\n');
}
