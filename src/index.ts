#!/usr/bin/env node
/**
 * AiDex - MCP Server Entry Point
 *
 * Provides persistent code indexing for Claude Code.
 *
 * Usage:
 *   node build/index.js                       - Start MCP server (default)
 *   node build/index.js scan <path>           - Scan for .aidex directories
 *   node build/index.js init <path>           - Index a project
 *   node build/index.js rebuild-index <path>  - Full rebuild, ignores the hash skip (operator-only)
 *   node build/index.js can <pattern> ...     - Coverage oracle: can AiDex answer this?
 *   node build/index.js global-init <path>    - Scan, index unindexed, register in global DB
 *   node build/index.js viewer <path>         - Open interactive Viewer in the browser
 */

// Node >=20 is required (better-sqlite3 v12 native bindings, fs.cpSync, etc.).
// npm only warns on `engines` mismatches — we enforce it at runtime so users
// on older Node versions get an immediate, actionable error instead of an
// opaque native-module crash later.
{
    const major = parseInt(process.versions.node.split('.')[0], 10);
    if (Number.isNaN(major) || major < 20) {
        process.stderr.write(
            `AiDex requires Node.js 20 or newer. You are running ${process.version}.\n` +
            `  macOS:  brew install node  (or: nvm install 20 && nvm use 20)\n` +
            `  Linux:  use your package manager or nvm (https://github.com/nvm-sh/nvm)\n` +
            `  Windows: https://nodejs.org/\n`
        );
        process.exit(1);
    }
}

// Only the constants are imported eagerly. Everything else loads on demand,
// because `can` runs once per candidate search command from a hook and pays for
// whatever this module pulls in at load time. Measured on this machine: static
// imports of the MCP server, the viewer, the log hub and the `commands` barrel
// cost 355 ms per spawn against 75 ms once the same branch loads only what it
// needs -- and the branch itself does 5 ms of real work.
import { PRODUCT_NAME, PRODUCT_NAME_LOWER } from './constants.js';

async function main() {
    const args = process.argv.slice(2);

    // CLI mode: can -- the coverage oracle. FIRST branch, and it imports exactly
    // one module, so the latency floor stays the Node process itself.
    //
    // Contract for a caller that decides whether to block a search:
    //   exit 0    -> stdout holds a verdict, negative verdicts included
    //   exit != 0 -> no verdict was produced; the caller must fail OPEN
    // A negative verdict is never encoded in the exit code, or it becomes
    // indistinguishable from the oracle being broken.
    if (args[0] === 'can') {
        const pattern = args[1];
        if (!pattern) {
            console.error(`Usage: ${PRODUCT_NAME_LOWER} can <pattern> [--project <dir>] [--path <file>]`);
            process.exit(2);
        }
        const projectFlag = args.indexOf('--project');
        const pathFlag = args.indexOf('--path');
        const projectPath = projectFlag !== -1 ? args[projectFlag + 1] : process.cwd();
        const target = pathFlag !== -1 ? args[pathFlag + 1] : undefined;

        try {
            const { can } = await import('./commands/coverage.js');
            console.log(JSON.stringify(can({ path: projectPath, pattern, target })));
            return;
        } catch (err) {
            console.error(JSON.stringify({
                covered: false,
                reason: 'oracle_error',
                error: err instanceof Error ? err.message : String(err),
            }));
            process.exit(2);
        }
    }

    // CLI mode: scan
    if (args[0] === 'scan') {
        const searchPath = args[1];
        if (!searchPath) {
            console.error(`Usage: ${PRODUCT_NAME_LOWER} scan <path>`);
            process.exit(1);
        }

        const { scan } = await import('./commands/scan.js');
        const result = scan({ path: searchPath });

        if (!result.success) {
            console.error(`Error: ${result.error}`);
            process.exit(1);
        }

        console.log(`\n${PRODUCT_NAME} Indexes Found: ${result.projects.length}`);
        console.log(`Scanned: ${result.scannedDirs} directories\n`);

        if (result.projects.length === 0) {
            console.log('No indexed projects found.');
        } else {
            for (const proj of result.projects) {
                console.log(`${proj.name}`);
                console.log(`  Path: ${proj.path}`);
                console.log(`  Files: ${proj.files} | Items: ${proj.items} | Methods: ${proj.methods} | Types: ${proj.types}`);
                console.log(`  Last indexed: ${proj.lastIndexed}`);
                console.log();
            }
        }

        return;
    }

    // CLI mode: init
    if (args[0] === 'init') {
        const projectPath = args[1];
        if (!projectPath) {
            console.error(`Usage: ${PRODUCT_NAME_LOWER} init <path>`);
            process.exit(1);
        }

        console.log(`Indexing: ${projectPath}`);
        const { init } = await import('./commands/init.js');
        const result = await init({ path: projectPath });

        if (!result.success) {
            console.error(`Error: ${result.errors.join(', ')}`);
            process.exit(1);
        }

        console.log(`Done!`);
        console.log(`  Files: ${result.filesIndexed}`);
        console.log(`  Items: ${result.itemsFound}`);
        console.log(`  Methods: ${result.methodsFound}`);
        console.log(`  Types: ${result.typesFound}`);
        console.log(`  Time: ${result.durationMs}ms`);

        return;
    }

    // CLI mode: rebuild-index -- FULL rebuild, ignores the per-file hash skip.
    //
    // Deliberately CLI-only and deliberately named for what it does. Reindexing
    // is an operator decision, never automatic: there is no sweep, no migration
    // on first query, no implicit rebuild. That is why this is not exposed as an
    // MCP tool -- an agent must not be able to trigger it from a normal flow.
    //
    // `fresh: true` clears `files` and `items` only; tasks, notes and metadata
    // survive (see db/database.ts createDatabase). If the run is interrupted the
    // index is simply incomplete and its schema_version does NOT advance, so the
    // honest per-index answer keeps applying until a run goes all the way through.
    if (args[0] === 'rebuild-index') {
        const projectPath = args[1];
        if (!projectPath) {
            console.error(`Usage: ${PRODUCT_NAME_LOWER} rebuild-index <path>`);
            console.error('Rebuilds the whole index from scratch, ignoring the per-file hash skip.');
            process.exit(1);
        }

        console.log(`Rebuilding index (full, no hash skip): ${projectPath}`);
        const { init } = await import('./commands/init.js');
        const result = await init({ path: projectPath, fresh: true });

        if (!result.success) {
            console.error(`Error: ${result.errors.join(', ')}`);
            process.exit(1);
        }

        console.log(`Done!`);
        console.log(`  Files: ${result.filesIndexed}`);
        console.log(`  Items: ${result.itemsFound}`);
        console.log(`  Time: ${result.durationMs}ms`);

        return;
    }

    // CLI mode: global-init
    if (args[0] === 'global-init') {
        const searchPath = args[1];
        if (!searchPath) {
            console.error(`Usage: ${PRODUCT_NAME_LOWER} global-init <path> [--index-unindexed]`);
            process.exit(1);
        }

        const indexUnindexed = args.includes('--index-unindexed');
        const showProgress = args.includes('--show-progress');

        console.log(`Scanning: ${searchPath}${indexUnindexed ? ' (will index unindexed projects)' : ''}${showProgress ? ' (with progress UI)' : ''}`);
        const { globalInit } = await import('./commands/global/index.js');
        const result = await globalInit({
            path: searchPath,
            indexUnindexed,
            showProgress,
        });

        if (!result.success) {
            console.error(`Error: ${result.error}`);
            process.exit(1);
        }

        console.log(`Done!`);
        console.log(`  Registered: ${result.registered}`);
        console.log(`  New: ${result.newProjects}`);
        console.log(`  Updated: ${result.updatedProjects}`);
        console.log(`  Removed: ${result.removedProjects}`);

        if (result.indexedResults && result.indexedResults.length > 0) {
            const ok = result.indexedResults.filter(r => r.success).length;
            const fail = result.indexedResults.filter(r => !r.success).length;
            console.log(`  Indexed: ${ok} succeeded, ${fail} failed`);
        }

        if (result.unindexedProjects.length > 0) {
            console.log(`\n  Unindexed projects found: ${result.unindexedProjects.length}`);
            for (const p of result.unindexedProjects) {
                console.log(`    ${p.name} (${p.path}) ~${p.estimatedFiles} files`);
            }
        }

        if (result.largeProjects && result.largeProjects.length > 0) {
            console.log(`\n  Large projects skipped (>500 files): ${result.largeProjects.length}`);
            for (const p of result.largeProjects) {
                console.log(`    ${p.name} (${p.path}) ~${p.estimatedFiles} files`);
            }
        }

        console.log(`\n  Totals: ${result.totals.projects} projects | ${result.totals.files} files | ${result.totals.methods} methods | ${result.totals.types} types`);
        return;
    }

    // CLI mode: viewer
    if (args[0] === 'viewer') {
        const projectPath = args[1] || process.cwd();
        const tabArg = args.find(a => a.startsWith('--tab='));
        const initialTab = tabArg ? tabArg.slice('--tab='.length) : undefined;

        console.log(`Starting Viewer for: ${projectPath}`);
        const { startViewer, stopViewer } = await import('./viewer/server.js');
        let result: string;
        try {
            result = await startViewer(projectPath, initialTab, { exitOnLastClientClose: true });
            console.log(result);
        } catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }

        // If the port was already in use, another viewer instance is serving.
        // We just opened the browser — no need to keep this CLI process alive.
        // Exit code 2 signals "already running" so the launcher can keep its
        // console window open for the user to read the message.
        // Small delay so the detached browser-spawn definitely completes before
        // this process (and any inherited stdio) goes away.
        if (result.includes('already in use')) {
            await new Promise(r => setTimeout(r, 400));
            process.exit(2);
        }

        console.log('Server runs until you close the browser tab or press Ctrl+C.');

        // Keep the process alive — the viewer runs until SIGINT.
        const shutdownViewer = () => {
            try { console.log(stopViewer()); } catch { /* ignore */ }
            process.exit(0);
        };
        process.on('SIGINT', shutdownViewer);
        process.on('SIGTERM', shutdownViewer);
        return;
    }

    // CLI mode: setup
    if (args[0] === 'setup') {
        const { setupMcpClients } = await import('./commands/setup.js');
        setupMcpClients();
        return;
    }

    // CLI mode: unsetup
    if (args[0] === 'unsetup') {
        const { unsetupMcpClients } = await import('./commands/setup.js');
        unsetupMcpClients();
        return;
    }

    // Default: Start MCP server
    const { createServer } = await import('./server/mcp-server.js');
    const { freeLogHub } = await import('./loghub/log-server.js');
    const { stopViewer } = await import('./viewer/server.js');
    const server = createServer();

    // Graceful shutdown handlers
    const shutdown = () => {
        freeLogHub();
        stopViewer();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    await server.start();
}

main().catch((error) => {
    console.error(`Failed to start ${PRODUCT_NAME}:`, error);
    process.exit(1);
});
