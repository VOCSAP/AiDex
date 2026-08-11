#!/bin/sh
# Shared helper for AiDex's global git hooks (post-commit, post-merge,
# post-checkout, post-rewrite). Sourced by each hook, never executed
# directly (has no shebang-executable purpose of its own beyond being
# `.`-sourced).
#
# Contract every function here honors:
#   - never write anything if the current repo has no .aidex directory
#   - never make the foreground git command visibly slower
#   - never print anything on stdout/stderr (silent unless AIDEX_HOOK_DEBUG=1)
#   - never abort/fail the git command that invoked it (hooks are best-effort)
#
# This file intentionally reimplements (in POSIX sh) the same interpreter
# discovery contract as hooks/claude/aidex-grep-nudge.py's discover_aidex():
# env override first, then the "aidex" MCP server entry declared in Claude's
# own config JSON, never a hardcoded path. It is a separate implementation
# (not a shared import) because git hooks must run under a shell git itself
# guarantees is present -- Python is not a safe assumption for every GUI git
# client's environment, but a POSIX shell is what git hooks are natively
# written in.

# ---------------------------------------------------------------------------
# 1. Repo root + index-presence gate
# ---------------------------------------------------------------------------

# Prints the working-tree root of the repo currently invoking the hook, or
# nothing if it can't be determined (bare repo, detached hook context, etc).
aidex_repo_root() {
    git rev-parse --show-toplevel 2>/dev/null
}

# Returns success (0) only if the given repo root has an .aidex index.
# This is what makes it safe to install these hooks globally and have them
# fire on every repo on the machine: everything else short-circuits here.
aidex_has_index() {
    [ -n "$1" ] && [ -d "$1/.aidex" ]
}

# ---------------------------------------------------------------------------
# 2. Interpreter + entry point discovery (mirrors aidex-grep-nudge.py)
# ---------------------------------------------------------------------------

_aidex_config_candidates() {
    printf '%s\n' \
        "$HOME/.claude.json" \
        "${APPDATA:-}/Claude/claude_desktop_config.json" \
        "${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude_desktop_config.json"
}

# Best-effort scrape of the "aidex": { "command": ..., "args": [...] } block
# from a Claude config JSON. This is NOT a JSON parser: it assumes the file
# is pretty-printed one-field-per-line, which is how Claude Code and Claude
# Desktop write it. A minified config simply won't match -- discovery falls
# through and the hook stays inert (fail closed, never fail loud).
_aidex_extract_from_config() {
    cfg="$1"
    [ -f "$cfg" ] || return 1
    awk '
        /"aidex"[ \t]*:[ \t]*\{/ { in_block=1; next }
        in_block && /^[ \t]*\}/ { in_block=0; in_args=0 }
        in_block && /"command"[ \t]*:/ {
            line=$0
            sub(/.*"command"[ \t]*:[ \t]*"/, "", line)
            sub(/".*/, "", line)
            print "CMD=" line
            next
        }
        in_block && /"args"[ \t]*:/ {
            line=$0
            if (match(line, /\[[ \t]*"[^"]*"/)) {
                entry=line
                sub(/.*\[[ \t]*"/, "", entry)
                sub(/".*/, "", entry)
                print "ENTRY=" entry
            } else {
                in_args=1
            }
            next
        }
        in_block && in_args && /"[^"]*"/ {
            line=$0
            sub(/^[ \t]*"/, "", line)
            sub(/".*/, "", line)
            print "ENTRY=" line
            in_args=0
            next
        }
    ' "$cfg" 2>/dev/null
}

# Sets AIDEX_NODE_BIN and AIDEX_ENTRY_JS. Both may end up empty; callers
# MUST treat an empty AIDEX_ENTRY_JS as "nothing to do, exit quietly" --
# unlike the Python hook, there is no bare-"node"-only fallback here, since
# without a discovered entry point there is no build/index.js to run at all.
aidex_discover() {
    AIDEX_NODE_BIN="${AIDEX_NODE:-}"
    AIDEX_ENTRY_JS="${AIDEX_ENTRY:-}"

    if [ -n "$AIDEX_NODE_BIN" ] && [ -n "$AIDEX_ENTRY_JS" ]; then
        return 0
    fi

    for cfg in $(_aidex_config_candidates); do
        [ -f "$cfg" ] || continue
        out="$(_aidex_extract_from_config "$cfg")"
        [ -z "$out" ] && continue

        cmd="$(printf '%s\n' "$out" | sed -n 's/^CMD=//p' | head -1 | sed 's/\\\\/\\/g')"
        entry="$(printf '%s\n' "$out" | sed -n 's/^ENTRY=//p' | head -1 | sed 's/\\\\/\\/g')"

        [ -z "$AIDEX_NODE_BIN" ] && [ -n "$cmd" ] && AIDEX_NODE_BIN="$cmd"
        [ -z "$AIDEX_ENTRY_JS" ] && [ -n "$entry" ] && AIDEX_ENTRY_JS="$entry"
        [ -n "$AIDEX_NODE_BIN" ] && [ -n "$AIDEX_ENTRY_JS" ] && break
    done

    [ -z "$AIDEX_NODE_BIN" ] && AIDEX_NODE_BIN="node"
}

_aidex_log() {
    [ "${AIDEX_HOOK_DEBUG:-}" = "1" ] || return 0
    state_dir="$1"; shift
    printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$state_dir/.reindex-hook.log" 2>/dev/null
}

# ---------------------------------------------------------------------------
# 3. Debounced, batched reindex
# ---------------------------------------------------------------------------
# Trailing-edge debounce: every call appends its files to a pending queue
# and stamps a fresh token, then spawns a detached watcher that sleeps
# AIDEX_DEBOUNCE_SECS and only performs the actual (batched, deduped) update
# if no later call has superseded its token in the meantime. A 30-commit
# rebase collapses into exactly one reindex, fired ~AIDEX_DEBOUNCE_SECS
# after the last commit lands -- not one per commit, not one per hook.

AIDEX_DEBOUNCE_SECS="${AIDEX_DEBOUNCE_SECS:-2}"

# Reads changed-file paths from stdin (one per line) and queues them for the
# given repo root. Empty/no-op if stdin is empty. Never blocks the caller.
aidex_queue_files() {
    repo_root="$1"
    state_dir="$repo_root/.aidex"
    pending="$state_dir/.reindex-pending"
    token_file="$state_dir/.reindex-token"

    have_any=0
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        have_any=1
        printf '%s\n' "$f" >> "$pending"
    done

    [ "$have_any" = "0" ] && return 0

    token="$$-$(date +%s%N 2>/dev/null || date +%s)"
    printf '%s' "$token" > "$token_file"
    _aidex_log "$state_dir" "queued files, token=$token"

    (
        sleep "$AIDEX_DEBOUNCE_SECS"
        current="$(cat "$token_file" 2>/dev/null)"
        if [ "$current" = "$token" ]; then
            aidex_flush_and_update "$repo_root"
        fi
    ) >/dev/null 2>&1 &
    disown >/dev/null 2>&1 || true
}

# Drains the pending-file queue for repo_root and runs ONE batched
# `update` CLI invocation. Guarded by a mkdir-lock (atomic) so two watchers
# racing on the same repo can't double-flush.
aidex_flush_and_update() {
    repo_root="$1"
    state_dir="$repo_root/.aidex"
    pending="$state_dir/.reindex-pending"
    lock="$state_dir/.reindex-flush.lock"

    mkdir "$lock" 2>/dev/null || return 0
    trap 'rmdir "$lock" 2>/dev/null' EXIT INT TERM

    [ -f "$pending" ] || return 0

    files_blob="$(sort -u "$pending" 2>/dev/null)"
    : > "$pending"

    [ -z "$files_blob" ] && return 0

    set --
    while IFS= read -r f; do
        [ -n "$f" ] && set -- "$@" "$f"
    done <<EOF
$files_blob
EOF

    # Never call the CLI with zero files -- that path is a usage error
    # (exit 1) on the update subcommand.
    [ "$#" -eq 0 ] && return 0

    aidex_discover
    if [ -z "$AIDEX_ENTRY_JS" ] || [ ! -f "$AIDEX_ENTRY_JS" ]; then
        _aidex_log "$state_dir" "no discovered entry point, skipping ($# files dropped)"
        return 0
    fi

    _aidex_log "$state_dir" "flushing $# file(s) via $AIDEX_NODE_BIN $AIDEX_ENTRY_JS"
    "$AIDEX_NODE_BIN" "$AIDEX_ENTRY_JS" update "$repo_root" "$@" >/dev/null 2>&1
}
