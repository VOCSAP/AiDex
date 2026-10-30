# AiDex global git hooks

Auto-reindex trigger for any repo with an `.aidex` directory, complementary
to the Claude Code session hook (`hooks/claude/aidex-grep-nudge.py`). Covers
4 events so a plain `git pull`/rebase doesn't leave the index stale:
`post-commit`, `post-merge`, `post-checkout`, `post-rewrite`.

## Files

| File | Role |
|---|---|
| `aidex-reindex-common.sh` | Shared logic: `.aidex` gate, interpreter discovery, debounce, batched `update` call. Sourced by all 4 hooks, not run directly. |
| `post-commit` | Reindexes files changed by the commit that just landed. |
| `post-merge` | Reindexes files changed by a merge (`ORIG_HEAD` vs `HEAD`), including the merge half of `git pull`. |
| `post-checkout` | Reindexes files changed by a branch switch (skips plain file-level checkouts). |
| `post-rewrite` | Reindexes files touched by `commit --amend` or a `rebase`, unioned across every rewritten commit. |

## Why these live here but don't run from here

Git only runs hooks from `core.hooksPath` (or `.git/hooks` of the specific
repo, which is not viable for a hook meant to apply to every repo on the
machine). On this machine `core.hooksPath` is set globally to
`~/.git-hooks-global`, which lives in a separate, private, non-fork repo
(`C:/Users/USERNAME/.claude/claude-config/git-config`) symlinked to
`%USERPROFILE%`.

**This directory (`hooks/git/` in the AiDex fork) is versioned source only.**
Nothing here is executed by git until the operator manually links or copies
these 6 files into the real `core.hooksPath` target. This task/commit does
not touch `~/.git-hooks-global` or any global git config -- that step is
deliberately left to the operator, on any machine that wants this behavior.

Expected manual installation (illustrative, adjust to the actual target):

```bash
# one-time, per machine, done by the operator -- not by this hook set
ln -s "/d/AI/MCPServer/AiDex/hooks/git/aidex-reindex-common.sh" ~/.git-hooks-global/aidex-reindex-common.sh
ln -s "/d/AI/MCPServer/AiDex/hooks/git/post-commit"             ~/.git-hooks-global/post-commit
ln -s "/d/AI/MCPServer/AiDex/hooks/git/post-merge"              ~/.git-hooks-global/post-merge
ln -s "/d/AI/MCPServer/AiDex/hooks/git/post-checkout"           ~/.git-hooks-global/post-checkout
ln -s "/d/AI/MCPServer/AiDex/hooks/git/post-rewrite"            ~/.git-hooks-global/post-rewrite
```

## Safety properties

- **Auto-limiting**: every hook calls `aidex_has_index` first and exits 0
  immediately, with zero writes, if the current repo has no `.aidex` at its
  root. This is what makes it safe to fire on every repo on the machine.
- **Debounced**: a trailing-edge debounce (`AIDEX_DEBOUNCE_SECS`, default
  2s) collapses a burst of triggers (e.g. a 30-commit rebase) into a single
  reindex, fired once the burst settles, not once per commit/hook call.
- **Detached**: the actual `update` CLI invocation runs in a backgrounded
  subshell; the hook itself returns almost immediately so the foreground
  git command isn't slowed down.
- **Batched**: every changed file collected during the debounce window is
  passed to a single `node build/index.js update <project> <file...>`
  invocation -- never one spawn per file (measured ~8x cheaper batched).
- **Interpreter-safe**: reuses the same discovery discipline as
  `hooks/claude/aidex-grep-nudge.py` -- `AIDEX_NODE`/`AIDEX_ENTRY` env
  override, then the `aidex` MCP server entry declared in Claude's config
  JSON, no hardcoded path. If nothing is discoverable, the hook stays inert
  rather than guessing.
- **Silent**: no stdout/stderr output by default. Set `AIDEX_HOOK_DEBUG=1`
  to append a trace to `.aidex/.reindex-hook.log` in the target repo.

## Debounce window

Fixed at 2 seconds by default (`AIDEX_DEBOUNCE_SECS`), overridable per
environment. Rationale: long enough to fully absorb a scripted burst of
git operations (a rebase replaying commits, a fast-forward pull) into one
reindex, short enough that a single isolated commit is picked up well
within the time it takes a developer to switch back to their editor.
