# AiDex launchers

This directory contains portable launchers for the built AiDex CLI:

- `aidex` for POSIX shells
- `aidex.cmd` for Command Prompt and PowerShell

Run `npm run build` before using either launcher. If `build/index.js` is missing, the launcher reports the required build command and exits with status 1.

## Installation

Add this `bin` directory to `PATH`. This works in both shell environments. Do not place `aidex.cmd` behind a symlink outside this directory because Windows resolves `%~dp0` to the symlink directory.

Set `AIDEX_NODE` to select the Node executable used by either launcher. When it is unset or empty, the launcher uses `node` from `PATH`.

```sh
AIDEX_NODE=/path/to/node aidex settings --help
```

See the `Fork changes` table in the root `README.md` for CLI behavior and usage. `aidex coverage` is an alias for `aidex can`, and `aidex can --help` treats `--help` as a pattern. Running `aidex` without a subcommand starts the MCP server on standard input and output. An unknown first subcommand exits with status 2 and lists the available subcommands on stderr.
