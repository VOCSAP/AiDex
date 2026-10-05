import { TOOL_PREFIX } from '../constants.js';
import { parseToolArgs, toolUsage, type ToolInputSchema } from './tool-args.js';

interface ToolResponse {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
}

export async function toolSchema(tool: string): Promise<ToolInputSchema> {
    const { declaredTools } = await import('../server/tools.js');
    const found = declaredTools().find((t) => t.name === `${TOOL_PREFIX}${tool}`);
    if (!found) throw new Error(`no MCP tool named ${TOOL_PREFIX}${tool}`);
    return found.inputSchema as ToolInputSchema;
}

export function parseOrExit(
    subcommand: string,
    schema: ToolInputSchema,
    positional: string[],
    argv: string[],
    notes: string[] = []
): Record<string, unknown> {
    const parsed = parseToolArgs(schema, argv, positional);
    if (parsed.ok) return parsed.args;
    const usage = toolUsage(subcommand, schema, positional, notes);
    if (parsed.help) {
        console.log(usage);
        process.exit(0);
    }
    console.error(`Error: ${parsed.error}`);
    console.error(usage);
    process.exit(2);
}

export function printToolResponse(response: ToolResponse): boolean {
    const text = response.content.map((c) => c.text).join('\n');
    const failed = response.isError === true || text.startsWith('Error');
    if (failed) {
        console.error(text);
        process.exitCode = 1;
    } else {
        console.log(text);
    }
    return failed;
}

type StartViewer = (
    projectPath: string,
    initialTab?: string,
    options?: { exitOnLastClientClose?: boolean }
) => Promise<string>;

export async function acknowledgeSettingsViewer(projectPath: string): Promise<void> {
    const { broadcastFocusTab, isViewerServingProject, isViewerRunning } = await import('../viewer/server.js');
    if (!isViewerRunning() || isViewerServingProject(projectPath)) {
        const { markVersionSeen } = await import('../llm/settings.js');
        markVersionSeen();
        broadcastFocusTab('settings');
    }
}

/**
 * Start the viewer the way a CLI process needs it: the process exits once the
 * last browser tab closes, instead of serving forever.
 */
export async function startCliViewer(projectPath: string, initialTab?: string, start?: StartViewer): Promise<string> {
    const run = start ?? (await import('../viewer/server.js')).startViewer;
    return run(projectPath, initialTab, { exitOnLastClientClose: true });
}

export async function startSettingsCliViewer(projectPath: string, start?: StartViewer): Promise<string> {
    const result = await startCliViewer(projectPath, 'settings', start);
    await acknowledgeSettingsViewer(projectPath);
    return result;
}

export async function runToolSubcommand(
    subcommand: string,
    tool: string,
    positional: string[],
    argv: string[]
): Promise<void> {
    const args = parseOrExit(subcommand, await toolSchema(tool), positional, argv);
    const { handleToolCall } = await import('../server/tools.js');
    printToolResponse(await handleToolCall(`${TOOL_PREFIX}${tool}`, args));
}
