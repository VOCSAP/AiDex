---
name: reference-node-path-abi-trap
description: Default PATH node on this station resolves to v24, not the v22.11.0 pinned by CLAUDE.md for native-addon ABI compatibility
metadata:
  type: reference
---

On this station (Windows 11, DESKTOP-7B2CIVN), the bare `node` command on PATH resolves to v24.18.0 (confirmed by a peer, 2026-08-11), not the v22.11.0 that CLAUDE.md pins and that the native addons (better-sqlite3, tree-sitter) were compiled against.

**Why it matters:** running `node build/index.js ...` for a build, test, or timing measurement silently uses the wrong runtime. It may still work (Node ABI compat varies), but any measurement (spawn cost, timing) taken this way is not trustworthy against the pinned-ABI numbers already recorded elsewhere (e.g. Kleos memories on spawn cost), and a native-module load could fail outright depending on what changed between v22 and v24 ABI.

**How to apply:** for any build or measurement on this project, invoke the pinned binary explicitly, never bare `node`:
```bash
"/c/Users/Olivier/AppData/Local/nvm/v22.11.0/node.exe" build/index.js ...
```
State in any report which binary produced a given number. Also: `node -e` inline scripts are blocked by the harness on this station — write throwaway measurement scripts as `.mjs` files inside the project directory (ESM, `require()` fails), not in `/tmp` (module resolution for project deps fails there). If a script must live outside the project (e.g. a disposable test fixture that must NOT touch this repo's own `.aidex` index), resolve its module imports with `createRequire('D:/AI/MCPServer/AiDex/package.json')` from `node:module` to reach the pinned `node_modules` (e.g. `better-sqlite3`) instead of copying deps.

**Write/Read tool path mismatch for `/tmp`:** the Bash tool's `/tmp` is MSYS-mapped, not the same path Write/Read (Windows-native) tools resolve. Run `cygpath -w /tmp/whatever` to get the real Windows path before using Read/Write on a file created via Bash heredoc, or just use the session scratchpad dir directly with Write (its path is already Windows-native and pre-approved, no permission prompt).

**agent-forge `verify` and pinned Node:** `verify` steps execute argv with no shell, so `npm run build` fails with `program not found` even wrapped in `cmd /c` if PATH's `npm` would resolve to the wrong Node anyway. For a TypeScript typecheck step on this project, invoke tsc directly through the pinned node: `{"command": "C:/Users/Olivier/AppData/Local/nvm/v22.11.0/node.exe node_modules/typescript/lib/tsc.js --noEmit"}` — confirmed working (exit 0, captured by verify).
