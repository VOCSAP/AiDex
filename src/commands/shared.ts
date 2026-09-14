/**
 * Shared utilities for AiDex commands
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { PRODUCT_NAME, PRODUCT_NAME_LOWER, INDEX_DIR } from '../constants.js';
import { openDatabase, createQueries, type AiDexDatabase } from '../db/index.js';
import type { Queries } from '../db/queries.js';

/**
 * Normalize path separators to forward slashes (consistent storage format).
 * Use this instead of inline .replace(/\\/g, '/') everywhere.
 */
export function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

/**
 * Escape a term for use in SQLite LIKE queries (with ESCAPE '\').
 * Handles: backslash, percent, underscore.
 */
export function escapeLikeTerm(term: string): string {
    return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Validate that a project has an AiDex index. Returns dbPath or null.
 */
export function validateIndex(projectPath: string): string | null {
    const dbPath = join(projectPath, INDEX_DIR, 'index.db');
    return existsSync(dbPath) ? dbPath : null;
}

const CLI_ENTRY = fileURLToPath(new URL('../index.js', import.meta.url));

/**
 * A shell command running the AiDex CLI, runnable as-is: this process's Node
 * binary and the entry point of this build, every argument quoted. The entry
 * is located from this module, not from process.argv[1], which names the
 * caller's script whenever AiDex is loaded as a library.
 *
 * Path arguments get forward slashes and lose trailing ones: a quoted `D:\proj\`
 * ends in an escaped quote under Git Bash. `<placeholder>` arguments are kept.
 *
 * When the entry file is missing, returns the short `aidex` form, labelled
 * before the command so it still pastes into a shell.
 */
export function cliCommand(subcommand: string, args: string[] = [], entry: string = CLI_ENTRY): string {
    const quoted = args.map((a) => ` "${cliArgument(a)}"`).join('');
    if (existsSync(entry)) {
        return `"${normalizePath(process.execPath)}" "${normalizePath(entry)}" ${subcommand}${quoted}`;
    }
    return `${PRODUCT_NAME} CLI: ${PRODUCT_NAME_LOWER} ${subcommand}${quoted}`;
}

function cliArgument(arg: string): string {
    if (arg.startsWith('<') && arg.endsWith('>')) return arg;
    return normalizePath(arg).replace(/([^:/])\/+$/, '$1');
}

/**
 * Standard error message when no index is found.
 */
export function noIndexError(projectPath: string): string {
    return `No ${PRODUCT_NAME} index found at ${projectPath}. Index it first: ${cliCommand('init', [projectPath])}`;
}

/**
 * Open a project database, run a function, and ensure the DB is always closed.
 * Returns whatever the function returns.
 */
export function withDatabase<T>(
    dbPath: string,
    readonly: boolean,
    fn: (db: AiDexDatabase, queries: Queries) => T
): T {
    const db = openDatabase(dbPath, readonly);
    const queries = createQueries(db);
    try {
        return fn(db, queries);
    } finally {
        db.close();
    }
}

/**
 * Validate index + open database + run function. Combines validateIndex + withDatabase.
 * Returns the error result if no index found, otherwise runs fn.
 */
export function withProjectDb<T>(
    projectPath: string,
    readonly: boolean,
    onError: (error: string) => T,
    fn: (db: AiDexDatabase, queries: Queries) => T
): T {
    const dbPath = validateIndex(projectPath);
    if (!dbPath) {
        return onError(noIndexError(projectPath));
    }
    return withDatabase(dbPath, readonly, fn);
}

// ============================================================
// Interval / Due Date Parsing
// ============================================================

/**
 * Parse an interval string to milliseconds.
 * Supports: "30s" (seconds), "30m" (minutes), "2h" (hours), "3d" (days), "1w" (weeks)
 */
export function parseIntervalToMs(interval: string): number | null {
    const match = interval.match(/^(\d+)([smhdw])$/i);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        case 'w': return value * 7 * 24 * 60 * 60 * 1000;
        default:  return null;
    }
}

/**
 * Parse a due date input to a timestamp.
 * - Relative: "3d" = 3 days from now (future)
 * - ISO date: "2026-04-10" or "2026-04-10T14:00:00Z"
 */
export function parseDueDate(input: string): number | null {
    if (!input) return null;

    // Relative: "3d" means 3 days from now
    const ms = parseIntervalToMs(input);
    if (ms) return Date.now() + ms;

    // ISO date string
    const date = new Date(input);
    if (!isNaN(date.getTime())) {
        return date.getTime();
    }

    return null;
}
