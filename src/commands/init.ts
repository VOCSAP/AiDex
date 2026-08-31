/**
 * init command - Initialize AiDex for a project
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, relative, basename, extname, dirname, resolve } from 'path';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import { INDEX_DIR } from '../constants.js';
import { invalidateGlobalCache } from './global/global-query.js';
import {
    COVERAGE_METADATA_KEY,
    LITERAL_RULE_ID,
    LITERAL_RULE_VERSION,
    readCoverage,
    type CoverageRecord,
} from '../coverage/rule.js';
import type { IndexResult } from '../embeddings/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Run embedding in a fully isolated child process (spawn, not fork) so an
 * ONNX OOM crash kills only the worker — the MCP server stays alive.
 * Communication via stdin/stdout JSON. Timeout: 10 minutes per project.
 */
function indexProjectInWorker(projectPath: string, force = false): Promise<IndexResult> {
    return new Promise((resolve, reject) => {
        const workerPath = join(__dirname, '..', 'embeddings', 'embed-worker.js');
        const child = spawn(process.execPath, [workerPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('Embedding timed out after 10 minutes'));
        }, 10 * 60 * 1000);

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        child.on('close', (code) => {
            clearTimeout(timeout);
            try {
                const msg = JSON.parse(stdout.trim());
                if (msg.ok) {
                    resolve({ embedded: msg.embedded, skipped: msg.skipped, removed: msg.removed, durationMs: msg.durationMs });
                } else {
                    reject(new Error(msg.error ?? `Worker failed (exit ${code})`));
                }
            } catch {
                const errDetail = stderr.split('\n')[0].slice(0, 200);
                reject(new Error(`Worker exited with code ${code}${errDetail ? ': ' + errDetail : ' (likely OOM)'}`));
            }
        });

        // Send the request via stdin and close it so the worker knows input is done.
        child.stdin.write(JSON.stringify({ projectPath, force }));
        child.stdin.end();
    });
}

/**
 * Compute a short (16-char) SHA256 hash of content.
 * Used consistently across init, update, and session for file/line hashing.
 */
export function shortHash(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

import { createDatabase, createQueries, type AiDexDatabase, type Queries } from '../db/index.js';
import { withDatabase } from './shared.js';
import { extract, getSupportedExtensions, astroHasNoFrontmatterFence } from '../parser/index.js';
import { rebuildCandidateEdgeTargets } from '../relations/candidate-edges.js';
import { globalDbExists, readProjectStats, openGlobalDatabase } from '../db/global-database.js';

// ============================================================
// Types
// ============================================================

export interface InitParams {
    path: string;
    name?: string;
    languages?: string[];
    exclude?: string[];
    fresh?: boolean;  // Force fresh re-index (delete all existing data)
    store_bodies?: boolean;  // Store full method bodies in DB (vorbereitend für Embeddings)
    embeddings?: boolean;    // Implies store_bodies=true (Embeddings brauchen Bodies)
    // LLM-layer config (v1.25). Persisted per project in global.db.
    llm_endpoint?: string;
    llm_model?: string;
    llm_send_code?: boolean;
}

export interface InitResult {
    success: boolean;
    indexPath: string;
    filesIndexed: number;
    filesSkipped: number;  // Unchanged files
    filesRemoved: number;  // Files removed due to exclude patterns
    /**
     * a9d43516: files with legitimately nothing to index (e.g. an Astro
     * component with no frontmatter fence). Not counted in filesIndexed (no
     * file row is inserted for them) and never reported in errors[] -- this
     * is the normal, third outcome between "indexed" and "failed".
     */
    filesEmpty?: number;
    itemsFound: number;
    methodsFound: number;
    typesFound: number;
    durationMs: number;
    /**
     * True when this run reindexed everything because the index did not declare
     * current literal coverage. Reported, never inferred: the caller asked for
     * an incremental pass and got a full one, which costs real time (23 s on a
     * 702-file Rust project) and wipes before it rebuilds.
     */
    literalCoverageUpgraded?: boolean;
    errors: string[];
    embeddings?: {
        embedded: number;
        skipped: number;
        removed: number;
        durationMs: number;
    };
}

// ============================================================
// Success-mode contract (a7039829)
//
// WHY: init() used to hardcode `success: true` on its main return path no
// matter what errors[] accumulated during the per-file indexing loop --
// a file that genuinely failed in production filled errors[] invisibly
// while the caller saw "Done!" and a silently-reduced Files count. Fixed in
// two parts: (a) errors[] is now always surfaced to the caller, success or
// not (see the CLI init printer in src/index.ts and handleInit in
// src/server/tools.ts, which already did this); (b) success itself can now
// react to errors[], gated behind ONE env var so existing callers are not
// silently changed underneath them.
//
// AIDEX_SUCCESS_MODE is the single choke point the value flows through --
// resolveSuccessMode() is the only place that reads process.env, and
// computeInitSuccess() is the only place that branches on the resolved
// mode. Renaming a mode identifier later costs one line in each.
//
// bfb7bf8f (2nd pass): originally AIDEX_INIT_SUCCESS_MODE, scoped to init()
// only. Widened by explicit operator arbitration to also gate rebuild-index
// (src/index.ts) -- which needed no new plumbing, since rebuild-index's CLI
// branch already calls this same init() on every run and therefore already
// went through resolveSuccessMode()/computeInitSuccess() by construction.
// The rename is the only substantive change; AIDEX_INIT_SUCCESS_MODE is kept
// as a back-compat alias (new name wins if both are set) so existing
// operator config does not silently stop working.
// ============================================================

export type InitSuccessMode = 'default' | 'empty' | 'strict';

/** Counts computeInitSuccess() needs; kept separate from InitResult so the
 *  decision function can be unit-tested without constructing a full result. */
export interface InitSuccessCounts {
    /** Candidate files matched by the glob, before the indexing loop (`files.length`). */
    filesFound: number;
    filesIndexed: number;
    /** Unchanged files short-circuited by the incremental hash-diff -- NOT a failure. */
    filesSkipped: number;
    errorCount: number;
}

/**
 * Resolves AIDEX_SUCCESS_MODE, falling back to the deprecated
 * AIDEX_INIT_SUCCESS_MODE alias when the new name is unset. If BOTH are set,
 * the new name wins. Unset (both) or exactly 'default' -> 'default'.
 * Anything else that is not one of the three known modes THROWS -- a typo'd
 * or stale value must never silently fall back to 'default', because that
 * would reintroduce exactly the invisible-bad-state failure mode this card
 * exists to fix, one layer up (a misconfigured mode instead of a hardcoded
 * success). Both the CLI (`main().catch` in src/index.ts) and the MCP
 * dispatcher (`handleToolCall`'s try/catch in src/server/tools.ts) already
 * turn a thrown Error into a visible, non-zero-exit / error-text response,
 * so throwing here is safe in both callers without extra plumbing.
 */
export function resolveSuccessMode(raw: string | undefined, legacyRaw?: string | undefined): InitSuccessMode {
    const effective = raw !== undefined && raw !== '' ? raw : legacyRaw;
    const envName = raw !== undefined && raw !== '' ? 'AIDEX_SUCCESS_MODE' : 'AIDEX_INIT_SUCCESS_MODE';
    if (effective === undefined || effective === '') return 'default';
    if (effective === 'default' || effective === 'empty' || effective === 'strict') return effective;
    throw new Error(
        `Invalid ${envName} "${effective}": expected "default", "empty" or "strict".`
    );
}

/**
 * Decides `InitResult.success` for the main (non-early-return) return path.
 *
 * - 'default': unchanged from before this card -- always true here. Per-file
 *   errors are visible via errors[] (deliverable A) but never flip success,
 *   so nothing that already parses `success` changes behavior silently.
 * - 'empty': false when the indexing loop produced NOTHING usable despite
 *   candidates existing -- neither a fresh index (filesIndexed) nor a
 *   confirmed-unchanged skip (filesSkipped). Deliberately NOT just
 *   `filesIndexed === 0` (the card's literal wording): an idempotent re-run
 *   over an already-up-to-date project also has filesIndexed === 0, with
 *   filesSkipped === filesFound, and that is success, not the "total
 *   failure" this mode targets (a run where every candidate file failed or
 *   something crashed before either counter could move). Flagged to the
 *   team-lead as a deliberate refinement of the literal spec, not a
 *   reinterpretation of its intent: a raw `filesIndexed === 0` check would
 *   make 'empty'/'strict' fire on every no-op re-run of a healthy project.
 * - 'strict': false as soon as any error was recorded, AND (monotonicity)
 *   also covers 'empty's condition -- a total wipeout with zero errors[]
 *   entries must not escape the most severe mode, or the severity scale
 *   stops being monotonic (strict would be "beaten" by a subtler failure
 *   that 'empty' alone would have caught).
 */
export function computeInitSuccess(mode: InitSuccessMode, counts: InitSuccessCounts): boolean {
    const totalFailure = counts.filesFound > 0 && counts.filesIndexed === 0 && counts.filesSkipped === 0;
    switch (mode) {
        case 'default':
            return true;
        case 'empty':
            return !totalFailure;
        case 'strict':
            return counts.errorCount === 0 && !totalFailure;
    }
}

// ============================================================
// Default patterns
// ============================================================

export const DEFAULT_EXCLUDE = [
    // Package managers
    '**/node_modules/**',
    '**/vendor/**',          // PHP Composer, Go
    '**/vendor/bundle/**',   // Ruby Bundler
    // Build output
    '**/bin/**',
    '**/obj/**',
    '**/bld/**',             // Alternative build folder
    '**/build/**',
    '**/dist/**',
    '**/out/**',             // VS Code, some TS configs
    '**/target/**',          // Rust, Maven
    '**/Debug/**',           // Visual Studio
    '**/Release/**',         // Visual Studio
    '**/x64/**',             // Visual Studio
    '**/x86/**',             // Visual Studio
    '**/[Aa][Rr][Mm]/**',    // Visual Studio ARM
    '**/[Aa][Rr][Mm]64/**',  // Visual Studio ARM64
    '**/__pycache__/**',     // Python
    '**/.pyc',               // Python bytecode
    '**/venv/**',            // Python virtual env
    '**/.venv/**',           // Python virtual env
    '**/env/**',             // Python virtual env
    '**/*.egg-info/**',      // Python package metadata
    '**/site-packages/**',   // Python installed packages
    '**/Lib/**',             // Embedded Python standard library
    '**/fdk-aac/**',         // Fraunhofer AAC codec (external)
    // IDE/Editor
    '**/.git/**',
    '**/.vs/**',
    '**/.idea/**',
    '**/.vscode/**',
    // Framework-specific
    '**/.next/**',           // Next.js
    '**/coverage/**',        // Test coverage
    '**/tmp/**',             // Ruby, temp files
    '**/.terraform/**',      // Terraform downloaded modules + state cache
    // Generated files
    '**/*.min.js',
    '**/*.generated.*',
    '**/*.g.cs',             // C# source generators
    '**/*.Designer.cs',      // WinForms designer
];

// ============================================================
// .gitignore support
// ============================================================

export function readGitignore(projectPath: string): string[] {
    const gitignorePath = join(projectPath, '.gitignore');
    if (!existsSync(gitignorePath)) return [];

    const content = readFileSync(gitignorePath, 'utf-8');
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))  // Skip comments, empty lines, and negation patterns
        .map(pattern => {
            // Glob-kompatibel machen
            if (pattern.endsWith('/')) {
                return `**/${pattern}**`;  // Verzeichnis: foo/ → **/foo/**
            }
            if (!pattern.includes('/') && !pattern.startsWith('*')) {
                return `**/${pattern}`;    // Datei/Ordner: foo → **/foo
            }
            return pattern;
        });
}

function parseIgnoreFile(filePath: string): string[] {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf-8');
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
        .map(pattern => {
            if (pattern.endsWith('/')) return `**/${pattern}**`;
            if (!pattern.includes('/') && !pattern.startsWith('*')) return `**/${pattern}`;
            return pattern;
        });
}

// Binary/asset extensions always excluded from embeddings
const EMBED_BINARY_EXCLUDE = [
    '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.ico', '**/*.webp',
    '**/*.svg', '**/*.bmp', '**/*.tiff', '**/*.exr', '**/*.psd', '**/*.afphoto',
    '**/*.mp3', '**/*.mp4', '**/*.wav', '**/*.ogg', '**/*.webm', '**/*.flac',
    '**/*.m4a', '**/*.aac',
    '**/*.dll', '**/*.so', '**/*.dylib', '**/*.exe', '**/*.bin', '**/*.obj',
    '**/*.pdb', '**/*.lib', '**/*.a', '**/*.o',
    '**/*.zip', '**/*.tar', '**/*.gz', '**/*.rar', '**/*.7z',
    '**/*.pdf', '**/*.doc', '**/*.docx', '**/*.xls', '**/*.xlsx',
    '**/*.ttf', '**/*.otf', '**/*.woff', '**/*.woff2', '**/*.eot',
    '**/*.fbx', '**/*.obj', '**/*.glb', '**/*.gltf', '**/*.blend',
    '**/*.onnx', '**/*.pt', '**/*.nn', '**/*.tflite',
    '**/*.meta', '**/*.asset', '**/*.prefab', '**/*.unity', '**/*.mat',
    '**/*.lock',
];

/**
 * Returns embed-exclude patterns for a project.
 * Falls back to .aidexignore patterns if no .aidexembedignore exists.
 * Always adds binary/asset exclusions on top.
 */
export function readAidexEmbedIgnore(projectPath: string): string[] {
    const embedIgnorePath = join(projectPath, '.aidexembedignore');
    const base = existsSync(embedIgnorePath)
        ? parseIgnoreFile(embedIgnorePath)
        : parseIgnoreFile(join(projectPath, '.aidexignore'));
    return [...EMBED_BINARY_EXCLUDE, ...base];
}

// ============================================================
// File type detection
// ============================================================

const CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.astro',
    '.cs', '.rs', '.py', '.pyw',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
    '.java', '.go', '.php', '.rb', '.rake',
    '.tf', '.tfvars', '.hcl',
    '.kt', '.kts', '.swift',
]);

const CONFIG_EXTENSIONS = new Set([
    '.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.env', '.config',
    '.eslintrc', '.prettierrc', '.babelrc', '.editorconfig'
]);

const DOC_EXTENSIONS = new Set([
    '.md', '.txt', '.rst', '.adoc', '.doc', '.docx', '.pdf'
]);

const ASSET_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm',
    '.zip', '.tar', '.gz', '.rar'
]);

type FileType = 'dir' | 'code' | 'config' | 'doc' | 'asset' | 'test' | 'other';

function detectFileType(filePath: string): FileType {
    const ext = extname(filePath).toLowerCase();
    const lowerPath = filePath.toLowerCase();

    // Check for test files first (before code check)
    if (lowerPath.includes('.test.') || lowerPath.includes('.spec.') ||
        lowerPath.includes('_test.') || lowerPath.includes('_spec.') ||
        lowerPath.includes('/test/') || lowerPath.includes('/tests/') ||
        lowerPath.includes('/__tests__/')) {
        return 'test';
    }

    if (CODE_EXTENSIONS.has(ext)) return 'code';
    if (CONFIG_EXTENSIONS.has(ext)) return 'config';
    if (DOC_EXTENSIONS.has(ext)) return 'doc';
    if (ASSET_EXTENSIONS.has(ext)) return 'asset';

    return 'other';
}

// ============================================================
// Main init function
// ============================================================

export async function init(params: InitParams): Promise<InitResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    // Resolved once, up front, regardless of what params.path turns out to
    // be -- an operator who typo'd the env var deserves that surfaced
    // immediately, not only on the runs that happen to reach the main
    // return path (see computeInitSuccess() above for how this is used).
    const successMode = resolveSuccessMode(process.env.AIDEX_SUCCESS_MODE, process.env.AIDEX_INIT_SUCCESS_MODE);

    // Validate project path
    if (!existsSync(params.path)) {
        return {
            success: false,
            indexPath: '',
            filesIndexed: 0,
            filesSkipped: 0,
            filesRemoved: 0,
            itemsFound: 0,
            methodsFound: 0,
            typesFound: 0,
            durationMs: Date.now() - startTime,
            errors: [`Project path does not exist: ${params.path}`],
        };
    }

    // Resolve the project path ONCE, here, before anything reads it.
    //
    // A relative path works fine for indexing -- and then leaks. `basename('.')`
    // is '.', so `rebuild-index .` registered a project literally named '.'
    // pointing at '.', a phantom duplicate of the real one; the same string went
    // into `metadata.project_root`, where it means nothing once the cwd that
    // gave it meaning is gone. Everything downstream (project name, project_root,
    // the global registry, the reported index path) reads `params.path`, so
    // normalising it at the entrance fixes all of them at once instead of
    // sprinkling resolve() at each use.
    const resolvedPath = resolve(params.path);
    params = { ...params, path: resolvedPath };

    const stat = statSync(params.path);
    if (!stat.isDirectory()) {
        return {
            success: false,
            indexPath: '',
            filesIndexed: 0,
            filesSkipped: 0,
            filesRemoved: 0,
            itemsFound: 0,
            methodsFound: 0,
            typesFound: 0,
            durationMs: Date.now() - startTime,
            errors: [`Path is not a directory: ${params.path}`],
        };
    }

    // Create index directory
    const indexDir = join(params.path, INDEX_DIR);
    if (!existsSync(indexDir)) {
        mkdirSync(indexDir, { recursive: true });
    }

    const dbPath = join(indexDir, 'index.db');
    const projectName = params.name ?? basename(params.path);

    // Determine if incremental (default) or fresh re-index.
    const dbExists = existsSync(dbPath);

    // ---- literal-coverage migration -------------------------------------
    // Operator decision, 2026-08-11, reversing the more conservative reading
    // taken when Lot 3 landed: `init` IS the migration path, and an agent may
    // trigger it. The reason is that the conservative version was treacherous
    // in the other direction -- an agent reindexes, is told the index is fresh,
    // and the index stays silent about literals with nothing saying so.
    //
    // An index that does not declare CURRENT literal coverage (schema below
    // 1.3, no record, or a record written under another rule) cannot be brought
    // up to date file by file: the unchanged files are precisely the ones whose
    // literals were never extracted, and they are exactly the ones the per-file
    // hash skip would skip. So the run ignores the hash skip and reindexes
    // everything. `rebuild-index` remains, for forcing a rebuild of an index
    // that is already current.
    let literalCoverageUpgraded = false;
    if (dbExists && !params.fresh) {
        try {
            literalCoverageUpgraded = withDatabase(
                dbPath, true, (peek) => !readCoverage(peek).literalsIndexed
            );
        } catch {
            // An unreadable index is not a migration signal. Leave the mode
            // alone and let the normal path report whatever is wrong.
            literalCoverageUpgraded = false;
        }
    }

    const incremental = dbExists && !params.fresh && !literalCoverageUpgraded;

    // Create database (incremental keeps existing data)
    const db = createDatabase(dbPath, projectName, params.path, incremental);
    const queries = createQueries(db);

    // Determine store_bodies setting (precedence: explicit param > embeddings flag > metadata > default false)
    const storedFlag = db.getMetadata('store_bodies');
    const storeBodies =
        params.store_bodies === true || params.embeddings === true
            ? true
            : params.store_bodies === false
                ? false
                : storedFlag === '1';
    db.setMetadata('store_bodies', storeBodies ? '1' : '0');

    // Build glob pattern for supported files
    const extensions = getSupportedExtensions();
    const patterns = extensions.map(ext => `**/*${ext}`);

    // Merge exclude patterns (including .gitignore)
    const gitignorePatterns = readGitignore(params.path);
    const exclude = [...DEFAULT_EXCLUDE, ...gitignorePatterns, ...(params.exclude ?? [])];

    // Find all source files
    let files: string[] = [];
    for (const pattern of patterns) {
        const found = await glob(pattern, {
            cwd: params.path,
            ignore: exclude,
            nodir: true,
            absolute: false,
        });
        files.push(...found);
    }

    // Remove duplicates, normalize to forward slashes, and sort
    files = [...new Set(files)].map(f => f.replace(/\\/g, '/')).sort();

    // Index each file
    let filesIndexed = 0;
    let filesSkipped = 0;
    // a9d43516: files with legitimately nothing to index (e.g. a fenceless
    // Astro component) -- tracked apart from filesIndexed (no file row was
    // inserted for them, see indexFile's early return) and apart from
    // errors[] (this is not a failure). Keeps the three outcomes -- indexed,
    // nothing to index, failed -- distinguishable instead of collapsing the
    // "normal, empty" case into either of the other two.
    let filesEmpty = 0;
    let totalItems = 0;
    let totalMethods = 0;
    let totalTypes = 0;
    /** Literal coverage, accumulated per language across this run (Lot 3). */
    const literalStats = new Map<string, { seen: number; indexed: number }>();

    // Use transaction for bulk insert
    db.transaction(() => {
        for (const filePath of files) {
            try {
                const result = indexFile(params.path, filePath, db, queries, incremental, storeBodies);
                if (result.skipped) {
                    filesSkipped++;
                } else if (result.empty) {
                    filesEmpty++;
                } else if (result.success) {
                    filesIndexed++;
                    totalItems += result.items;
                    totalMethods += result.methods;
                    totalTypes += result.types;
                    if (result.language) {
                        const stat = literalStats.get(result.language) ?? { seen: 0, indexed: 0 };
                        stat.seen += result.literalsSeen ?? 0;
                        stat.indexed += result.literalsIndexed ?? 0;
                        literalStats.set(result.language, stat);
                    }
                } else if (result.error) {
                    errors.push(`${filePath}: ${result.error}`);
                }
            } catch (err) {
                errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    });

    // Cleanup unused items
    queries.deleteUnusedItems();

    // --------------------------------------------------------
    // Cleanup: Remove files that are now excluded
    // (e.g., build/ was indexed before exclude pattern was added)
    // --------------------------------------------------------
    let filesRemoved = 0;
    const existingFiles = queries.getAllFiles();

    db.transaction(() => {
        for (const file of existingFiles) {
            // Check if this file path matches any exclude pattern
            const shouldExclude = exclude.some(pattern =>
                minimatch(file.path, pattern, { dot: true })
            );

            if (shouldExclude) {
                // Remove from index
                queries.clearFileData(file.id);
                queries.deleteFile(file.id);
                filesRemoved++;
            }
        }
    });

    if (filesRemoved > 0) {
        // Cleanup items that are now orphaned
        queries.deleteUnusedItems();
    }


    // Targets depend on the complete current declaration set.
    db.transaction(() => rebuildCandidateEdgeTargets(queries));
    // --------------------------------------------------------
    // Scan project structure (all files, not just code)
    // --------------------------------------------------------
    const indexedFilesSet = new Set(files);  // Code files we indexed

    // Find ALL files in project
    const allFiles = await glob('**/*', {
        cwd: params.path,
        ignore: exclude,
        nodir: true,
        absolute: false,
    });

    // Normalize paths and collect directories
    const directories = new Set<string>();
    const normalizedAllFiles = allFiles.map(f => f.replace(/\\/g, '/'));

    for (const filePath of normalizedAllFiles) {
        // Extract all parent directories
        const parts = filePath.split('/');
        for (let i = 1; i < parts.length; i++) {
            directories.add(parts.slice(0, i).join('/'));
        }
    }

    // Insert directories
    db.transaction(() => {
        for (const dir of directories) {
            queries.insertProjectFile(dir, 'dir', null, false);
        }

        // Insert all files with type detection
        for (const filePath of normalizedAllFiles) {
            const ext = extname(filePath).toLowerCase() || null;
            const fileType = detectFileType(filePath);
            const isIndexed = indexedFilesSet.has(filePath);
            queries.insertProjectFile(filePath, fileType, ext, isIndexed);
        }
    });

    // --------------------------------------------------------
    // Literal coverage (Lot 3): measured, then declared -- in that order
    // --------------------------------------------------------
    // Written ONLY after a run that read every file. An incremental run skips
    // unchanged files, so its figures describe the files that happened to have
    // changed, not the repository; publishing those as the index's coverage
    // would be a measurement of nothing presented as a measurement.
    //
    // `schema_version` moves to the current 1.4 here. It is part of the promise the
    // oracle reads back, so it must be made only once the literals are actually
    // in the tables: an interrupted reindex dies before this point, leaving the
    // prior version -- incomplete and honest about it, rather than complete-looking
    // and wrong.
    if (!incremental) {
        const perLanguage: CoverageRecord['perLanguage'] = {};
        for (const [language, stat] of literalStats) {
            // A language with zero literals is reported as 0% over 0 samples,
            // not omitted: the difference between "measured, none there" and
            // "never looked" is exactly what this record exists to preserve --
            // and `seen: 0` says which of the two this is.
            perLanguage[language] = {
                percent: stat.seen > 0
                    ? Math.round((stat.indexed / stat.seen) * 1000) / 10
                    : 0,
                seen: stat.seen,
                indexed: stat.indexed,
            };
        }
        const record: CoverageRecord = {
            ruleId: LITERAL_RULE_ID,
            ruleVersion: LITERAL_RULE_VERSION,
            perLanguage,
            measuredAt: Date.now(),
        };
        db.setMetadata(COVERAGE_METADATA_KEY, JSON.stringify(record));
        db.setMetadata('schema_version', '1.4');
    }

    // Reset session tracking after full re-index
    const now = Date.now().toString();
    db.setMetadata('last_session_start', now);
    db.setMetadata('last_session_end', now);
    db.setMetadata('current_session_start', now);

    db.close();

    // Update global registry if it exists
    tryUpdateGlobalRegistry(params.path, {
        files: filesIndexed,
        items: totalItems,
        methods: totalMethods,
        types: totalTypes,
    });

    // Invalidate global query cache so next search sees fresh data
    invalidateGlobalCache();

    // Optional: build/refresh embeddings for this project.
    // Runs entirely in a child process (enable + index) so an ONNX OOM crash
    // cannot kill the MCP server.
    let embeddingsResult: InitResult['embeddings'];
    if (params.embeddings === true) {
        try {
            const r = await indexProjectInWorker(params.path);
            embeddingsResult = {
                embedded: r.embedded,
                skipped: r.skipped,
                removed: r.removed,
                durationMs: r.durationMs,
            };
        } catch (err) {
            errors.push(
                `Embeddings: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    // Optional: persist LLM-layer configuration on the project row.
    if (
        params.llm_endpoint !== undefined ||
        params.llm_model !== undefined ||
        params.llm_send_code !== undefined
    ) {
        try {
            await persistLlmConfig(params.path, params);
        } catch (err) {
            errors.push(
                `LLM config: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    return {
        success: computeInitSuccess(successMode, {
            filesFound: files.length,
            filesIndexed,
            filesSkipped,
            errorCount: errors.length,
        }),
        indexPath: indexDir,
        filesIndexed,
        filesSkipped,
        filesRemoved,
        filesEmpty,
        itemsFound: totalItems,
        methodsFound: totalMethods,
        typesFound: totalTypes,
        durationMs: Date.now() - startTime,
        literalCoverageUpgraded,
        errors,
        embeddings: embeddingsResult,
    };
}

// ============================================================
// File indexing
// ============================================================

interface IndexFileResult {
    success: boolean;
    skipped?: boolean;
    /**
     * a9d43516: this file legitimately has nothing to index (e.g. an Astro
     * component with no frontmatter fence at all) -- a NORMAL outcome,
     * distinct from both an ordinary successful extraction and a parse
     * failure. Never paired with `error`.
     */
    empty?: boolean;
    emptyReason?: string;
    items: number;
    methods: number;
    types: number;
    /** Language of the file, and what its literal pass saw (Lot 3 measurement). */
    language?: string;
    literalsSeen?: number;
    literalsIndexed?: number;
    error?: string;
}

function indexFile(
    projectPath: string,
    relativePath: string,
    db: AiDexDatabase,
    queries: Queries,
    incremental: boolean = false,
    storeBodies: boolean = false
): IndexFileResult {
    const absolutePath = join(projectPath, relativePath);

    // Read file content
    let content: string;
    try {
        content = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
        return {
            success: false,
            items: 0,
            methods: 0,
            types: 0,
            error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // Calculate hash
    const hash = shortHash(content);

    // In incremental mode, skip unchanged files
    if (incremental) {
        const existingFile = queries.getFileByPath(relativePath);
        if (existingFile && existingFile.hash === hash) {
            return {
                success: true,
                skipped: true,
                items: 0,
                methods: 0,
                types: 0,
            };
        }
        // File changed - clear old data before re-indexing
        if (existingFile) {
            queries.clearFileData(existingFile.id);
            queries.deleteFile(existingFile.id);
        }
    }

    // Extract data from file
    const extraction = extract(content, relativePath);
    if (!extraction) {
        // a9d43516: extract()/parseFile() return the SAME null for two
        // different situations -- "nothing to index here, this is normal"
        // and "this file failed to parse". A .astro file with no opening
        // frontmatter fence at all is the former: a pure-template component,
        // fully valid Astro, with no TypeScript frontmatter to extract. That
        // is not an indexing failure and must not surface in errors[]. A
        // .astro file that opens a frontmatter fence but never closes it is
        // still the latter (a real, reportable failure) -- this check only
        // widens the "empty" classification to the specific fenceless case,
        // it does not touch the generic error path used by every other
        // unparseable file, on Astro or any other language.
        if (relativePath.toLowerCase().endsWith('.astro') && astroHasNoFrontmatterFence(content)) {
            return {
                success: true,
                empty: true,
                emptyReason: 'astro-no-frontmatter',
                items: 0,
                methods: 0,
                types: 0,
            };
        }
        return {
            success: false,
            items: 0,
            methods: 0,
            types: 0,
            error: 'Unsupported file type or parse error',
        };
    }

    // Insert file record
    const fileId = queries.insertFile(relativePath, hash);

    // Split content into lines for hashing
    const contentLines = content.split('\n');
    const now = Date.now();

    // Insert lines with hash
    let lineId = 1;
    for (const line of extraction.lines) {
        const lineContent = contentLines[line.lineNumber - 1] ?? '';
        const lineHash = shortHash(lineContent);
        queries.insertLine(fileId, lineId++, line.lineNumber, line.lineType, lineHash, now);
    }

    // Build line number to line ID mapping
    const lineNumberToId = new Map<number, number>();
    lineId = 1;
    for (const line of extraction.lines) {
        lineNumberToId.set(line.lineNumber, lineId++);
    }

    // Insert items and occurrences
    const itemsInserted = new Set<string>();
    for (const item of extraction.items) {
        const lineIdForItem = lineNumberToId.get(item.lineNumber);
        if (lineIdForItem === undefined) {
            // Line wasn't recorded, add it now
            const newLineId = lineId++;
            const lineContent = contentLines[item.lineNumber - 1] ?? '';
            const lineHash = shortHash(lineContent);
            queries.insertLine(fileId, newLineId, item.lineNumber, item.lineType, lineHash, now);
            lineNumberToId.set(item.lineNumber, newLineId);
        }

        const itemId = queries.getOrCreateItem(item.term);
        const finalLineId = lineNumberToId.get(item.lineNumber)!;
        queries.insertOccurrence(itemId, fileId, finalLineId, item.kind);
        itemsInserted.add(item.term);
    }

    // Insert methods (with optional body storage)
    for (const method of extraction.methods) {
        queries.insertMethod(
            fileId,
            method.name,
            method.prototype,
            method.lineNumber,
            method.visibility,
            method.isStatic,
            method.isAsync,
            storeBodies ? method.bodyText : null,
            storeBodies ? method.bodyLines : null,
            storeBodies ? method.bodyTruncated : false
        );
    }

    // Insert types
    for (const type of extraction.types) {
        queries.insertType(fileId, type.name, type.kind, type.lineNumber);
    }


    for (const edge of extraction.edges) {
        queries.insertCandidateEdge(fileId, edge);
    }
    // Insert signature (header comments)
    if (extraction.headerComments.length > 0) {
        queries.insertSignature(fileId, extraction.headerComments.join('\n'));
    }

    return {
        success: true,
        items: itemsInserted.size,
        methods: extraction.methods.length,
        types: extraction.types.length,
        language: extraction.language,
        literalsSeen: extraction.literalStats.seen,
        literalsIndexed: extraction.literalStats.indexed,
    };
}

// ============================================================
// Global registry integration
// ============================================================

/**
 * Persist llm_endpoint / llm_model / llm_send_code on the project row in global.db.
 * Ensures the embedding-layer schema migration ran first so the columns exist.
 */
async function persistLlmConfig(
    projectPath: string,
    params: InitParams
): Promise<void> {
    const { ensureEmbeddingsSchema } = await import('../embeddings/store.js');
    ensureEmbeddingsSchema();

    const { openGlobalDatabase, globalDbExists } = await import('../db/global-database.js');
    if (!globalDbExists()) return;

    const gdb = openGlobalDatabase();
    try {
        const db = gdb.getDb();
        // Make sure the project is registered first (might be a fresh init).
        const exists = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath);
        if (!exists) return; // tryUpdateGlobalRegistry handles registration; nothing to update yet

        const sets: string[] = [];
        const vals: unknown[] = [];
        if (params.llm_endpoint !== undefined) {
            sets.push('llm_endpoint = ?');
            vals.push(params.llm_endpoint || null);
        }
        if (params.llm_model !== undefined) {
            sets.push('llm_model = ?');
            vals.push(params.llm_model || null);
        }
        if (params.llm_send_code !== undefined) {
            sets.push('llm_send_code = ?');
            vals.push(params.llm_send_code ? 1 : 0);
        }
        if (sets.length === 0) return;
        vals.push(projectPath);
        db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE path = ?`).run(...vals);
    } finally {
        gdb.close();
    }
}

/**
 * Update global registry after init/update. Fire-and-forget — errors are silently ignored.
 */
/**
 * Is this path inside the system temp directory?
 *
 * Used to keep throwaway indexes out of a permanent registry. The boundary is
 * checked at a separator, so a sibling directory named `Temp-projects` is not
 * mistaken for something inside `Temp`, and the comparison is
 * case-insensitive on Windows, where the same directory routinely appears with
 * different casing.
 */
export function isUnderSystemTemp(absPath: string): boolean {
    const norm = (p: string): string => {
        const r = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
        return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const temp = norm(tmpdir());
    const target = norm(absPath);
    return target === temp || target.startsWith(`${temp}/`);
}

function tryUpdateGlobalRegistry(projectPath: string, counts: { files: number; items: number; methods: number; types: number }): void {
    try {
        if (!globalDbExists()) return;

        // A project under the system temp directory is throwaway by
        // construction, so it has no business in a permanent registry. This is
        // not a test-only concern, but the test suite is what made it visible:
        // its fixtures call init(), so every `npm test` used to register one
        // entry per fixture in the user's global.db -- 91 dead rows in two days,
        // and six more the moment the registry was cleaned.
        if (isUnderSystemTemp(projectPath)) return;

        const stats = readProjectStats(projectPath);
        if (!stats) return;

        const globalDb = openGlobalDatabase();
        globalDb.registerProject(projectPath, basename(projectPath), stats);
        globalDb.close();
    } catch {
        // Silently ignore — global registry is optional
    }
}
