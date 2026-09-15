/**
 * AiDex Setup - Auto-register as MCP server in AI clients
 *
 * Supports: Claude Code (via CLI), Claude Desktop, Cursor, Windsurf, Gemini CLI, VS Code Copilot
 * Also installs CLAUDE.md instructions for Claude Code/Desktop.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir, platform } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// ============================================================
// Types
// ============================================================

interface JsonClientInfo {
    type: 'json';
    name: string;
    configPath: string;
    detectDir: string;
    serversKey?: string;      // default: 'mcpServers'
    extraFields?: Record<string, string>;  // extra fields per entry, e.g. { type: 'stdio' }
}

interface CliClientInfo {
    type: 'cli';
    name: string;
    detectCmd: string;
    addCmd: string[];
    removeCmd: string[];
}

type ClientInfo = JsonClientInfo | CliClientInfo;

// ============================================================
// MCP Server Command Detection
// ============================================================

function getServerCommand(): { command: string; args: string[] } {
    // Check if 'aidex' is available as a global command
    try {
        execSync(platform() === 'win32' ? 'where aidex' : 'which aidex', { stdio: 'pipe', timeout: 3000 });
        return { command: 'aidex', args: [] };
    } catch {
        // Not globally installed - use node with full path to index.js
    }

    const thisFile = fileURLToPath(import.meta.url);
    const indexJs = resolve(dirname(thisFile), '..', 'index.js');
    return { command: process.execPath, args: [indexJs] };
}

// ============================================================
// CLAUDE.md Instructions Block
// ============================================================

const CLAUDE_MD_START = '<!-- AIDEX-START -->';
const CLAUDE_MD_END = '<!-- AIDEX-END -->';

export const CLAUDE_MD_BLOCK = `${CLAUDE_MD_START}
## AiDex - Persistent Code Index

In a project that has a \`.aidex/\` directory, search code with AiDex instead of Grep/Glob/Read:
- Known identifier: \`aidex_query term="X"\` (\`mode="contains"\`, \`modified_since="2h"\`, \`file_filter="src/**"\`)
- File structure with line ranges: \`aidex_signature file="Y"\`, then Read only that range; many files: \`aidex_signatures pattern="src/**"\`
- Intent without a known name: \`aidex_search query="..."\`
- Files importing a JS/TS file: \`aidex_edges\`
- Overview: \`aidex_summary\`, \`aidex_tree\`, \`aidex_files\`, \`aidex_status\`
- After editing a file: \`aidex_update\`
- Screenshots: \`aidex_screenshot\` (start with \`scale: 0.5, colors: 2\`); window titles: \`aidex_windows\`

Grep and Read stay fine for config, logs and free text.

\`aidex\` is the AiDex command-line interface; it covers the rest:
- No \`.aidex/\` yet: \`aidex init <path>\`
- Session start (external changes, session note): \`aidex session <path>\`
- Drop a file from the index: \`aidex remove <path> <file>\`
- All projects: \`aidex global-init <path>\`, \`aidex global-status\`, \`aidex global-refresh\`
- Viewer and settings: \`aidex viewer <path>\`, \`aidex settings <path> --open\`
- Every subcommand lists its options with \`--help\`.
${CLAUDE_MD_END}`;

// ============================================================
// Client Detection
// ============================================================

function getClients(): ClientInfo[] {
    const home = homedir();
    const plat = platform();
    const clients: ClientInfo[] = [];

    // Claude Code - uses its own CLI for MCP management
    const serverCmd = getServerCommand();
    const cliAddCmd = ['claude', 'mcp', 'add', '--scope', 'user', 'aidex', '--', serverCmd.command, ...serverCmd.args];
    clients.push({
        type: 'cli',
        name: 'Claude Code',
        detectCmd: 'claude --version',
        addCmd: cliAddCmd,
        removeCmd: ['claude', 'mcp', 'remove', '--scope', 'user', 'aidex']
    });

    // Claude Desktop - JSON config
    if (plat === 'win32') {
        const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
        clients.push({
            type: 'json',
            name: 'Claude Desktop',
            configPath: join(appData, 'Claude', 'claude_desktop_config.json'),
            detectDir: join(appData, 'Claude')
        });
    } else if (plat === 'darwin') {
        clients.push({
            type: 'json',
            name: 'Claude Desktop',
            configPath: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
            detectDir: join(home, 'Library', 'Application Support', 'Claude')
        });
    } else {
        clients.push({
            type: 'json',
            name: 'Claude Desktop',
            configPath: join(home, '.config', 'Claude', 'claude_desktop_config.json'),
            detectDir: join(home, '.config', 'Claude')
        });
    }

    // Cursor - JSON config
    clients.push({
        type: 'json',
        name: 'Cursor',
        configPath: join(home, '.cursor', 'mcp.json'),
        detectDir: join(home, '.cursor')
    });

    // Windsurf - JSON config
    clients.push({
        type: 'json',
        name: 'Windsurf',
        configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
        detectDir: join(home, '.codeium', 'windsurf')
    });

    // Gemini CLI - JSON config (always uses ~/.gemini/ on all platforms)
    clients.push({
        type: 'json',
        name: 'Gemini CLI',
        configPath: join(home, '.gemini', 'settings.json'),
        detectDir: join(home, '.gemini')
    });

    // VS Code Copilot - JSON config (uses "servers" key + "type": "stdio")
    if (plat === 'win32') {
        const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
        clients.push({
            type: 'json',
            name: 'VS Code',
            configPath: join(appData, 'Code', 'User', 'mcp.json'),
            detectDir: join(appData, 'Code', 'User'),
            serversKey: 'servers',
            extraFields: { type: 'stdio' }
        });
    } else if (plat === 'darwin') {
        clients.push({
            type: 'json',
            name: 'VS Code',
            configPath: join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
            detectDir: join(home, 'Library', 'Application Support', 'Code', 'User'),
            serversKey: 'servers',
            extraFields: { type: 'stdio' }
        });
    } else {
        clients.push({
            type: 'json',
            name: 'VS Code',
            configPath: join(home, '.config', 'Code', 'User', 'mcp.json'),
            detectDir: join(home, '.config', 'Code', 'User'),
            serversKey: 'servers',
            extraFields: { type: 'stdio' }
        });
    }

    return clients;
}

// ============================================================
// CLI helpers
// ============================================================

function isCmdAvailable(cmd: string): boolean {
    try {
        execSync(cmd, { stdio: 'pipe', timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

function runCmd(args: string[]): { success: boolean; output?: string; error?: string } {
    try {
        const output = execSync(args.join(' '), { stdio: 'pipe', timeout: 10000 }).toString().trim();
        return { success: true, output };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
    }
}

// ============================================================
// JSON Config Read/Write
// ============================================================

function readJsonConfig(filePath: string): { success: boolean; data?: Record<string, unknown>; error?: string } {
    try {
        const content = readFileSync(filePath, 'utf8');
        return { success: true, data: JSON.parse(content) };
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { success: false, error: 'not found' };
        }
        if (err instanceof SyntaxError) {
            return { success: false, error: `invalid JSON: ${err.message}` };
        }
        return { success: false, error: String(err) };
    }
}

function writeJsonConfig(filePath: string, data: Record<string, unknown>): { success: boolean; error?: string } {
    try {
        const content = JSON.stringify(data, null, 2) + '\n';
        writeFileSync(filePath, content, 'utf8');
        return { success: true };
    } catch (err: unknown) {
        return { success: false, error: String(err) };
    }
}

// ============================================================
// AI Instructions Management (CLAUDE.md, GEMINI.md)
// ============================================================

export interface InstructionFile {
    name: string;
    path: string;
    detectDir: string;
}

function getInstructionFiles(): InstructionFile[] {
    const home = homedir();
    return [
        {
            name: 'CLAUDE.md',
            path: join(home, '.claude', 'CLAUDE.md'),
            detectDir: join(home, '.claude')
        },
        {
            name: 'GEMINI.md',
            path: join(home, '.gemini', 'GEMINI.md'),
            detectDir: join(home, '.gemini')
        }
    ];
}

export function installInstructionFile(file: InstructionFile): { success: boolean; action: string } {
    if (!existsSync(file.detectDir)) {
        return { success: true, action: 'skipped (not installed)' };
    }

    const dir = dirname(file.path);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    let content = '';
    if (existsSync(file.path)) {
        content = readFileSync(file.path, 'utf8');

        // Already has AiDex block with markers? Replace it
        if (content.includes(CLAUDE_MD_START)) {
            const regex = new RegExp(`${CLAUDE_MD_START}[\\s\\S]*?${CLAUDE_MD_END}`, 'g');
            content = content.replace(regex, CLAUDE_MD_BLOCK);
            writeFileSync(file.path, content, 'utf8');
            return { success: true, action: 'updated' };
        }

        // Already has manual AiDex instructions (without markers)? Skip to avoid duplicates
        if (content.includes('aidex_query')) {
            return { success: true, action: 'skipped (existing AiDex instructions found)' };
        }

        // Append to existing file
        content = content.trimEnd() + '\n\n' + CLAUDE_MD_BLOCK + '\n';
        writeFileSync(file.path, content, 'utf8');
        return { success: true, action: 'appended' };
    }

    // Create new file
    writeFileSync(file.path, CLAUDE_MD_BLOCK + '\n', 'utf8');
    return { success: true, action: 'created' };
}

export function uninstallInstructionFile(file: InstructionFile): { success: boolean; removed: boolean } {
    if (!existsSync(file.path)) {
        return { success: true, removed: false };
    }

    let content = readFileSync(file.path, 'utf8');

    if (!content.includes(CLAUDE_MD_START)) {
        return { success: true, removed: false };
    }

    const regex = new RegExp(`\\n?\\n?${CLAUDE_MD_START}[\\s\\S]*?${CLAUDE_MD_END}\\n?`, 'g');
    content = content.replace(regex, '').trim();

    if (content.length === 0) {
        writeFileSync(file.path, '', 'utf8');
    } else {
        writeFileSync(file.path, content + '\n', 'utf8');
    }

    return { success: true, removed: true };
}

// ============================================================
// Setup
// ============================================================

function setupCliClient(client: CliClientInfo): { status: string; registered: boolean } {
    if (!isCmdAvailable(client.detectCmd)) {
        return { status: `  - ${client.name} (not installed)`, registered: false };
    }

    const result = runCmd(client.addCmd);
    if (result.success) {
        return { status: `  ✓ ${client.name}`, registered: true };
    }

    // "already exists" is not an error
    if (result.error && result.error.includes('already exists')) {
        return { status: `  ✓ ${client.name} (already registered)`, registered: true };
    }

    return { status: `  ✗ ${client.name} (${result.error})`, registered: false };
}

function setupJsonClient(client: JsonClientInfo): { status: string; registered: boolean } {
    if (!existsSync(client.detectDir)) {
        return { status: `  - ${client.name} (not installed)`, registered: false };
    }

    let data: Record<string, unknown>;
    if (existsSync(client.configPath)) {
        const config = readJsonConfig(client.configPath);
        if (!config.success || !config.data) {
            return { status: `  ✗ ${client.name} (${config.error})`, registered: false };
        }
        data = config.data;
    } else {
        data = {};
    }

    const key = client.serversKey || 'mcpServers';
    if (!data[key] || typeof data[key] !== 'object') {
        data[key] = {};
    }
    const serverCmd = getServerCommand();
    const entry: Record<string, unknown> = { ...client.extraFields, ...serverCmd };
    (data[key] as Record<string, unknown>).aidex = entry;

    const writeResult = writeJsonConfig(client.configPath, data);
    if (!writeResult.success) {
        return { status: `  ✗ ${client.name} (${writeResult.error})`, registered: false };
    }

    return { status: `  ✓ ${client.name} (${client.configPath})`, registered: true };
}

export function setupMcpClients(): void {
    const clients = getClients();
    let registered = 0;

    console.log('\nAiDex MCP Server Registration');
    console.log('==============================\n');

    // Register with AI clients
    console.log('  MCP Servers:');
    for (const client of clients) {
        const result = client.type === 'cli'
            ? setupCliClient(client)
            : setupJsonClient(client);

        console.log(result.status);
        if (result.registered) registered++;
    }

    // Install AI instruction files
    console.log('\n  AI Instructions:');
    for (const file of getInstructionFiles()) {
        const mdResult = installInstructionFile(file);
        if (mdResult.action === 'skipped (not installed)') {
            console.log(`  - ${file.name} (client not installed)`);
        } else if (mdResult.success) {
            console.log(`  ✓ ${file.name} (${mdResult.action}: ${file.path})`);
        }
    }

    console.log(`\nRegistered AiDex with ${registered} client(s).\n`);

    if (registered > 0) {
        console.log('Restart your AI client(s) to activate AiDex.\n');
    }
}

// ============================================================
// Unsetup
// ============================================================

function unsetupCliClient(client: CliClientInfo): { status: string; removed: boolean } {
    if (!isCmdAvailable(client.detectCmd)) {
        return { status: `  - ${client.name} (not installed)`, removed: false };
    }

    const result = runCmd(client.removeCmd);
    if (result.success) {
        return { status: `  ✓ Removed from ${client.name}`, removed: true };
    } else {
        return { status: `  - ${client.name} (not registered)`, removed: false };
    }
}

function unsetupJsonClient(client: JsonClientInfo): { status: string; removed: boolean } {
    if (!existsSync(client.detectDir)) {
        return { status: `  - ${client.name} (not installed)`, removed: false };
    }

    if (!existsSync(client.configPath)) {
        return { status: `  - ${client.name} (not registered)`, removed: false };
    }

    const config = readJsonConfig(client.configPath);
    if (!config.success || !config.data) {
        return { status: `  ✗ ${client.name} (${config.error})`, removed: false };
    }

    const data = config.data as Record<string, unknown>;
    const key = client.serversKey || 'mcpServers';
    const servers = data[key] as Record<string, unknown> | undefined;

    if (!servers || !servers.aidex) {
        return { status: `  - ${client.name} (not registered)`, removed: false };
    }

    delete servers.aidex;

    const writeResult = writeJsonConfig(client.configPath, data);
    if (!writeResult.success) {
        return { status: `  ✗ ${client.name} (${writeResult.error})`, removed: false };
    }

    return { status: `  ✓ Removed from ${client.name}`, removed: true };
}

export function unsetupMcpClients(): void {
    const clients = getClients();
    let removed = 0;

    console.log('\nAiDex MCP Server Unregistration');
    console.log('================================\n');

    // Unregister from AI clients
    console.log('  MCP Servers:');
    for (const client of clients) {
        const result = client.type === 'cli'
            ? unsetupCliClient(client)
            : unsetupJsonClient(client);

        console.log(result.status);
        if (result.removed) removed++;
    }

    // Remove AI instruction files
    console.log('\n  AI Instructions:');
    for (const file of getInstructionFiles()) {
        const mdResult = uninstallInstructionFile(file);
        if (mdResult.removed) {
            console.log(`  ✓ Removed AiDex block from ${file.name}`);
        } else {
            console.log(`  - ${file.name} (no AiDex block found)`);
        }
    }

    console.log(`\nUnregistered AiDex from ${removed} client(s).\n`);
}
