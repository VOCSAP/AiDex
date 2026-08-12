---
name: jest-treesitter-context-trap
description: Any jest run that puts two test files in one process silently breaks indexing - tree-sitter returns a Tree whose rootNode is undefined from the second file on
metadata:
  type: project
---

The jest suite is green with one test file per worker process and red as soon as two test files share a process (`--runInBand`, `--maxWorkers=1`, or jest's automatic in-band heuristic). Measured on 2026-08-12: default parallel on 24 cores = 138/138 green, 3 runs of 3; `--maxWorkers=1` = 66 failed / 72 passed.

**Why:** the tree-sitter native addon is loaded once per process, while jest builds a new vm context per test file. From the second file on, `parseFile` returns a Tree object whose `rootNode` is `undefined` (probe: first file `rootNode=object type=program`, second file `rootNode=undefined type=undefined`). `extract()` then reads `node.startPosition` on undefined and throws for every file, `init()` swallows the per-file throw into `errors[]` and returns `success: true` with an empty index.

**How to apply:**
- Before blaming a commit for a red suite here, re-run it with default parallelism. If it goes green, the commit is not the cause.
- Symptoms this produces, all of which look like application bugs and are not: `expected N rows in files table after init(), got 0`; literal/symbol queries returning zero matches on a freshly built fixture; a test file that passes alone and fails in the suite.
- Immune suites are the ones that index through a child process (`cli-update`) or do not index at all (`scheduler`, `embedder-fixes`). That asymmetry is the fingerprint.
- Fast probe: two throwaway test files that each call `parseFile` and print `typeof tree.rootNode`. Put them under a `probe-tmp/tests/` directory (jest `testMatch` is `**/tests/**/*.test.js`) and delete it right after - other agents run the same suite.

Superseded my earlier cwd diagnosis of the same red suite: cwd-relative repo roots ([[test-suite-cwd-trap]]) are a real second defect, but they were not what the team lead measured.
