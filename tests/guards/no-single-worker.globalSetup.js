/**
 * Global-setup guard -- roadmap card 39e02f07, spec_ef8b08fb.
 *
 * WHY THIS EXISTS
 * The native tree-sitter addon is loaded once per OS process (Node addons are
 * process-level singletons via process.dlopen). Jest gives every *test file*
 * a fresh vm context, but --runInBand / -i or --maxWorkers=1 / -w 1 forces ALL
 * test files through the SAME process. Past the first file that indexes live
 * in that shared process, `parseFile()` returns a tree whose `rootNode` is
 * undefined, and `extract()` throws on `node.startPosition`. That crash reads
 * exactly like an AiDex parser bug. It is not one -- it is jest/native-addon
 * process-sharing, measured 2026-08-12 (66/138 failures under
 * --maxWorkers=1, 138/138 under default parallel mode, 3 runs each).
 *
 * WHY A GLOBALSETUP CHECK, NOT A TEST THAT INSPECTS parseFile()'S OUTPUT
 * A test that asserts `rootNode` is defined only fails for whichever file
 * happens to run SECOND (or later) in a shared process. Jest orders suites by
 * its cached timing data, so which file that is changes from run to run --
 * three consecutive --maxWorkers=1 runs on the same tree produced 64, 36 and
 * 52 failures. A guard whose verdict depends on file order is a guard that
 * lies roughly half the time it matters most (the run where the dangerous
 * file happens to go first passes clean).
 *
 * This check instead inspects jest's OWN resolved config
 * (`globalConfig.runInBand`, `globalConfig.maxWorkers`) once, in jest's
 * globalSetup hook, before any worker process or test file exists. That makes
 * it:
 *   1. Deterministic and order-independent: it depends only on how jest was
 *      invoked, never on which test file loads first.
 *   2. A check on the EXECUTION MODE, not the symptom: it stays correct even
 *      if the underlying native-addon defect is fixed, changes shape, or
 *      moves to a different parser -- the danger is "all files share one
 *      process", not "parseFile returns undefined".
 *   3. Loud about cause and remedy in its own failure message, instead of
 *      surfacing as a confusing `Cannot read properties of undefined
 *      (reading 'startPosition')` several layers into extract().
 *
 * Deliberate tradeoff: on a machine where jest computes maxWorkers=1
 * organically (e.g. a single-core CI runner, no explicit flag), this guard
 * still fires. That is intentional -- the risk is identical whether
 * maxWorkers=1 was requested or computed, since either way every test file
 * shares one process.
 *
 * Only `globalConfig.maxWorkers` is checked, not a `runInBand` field: jest
 * has no such field on globalConfig. `--runInBand`/`-i` is normalized into
 * `maxWorkers = 1` before globalSetup runs (confirmed empirically: a run with
 * --runInBand produces the exact same globalConfig.maxWorkers === 1 this
 * guard already catches), so a single check on maxWorkers covers both spellings
 * of the same dangerous mode.
 */
export default async function noSingleWorkerGuard(globalConfig) {
    const { maxWorkers } = globalConfig;
    if (maxWorkers === 1) {
        throw new Error(
            `AiDex test suite refuses to run in a single process (maxWorkers=${maxWorkers}).\n` +
            'CAUSE: the native tree-sitter addon is a process-level singleton, ' +
            "but jest gives every test file its own vm context. Past the first " +
            'file that indexes live in a shared process, parseFile() returns a ' +
            "rootNode of undefined and extract() throws on node.startPosition -- " +
            "this looks like an AiDex parser bug and is NOT one " +
            '(see roadmap card 39e02f07).\n' +
            "FIX: run the suite in jest's default parallel mode. Do not pass " +
            '--runInBand / -i or --maxWorkers=1 / -w 1.'
        );
    }
}
