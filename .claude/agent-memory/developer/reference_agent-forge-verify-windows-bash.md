---
name: agent-forge-verify-windows-bash
description: agent-forge verify's argv exec picks WSL's bash.exe over Git Bash on Windows, and its command string can't contain spaces (no shell, no quoting) -- use a no-space .cmd wrapper.
metadata:
  type: reference
---

**A Bash-tool `PATH="/c/.../v22.11.0:$PATH"` prefix does NOT reach
`cmd /c npm ...` / `cmd /c npx ...` steps inside `agent-forge verify`, even
though the pinned Bash session that launched `agent-forge` had it exported.**
Confirmed 2026-08-12 (spec_97b567d0): a step `{"command": "cmd /c npx
jest"}` ran under the wrong Node (v24 on Windows PATH, not the pinned
22.11.0) and crashed on the native `better-sqlite3`/tree-sitter ABI
mismatch, identically whether or not the pinned dir was prepended to the
Bash-tool's `PATH` before invoking `agent-forge`. Root cause: MSYS/Git
Bash's `PATH` is POSIX-style (`/c/Users/...:...`), and `cmd.exe` (spawned
by agent-forge's native Rust `Command`) does not understand that syntax as
a search path -- it silently falls back to the real Windows `PATH`
environment variable, which still points at nvm4w's active (non-pinned)
Node.
**Fix:** for any verify step that needs the pinned Node, bypass `cmd
/c npm`/`npx` entirely and invoke the pinned `node.exe` by absolute
forward-slash path directly as the step's `command`, e.g. `"C:/Users/.../
v22.11.0/node.exe --experimental-vm-modules node_modules/jest/bin/jest.js"`
-- no shell, no PATH resolution needed at all. `cmd /c npm run build` is
fine to leave as-is if the step doesn't touch native addons (tsc doesn't
care which Node built it).

`agent-forge verify` runs each step's `command` via a plain argv exec (no
shell involved) -- confirmed by the JSON schema (`command` is a flat string,
no argv-array option) and by behavior: a space inside a quoted path breaks
it (`"C:/Program Files/Git/usr/bin/bash.exe" ...` fails with `I/O error: Le
fichier spécifié est introuvable`, because whitespace-splitting cuts the
path at `Program`).

Separately, on this station, `bash` bare (resolved via Windows PATH order,
which is NOT the same order Git Bash's own shell uses) picks
`C:\Windows\System32\bash.exe` (the WSL launcher) before
`C:\Program Files\Git\usr\bin\bash.exe`. A WSL bash given a Windows-style or
MSYS-style path argument resolves it under the WSL filesystem, not Windows',
so a real, existing script produces `No such file or directory` even though
the path is completely correct for Git Bash.

**How to apply:** to run a Git Bash script from `agent-forge verify`, write
a tiny wrapper batch file at a path with no spaces (e.g.
`D:/tmp/af/run-harness.cmd`) that invokes Git Bash's full path explicitly:
```
@"C:\Program Files\Git\usr\bin\bash.exe" "D:\path\to\script.sh"
```
then point the verify step's `command` at that `.cmd` file directly (single
token, no spaces, no shell needed). Confirmed 2026-08-11 (card b6760488):
direct `bash <path>` and quoted-path attempts both failed, the wrapper
`.cmd` passed on first try (`exit_code: 0`).

**Windows paths with backslashes in the JSON body get mangled -- use forward
slashes instead.** Confirmed 2026-08-11 (spec_1123835f): a `cat > file.json
<<'EOF'` heredoc containing `"C:\\Users\\..."` (two literal backslashes per
separator, correct JSON escaping for one literal `\`) came out the other end
as `"C:\Users\..."` (single backslash) once read back -- something in the
Bash-tool round-trip collapses `\\` to `\` even inside a quoted heredoc, so
`agent-forge --input ... verify` then fails with `Failed to parse JSON:
invalid escape at line N`. Since `command` is a flat string parsed by argv
splitting anyway (no shell), Windows/CreateProcess accepts forward slashes
in paths just fine -- write every path in the verify body with `/` instead
of `\` (`C:/Users/Olivier/.../node.exe build/index.js ...`) and the escaping
problem disappears entirely, no backslash needed anywhere in the JSON.
