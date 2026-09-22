/**
 * Resolution for syntax-derived candidate relationships.
 *
 * This deliberately resolves less than a compiler. A missing target means
 * "unresolved or ambiguous", never "the relationship does not exist".
 */

import { extname, posix } from 'path';

import type { Queries, CandidateEdgeViewRow } from '../db/queries.js';

const SOURCE_EXTENSIONS = [
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.pyw', '.go', '.rs', '.cs', '.java', '.kt', '.kts',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
    '.php', '.rb', '.swift', '.astro',
];

const JS_RUNTIME_SOURCE_EXTENSIONS: Record<string, string[]> = {
    '.js': ['.ts', '.tsx', '.js', '.jsx'],
    '.mjs': ['.mts', '.ts', '.tsx', '.mjs'],
    '.cjs': ['.cts', '.ts', '.cjs'],
};

function pythonRelativeBase(sourceFile: string, specifier: string): string {
    const dotCount = specifier.match(/^\.+/)?.[0].length ?? 0;
    let directory = posix.dirname(sourceFile);
    for (let level = 1; level < dotCount; level++) {
        directory = posix.dirname(directory);
    }
    const modulePath = specifier.slice(dotCount).replace(/\./g, '/');
    return posix.normalize(posix.join(directory, modulePath));
}

function importCandidates(sourceFile: string, specifier: string): string[] {
    if (!specifier.startsWith('.')) return [];

    const sourceExtension = extname(sourceFile);
    const base = sourceExtension === '.py' || sourceExtension === '.pyw'
        ? pythonRelativeBase(sourceFile, specifier)
        : posix.normalize(posix.join(posix.dirname(sourceFile), specifier));
    if (base === '..' || base.startsWith('../')) return [];

    const extension = extname(base);
    const candidates = new Set<string>();
    if ((sourceExtension === '.py' || sourceExtension === '.pyw') && !extension) {
        candidates.add(base + '.py');
        candidates.add(posix.join(base, '__init__.py'));
        return [...candidates];
    }
    if (extension) {
        candidates.add(base);
        const replacements = JS_RUNTIME_SOURCE_EXTENSIONS[extension] ?? [];
        const stem = base.slice(0, -extension.length);
        for (const replacement of replacements) candidates.add(stem + replacement);
    } else {
        candidates.add(base);
        for (const candidateExtension of SOURCE_EXTENSIONS) {
            candidates.add(base + candidateExtension);
            candidates.add(posix.join(base, 'index' + candidateExtension));
        }
    }
    return [...candidates];
}

function resolveImport(edge: CandidateEdgeViewRow, queries: Queries): void {
    for (const candidate of importCandidates(edge.source_file, edge.target_symbol)) {
        const target = queries.getFileByPath(candidate);
        if (target) {
            queries.resolveCandidateEdge(edge.id, target.id, null);
            return;
        }
    }
}

function resolveCall(
    edge: CandidateEdgeViewRow,
    importsBySource: Map<number, Set<number>>,
    methodsByName: Map<string, Array<{ file_id: number; line_number: number }>>,
    queries: Queries
): void {
    const matches = methodsByName.get(edge.target_symbol.toLowerCase()) ?? [];
    if (matches.length === 0) return;

    const sameFile = matches.filter(method => method.file_id === edge.source_file_id);
    const importedFiles = importsBySource.get(edge.source_file_id) ?? new Set<number>();
    const imported = matches.filter(method => importedFiles.has(method.file_id));

    const candidates = sameFile.length > 0
        ? sameFile
        : imported.length > 0
            ? imported
            : matches.length === 1
                ? matches
                : [];

    // Ambiguity stays visible as an unresolved candidate instead of inventing
    // a single target.
    if (candidates.length !== 1) return;
    const target = candidates[0];
    queries.resolveCandidateEdge(edge.id, target.file_id, target.line_number);
}

export function rebuildCandidateEdgeTargets(queries: Queries): void {
    queries.resetCandidateEdgeTargets();

    const edges = queries.getAllCandidateEdges();
    for (const edge of edges) {
        if (edge.kind === 'import') resolveImport(edge, queries);
    }

    const resolved = queries.getAllCandidateEdges();
    const importsBySource = new Map<number, Set<number>>();
    for (const edge of resolved) {
        if (edge.kind !== 'import' || edge.target_file_id === null) continue;
        const targets = importsBySource.get(edge.source_file_id) ?? new Set<number>();
        targets.add(edge.target_file_id);
        importsBySource.set(edge.source_file_id, targets);
    }

    const methodsByName = new Map<string, Array<{ file_id: number; line_number: number }>>();
    for (const method of queries.getAllMethods()) {
        const key = method.name.toLowerCase();
        const methods = methodsByName.get(key) ?? [];
        methods.push(method);
        methodsByName.set(key, methods);
    }

    for (const edge of resolved) {
        if (edge.kind === 'call') resolveCall(edge, importsBySource, methodsByName, queries);
    }
}

