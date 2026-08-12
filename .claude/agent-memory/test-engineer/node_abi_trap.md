---
name: node-abi-trap
description: Default `node` on PATH in this environment is ABI-incompatible with AiDex's compiled native addons
metadata:
  type: project
---

On this Windows station, plain `node` on PATH resolves to the nvm4w junction `C:\nvm4w\nodejs\node.exe`, which follows whatever version `nvm use` last set — currently v24.18.0. AiDex's `better-sqlite3` native addon is compiled for Node 22's ABI (NODE_MODULE_VERSION). Running any Jest test that calls `init()`/`query()` (which load the addon) under the default `node` fails with a raw `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION 127 vs 137` stack, on EVERY test file that touches the DB layer — this is not specific to any one test, confirmed by reproducing the identical failure on unmodified `tests/coverage-oracle.test.js`.

**Why:** [[test-conventions]] project CLAUDE.md documents the pinned path: `C:\Users\Olivier\AppData\Local\nvm\v22.11.0\node.exe`. That pin is easy to forget mid-session since `node --version` on a fresh shell silently gives v24.

**How to apply:** Before running any Jest command in this repo, prepend the pinned binary's directory to PATH in the SAME bash command (state doesn't persist across Bash tool calls): `export PATH="/c/Users/Olivier/AppData/Local/nvm/v22.11.0:$PATH"` then run jest in the same invocation. For `agent-forge verify` (which executes argv without a shell, so PATH tricks in the command string don't work), give the full interpreter path directly as the command: `"C:/Users/Olivier/AppData/Local/nvm/v22.11.0/node.exe --experimental-vm-modules node_modules/jest/bin/jest.js tests/foo.test.js"`.

The guard is now a shared module: `tests/helpers/node-interpreter-guard.js` exports
`discoverConfiguredAidexNode()` (reads `~/.claude.json`'s `mcpServers.aidex.command`, same
discovery pattern as `hooks/claude/aidex-grep-nudge.py`'s `AIDEX_NODE` resolution),
`resolveAidexNode()` (picks a node binary for `spawnSync`-ing `build/index.js` as a CLI child
process — `AIDEX_NODE` env override, then discovery, then bare `'node'` as last resort),
`isNativeAbiMismatch(err)`, `nodeAbiGuardMessage(err)`. Both `tests/query-corpus.test.js` (loads
the addon in-process via `init()`/`query()`) and `tests/cli-update.test.js` (spawns
`build/index.js` as a real child process, plus loads `better-sqlite3` in-process to read back the
`files` table) import from this ONE module — do not hand-roll a second discovery in a new test
file, import from here instead. See [[cli-update-contract]] for the CLI-spawn use case.
