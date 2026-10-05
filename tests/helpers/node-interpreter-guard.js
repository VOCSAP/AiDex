/**
 * Node interpreter resolution and ABI-mismatch diagnosis, shared by every
 * test file that either loads AiDex's native addon (better-sqlite3) in the
 * Jest process itself, or spawns `node build/index.js ...` as a CLI child
 * process.
 *
 * WHY THIS EXISTS
 * The `node` on PATH in this environment resolves to the nvm4w junction,
 * which follows whatever version was last `nvm use`-d and is currently ABI-
 * incompatible with the compiled better-sqlite3 addon (see project CLAUDE.md
 * / test-engineer memory: pinned Node 22.11.0 required). A `node` from the
 * wrong major aborts with a raw ERR_DLOPEN_FAILED / NODE_MODULE_VERSION
 * stack that names none of this. This module mirrors the discovery
 * discipline already used by hooks/claude/aidex-grep-nudge.py (AIDEX_NODE
 * env override, then the interpreter path Claude Code itself is configured
 * with in ~/.claude.json's mcpServers.aidex.command, `node` as the last
 * resort) so every caller gets ONE consistent resolution, not a second
 * hand-rolled one per test file. First written for tests/query-corpus.test.js
 * (spec_fd1ed424), extracted here for tests/cli-update.test.js (spec_d9b6b402)
 * to reuse rather than duplicate.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Reads ~/.claude.json the same way discover_aidex() in
 * hooks/claude/aidex-grep-nudge.py does: top-level mcpServers.aidex.command
 * first, then each project's mcpServers.aidex.command. Returns the configured
 * node binary path (Claude Code's own MCP config points at the interpreter
 * this AiDex build was proven to run under), or null if nothing is found.
 * An unreadable or absent config is not a reason to block -- callers fall
 * through to their next candidate.
 */
export function discoverConfiguredAidexNode() {
    try {
        const cfgPath = join(homedir(), '.claude.json');
        if (!existsSync(cfgPath)) return null;
        const data = JSON.parse(readFileSync(cfgPath, 'utf-8'));
        const blocks = [data.mcpServers || {}];
        for (const proj of Object.values(data.projects || {})) {
            blocks.push((proj && proj.mcpServers) || {});
        }
        for (const servers of blocks) {
            const server = servers.aidex;
            if (server && server.command) return server.command;
        }
    } catch {
        // Unreadable config is not a reason to block; caller falls through.
    }
    return null;
}

/**
 * Candidate order: an explicit override wins over discovery, and the bare
 * `node` on PATH is the last resort -- useful when nothing else is
 * discoverable. This is a RESOLUTION (a best-effort path to try), not a
 * guarantee: the caller that spawns a child process with this result should
 * still expect it to fail if even the last resort is ABI-mismatched, which is
 * exactly what isNativeAbiMismatch()/nodeAbiGuardMessage() below diagnose.
 */
export function resolveAidexNode() {
    return process.env.AIDEX_NODE || discoverConfiguredAidexNode() || 'node';
}

/** True when `err` is the native-addon ABI mismatch this module exists to diagnose. */
export function isNativeAbiMismatch(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('NODE_MODULE_VERSION') || msg.includes('ERR_DLOPEN_FAILED');
}

/**
 * Turns a raw native-module stack into a message that NAMES the cause (this
 * process's own interpreter) and a concrete, non-hardcoded fix (the
 * interpreter AiDex's own MCP config already proves works).
 */
export function nodeAbiGuardMessage(err) {
    const configured = process.env.AIDEX_NODE || discoverConfiguredAidexNode();
    const suggestion = configured
        ? `The interpreter AiDex's own MCP config points at is:\n  ${configured}\nRe-run with that node (or export AIDEX_NODE=<that path> and prefix PATH with its directory) before invoking jest.`
        : 'No pinned interpreter could be discovered (no AIDEX_NODE env var, no ~/.claude.json mcpServers.aidex.command). Run `npm rebuild` against the current `node` to match its NODE_MODULE_VERSION, or set AIDEX_NODE to a node binary already built against this addon.';
    return (
        `Node interpreter ABI mismatch: this Jest run used ${process.execPath} (${process.version}), `
        + `but better-sqlite3's native addon was compiled for a different Node major. `
        + `${suggestion}\n\nUnderlying error: ${err instanceof Error ? err.message : String(err)}`
    );
}
