/**
 * tools/list filter: what the server advertises, what it still answers, and the
 * user-facing text that must not send an agent to a tool it cannot see.
 *
 * The call-by-name probe runs in a child process whose HOME and USERPROFILE
 * point to an empty directory. The global database path is resolved when the
 * server module loads, and a process.env change inside a jest test does not
 * reach os.homedir(): calling global_refresh in-process would rewrite the real
 * global database.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

import { registerTools, DEFAULT_DISABLED_TOOLS } from '../build/server/tools.js';
import { noIndexError } from '../build/commands/shared.js';
import { TOOL_PREFIX } from '../build/constants.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const short = (name) => name.slice(TOOL_PREFIX.length);

function advertised(envValue) {
    const saved = process.env.AIDEX_TOOLS_DISABLE;
    if (envValue === undefined) delete process.env.AIDEX_TOOLS_DISABLE;
    else process.env.AIDEX_TOOLS_DISABLE = envValue;
    try {
        return registerTools().map((t) => short(t.name));
    } finally {
        if (saved === undefined) delete process.env.AIDEX_TOOLS_DISABLE;
        else process.env.AIDEX_TOOLS_DISABLE = saved;
    }
}

// Every declared tool, read through the explicit-list branch with a name that
// matches nothing, so the "none" and empty branches are compared against it.
function declaredTools() {
    const savedError = console.error;
    console.error = () => {};
    try {
        return advertised(`${TOOL_PREFIX}no_such_tool`);
    } finally {
        console.error = savedError;
    }
}

describe('advertised tool list', () => {
    const declared = declaredTools();
    const disabled = new Set(DEFAULT_DISABLED_TOOLS);

    test('every default-disabled name is a declared tool', () => {
        expect(DEFAULT_DISABLED_TOOLS.filter((n) => !declared.includes(n))).toEqual([]);
    });

    test('the default advertises exactly the declared tools minus the default-disabled ones', () => {
        const served = advertised(undefined);
        expect(served).toEqual(declared.filter((n) => !disabled.has(n)));
        expect(served.length).toBeGreaterThan(0);
    });

    test('"none" and an empty value advertise every declared tool', () => {
        expect(advertised('')).toEqual(declared);
        expect(advertised(' None ')).toEqual(declared);
    });

    test('no advertised schema carries a path of this station', () => {
        const payload = JSON.stringify(registerTools());
        const slash = (p) => p.split('\\').join('/');
        expect(payload).not.toContain(slash(process.execPath));
        expect(payload).not.toContain(slash(join(REPO, 'build')));
    });

    test('an explicit list replaces the default set instead of extending it', () => {
        const served = advertised(`${TOOL_PREFIX}query, signature`);
        expect(served).toEqual(declared.filter((n) => n !== 'query' && n !== 'signature'));
        expect(served).toEqual(expect.arrayContaining(DEFAULT_DISABLED_TOOLS));
    });
});

describe('a tool dropped from the list still answers by name', () => {
    const UNKNOWN = `${TOOL_PREFIX}no_such_tool`;
    let probe;

    beforeAll(() => {
        const home = mkdtempSync(join(tmpdir(), 'aidex-tool-filter-home-'));
        const toolsUrl = pathToFileURL(join(REPO, 'build', 'server', 'tools.js')).href;
        const code = [
            `import { homedir } from 'os';`,
            `import { handleToolCall } from ${JSON.stringify(toolsUrl)};`,
            `if (homedir() !== process.env.AIDEX_PROBE_HOME) process.exit(3);`,
            `const out = {};`,
            `for (const name of JSON.parse(process.env.AIDEX_PROBE_NAMES)) {`,
            `    out[name] = (await handleToolCall(name, {})).content[0].text;`,
            `}`,
            `process.stdout.write('\\n' + JSON.stringify(out));`,
        ].join('\n');
        const names = [...DEFAULT_DISABLED_TOOLS.map((n) => `${TOOL_PREFIX}${n}`), UNKNOWN];
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
            env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                AIDEX_PROBE_HOME: home,
                AIDEX_PROBE_NAMES: JSON.stringify(names),
            },
            encoding: 'utf8',
            timeout: 60000,
        });
        const lines = (run.stdout || '').trim().split('\n');
        probe = { status: run.status, stderr: run.stderr, answers: run.status === 0 ? JSON.parse(lines[lines.length - 1]) : {} };
    });

    test('the probe ran against the empty home', () => {
        expect({ status: probe.status, stderr: probe.status === 0 ? '' : probe.stderr }).toEqual({ status: 0, stderr: '' });
    });

    test('an unknown name is reported as unknown', () => {
        expect(probe.answers[UNKNOWN]).toBe(`Unknown tool: ${UNKNOWN}`);
    });

    test.each([...DEFAULT_DISABLED_TOOLS])('%s', (name) => {
        const answer = probe.answers[`${TOOL_PREFIX}${name}`];
        expect(typeof answer).toBe('string');
        expect(answer).not.toMatch(/^Unknown tool:/);
    });
});

describe('user-facing text points to the CLI, not to a hidden tool', () => {
    test('the shared no-index message names the CLI init command for that path', () => {
        const message = noIndexError('/work/project');
        expect(message).toContain('init "/work/project"');
        expect(message).not.toContain(`${TOOL_PREFIX}init`);
    });

    const retired = new Set(DEFAULT_DISABLED_TOOLS);

    const EXEMPT_LINES = [
        { file: 'src/viewer/server.ts', tool: 'task', line: 'to create tasks from the chat' },
        { file: 'src/viewer/server.ts', tool: 'log', line: 'Start the Log Hub with' },
        { file: 'src/server/tools.ts', tool: 'global_query', line: 'Enables cross-project search via' },
        { file: 'src/commands/session.ts', tool: 'global_guideline', line: 'New tool:' },
    ];

    function mentions(text) {
        const found = [];
        for (const m of text.matchAll(/aidex_([a-z_]+)/g)) {
            if (retired.has(m[1])) found.push(m[1]);
        }
        for (const m of text.matchAll(/\$\{TOOL_PREFIX\}([a-z_]+)/g)) {
            const before = text[m.index - 1];
            const after = text[m.index + m[0].length];
            if (retired.has(m[1]) && !(before === '`' && after === '`')) found.push(m[1]);
        }
        return found;
    }

    // A line opening with `*` is skipped only inside a /* ... */ block: the same
    // line in a template literal is text an agent reads.
    function scanLines(lines) {
        const hits = [];
        let inBlock = false;
        lines.forEach((text, i) => {
            const trimmed = text.trim();
            if (inBlock) {
                if (trimmed.includes('*/')) inBlock = false;
                return;
            }
            if (trimmed.startsWith('//')) return;
            if (trimmed.startsWith('/*')) {
                inBlock = !trimmed.includes('*/');
                return;
            }
            for (const tool of mentions(text)) hits.push({ line: i + 1, text, tool });
        });
        return hits;
    }

    function sourceFiles(dir) {
        return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const p = join(dir, e.name);
            if (e.isDirectory()) return sourceFiles(p);
            return /\.[cm]?tsx?$/.test(e.name) ? [p] : [];
        });
    }

    test('the scanner catches a message and ignores comments and tool names', () => {
        const tools = (lines) => scanLines(lines).map((h) => h.tool);
        expect(tools(['return `No index. Run aidex_init first.`;'])).toEqual(['init']);
        expect(tools(['text: `Run ${TOOL_PREFIX}scan first.`,'])).toEqual(['scan']);
        expect(tools(['const help = `', '* Run aidex_init first', '`;'])).toEqual(['init']);
        expect(tools(['// aidex_init indexes the given directory'])).toEqual([]);
        expect(tools(['/**', ' * aidex_init indexes the given directory', ' */', 'x(`aidex_scan`);'])).toEqual(['scan']);
        expect(tools(['case `${TOOL_PREFIX}remove`:'])).toEqual([]);
        expect(tools(['text: `Run aidex_update after editing`'])).toEqual([]);
    });

    test('no source line outside the exemptions names a default-disabled tool', () => {
        const offenders = [];
        const used = new Set();
        for (const file of sourceFiles(join(REPO, 'src'))) {
            const rel = relative(REPO, file).split('\\').join('/');
            for (const hit of scanLines(readFileSync(file, 'utf8').split('\n'))) {
                const exemption = EXEMPT_LINES.find(
                    (x) => x.file === rel && x.tool === hit.tool && hit.text.includes(x.line)
                );
                if (exemption) used.add(exemption);
                else offenders.push(`${rel}:${hit.line} names ${TOOL_PREFIX}${hit.tool}`);
            }
        }
        expect(offenders).toEqual([]);
        expect(EXEMPT_LINES.filter((x) => !used.has(x))).toEqual([]);
    });
});
