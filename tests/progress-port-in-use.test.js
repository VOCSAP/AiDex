import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { describe, expect, test } from '@jest/globals';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROGRESS_MODULE = pathToFileURL(join(REPO_ROOT, 'build', 'viewer', 'progress.js')).href;

// Each scenario runs in its own process: an unhandled 'error' event terminates the process that emits it.
const CHILD_SCRIPT = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { connect, createServer } from 'node:net';

const execCalls = [];
childProcess.exec = (command) => { execCalls.push(String(command)); };
syncBuiltinESMExports();

const { startProgress, stopProgress, isProgressRunning } = await import(${JSON.stringify(PROGRESS_MODULE)});

const logs = [];
const waiters = new Set();
const writeError = console.error.bind(console);
console.error = (...args) => {
    const line = args.join(' ');
    logs.push(line);
    writeError(line);
    for (const w of [...waiters]) w();
};
const timedOut = [];
function waitFor(label, predicate) {
    return new Promise((resolve) => {
        let timer;
        const check = () => {
            if (!predicate()) return;
            waiters.delete(check);
            clearTimeout(timer);
            resolve();
        };
        timer = setTimeout(() => { waiters.delete(check); timedOut.push(label); resolve(); }, 5000);
        waiters.add(check);
        check();
    });
}
const count = (text) => logs.filter((l) => l.includes(text)).length;
const listen = (server, port) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const accepts = (port) => new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
});
const report = (data) => { console.log(JSON.stringify({ ...data, execCalls, timedOut })); process.exit(0); };

if (process.env.SCENARIO === 'taken') {
    const holder = createServer();
    await listen(holder, 0);
    const port = holder.address().port;
    const failure = 'port ' + port + ' is already in use';
    startProgress('port-in-use probe', { port, openBrowser: false });
    const immediate = isProgressRunning();
    await waitFor('first failure', () => count(failure) >= 1);
    const later = isProgressRunning();
    startProgress('second attempt', { port, openBrowser: false });
    await waitFor('second failure', () => count(failure) >= 2);
    report({ scenario: 'taken', immediate, later, afterRetry: isProgressRunning(), bindFailuresReported: count(failure) });
} else {
    const STARTED = /^\\[Progress\\] Server started at http:\\/\\/127\\.0\\.0\\.1:(\\d+)$/;
    startProgress('free port probe', { port: 0, openBrowser: false });
    await waitFor('started log', () => logs.some((l) => STARTED.test(l)));
    const startedLine = logs.find((l) => STARTED.test(l));
    const loggedPort = startedLine ? Number(STARTED.exec(startedLine)[1]) : null;
    const running = isProgressRunning();
    const loggedPortAccepts = loggedPort ? await accepts(loggedPort) : false;
    stopProgress();
    await waitFor('stopped log', () => count('[Progress] Server stopped') >= 1);
    report({ scenario: 'free', loggedPortAccepts, running, afterStop: isProgressRunning() });
}
`;

function runScenario(scenario) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
        encoding: 'utf-8',
        timeout: 20000,
        env: { ...process.env, SCENARIO: scenario },
    });
    const lastLine = r.stdout.trim().split('\n').pop() ?? '';
    return { status: r.status, stderr: r.stderr, report: lastLine.startsWith('{') ? JSON.parse(lastLine) : null };
}

describe('progress server', () => {
    test('with its port taken, the host survives, reports not running, and a later start retries the bind', () => {
        const r = runScenario('taken');

        expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
        expect(r.report).toEqual({
            scenario: 'taken',
            immediate: false,
            later: false,
            afterRetry: false,
            bindFailuresReported: 2,
            execCalls: [],
            timedOut: [],
        });
    }, 30000);

    test('on a free port, it reports running, logs the 127.0.0.1 URL of the bound port, never opens a browser, and stops cleanly', () => {
        const r = runScenario('free');

        expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
        expect(r.report).toEqual({
            scenario: 'free',
            loggedPortAccepts: true,
            running: true,
            afterStop: false,
            execCalls: [],
            timedOut: [],
        });
    }, 30000);
});
