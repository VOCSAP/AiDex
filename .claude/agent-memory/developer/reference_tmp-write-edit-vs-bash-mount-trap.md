---
name: tmp-write-edit-vs-bash-mount-trap
description: Write/Edit tools resolve /tmp/... to a different physical file than Git Bash does on this station -- use explicit drive paths or Bash heredocs for scratch scripts.
metadata:
  type: reference
---

On this Windows station, the `Write`/`Edit` tools (Node process) resolve a
path like `/tmp/foo/bar.sh` against the current drive root (e.g.
`D:\tmp\foo\bar.sh`), while the `Bash` tool (Git Bash / MSYS) resolves the
identical string against the real MSYS `/tmp` mount
(`C:\Users\<user>\AppData\Local\Temp\foo\bar.sh`). These are two different
physical files. Editing a script via `Write`/`Edit` at `/tmp/...` and then
running it via `bash /tmp/...` silently executes a stale, untouched copy --
no error, just confusing "my fix didn't take" symptoms across many retries.

Confirmed 2026-08-11 while building a test harness for the AiDex Claude Code
hooks (card b6760488): `ls -la /d/tmp/af/queue-test/run_tests.sh` (my fresh
edits, 4.6K) vs `ls -la "/c/Users/Olivier/AppData/Local/Temp/af/queue-test/run_tests.sh"`
(the file Bash actually ran, 3165B, hours-old content).

**How to apply:** for any scratch file under `/tmp/...` that will be BOTH
edited via Write/Edit AND executed via Bash, either (a) use an explicit
drive-letter path consistently in both tools (e.g. `D:/tmp/...` /
`D:\tmp\...`), or (b) write it exclusively via a Bash heredoc
(`cat > /tmp/... << 'EOF' ... EOF`) so only Bash's own path resolution is
ever in play. Do not mix Write/Edit and Bash on the same `/tmp/...` path.

Distinct from [[node-path-abi-trap]] (Node ABI / bare `node` on PATH) and
from the stdin-JSON-vs-argv MSYS translation asymmetry (JSON payloads piped
via stdin to a native Windows process are NOT path-translated the way argv
is; build Windows-style paths explicitly, e.g. via `cygpath -w`, when a
test harness fabricates JSON that mimics what a native Windows process like
Claude Code actually sends).
