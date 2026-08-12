---
name: git-hooks-global-hookspath
description: core.hooksPath is set globally on this machine, shadowing local .git/hooks; a gitleaks pre-commit template also auto-installs and panics
metadata:
  type: reference
---

This machine has `core.hooksPath` set GLOBALLY to `~/.git-hooks-global` (a separate private repo, `C:/Users/Olivier/.claude/claude-config/git-config`, symlinked to `%USERPROFILE%`). Confirmed via `git config --get core.hooksPath` (local, any repo) and `git config --global --get core.hooksPath` returning the same value.

**Consequence:** a hook dropped into any repo's own local `.git/hooks/<name>` (even a brand-new `git init`) NEVER fires — `core.hooksPath` shadows it machine-wide. A first "silent success" commit in a sandbox after copying hook files there is a false positive unless you've checked this setting. Verify with `git config --get core.hooksPath` before trusting a local-hooks test.

**Sandbox-only override for testing** (never touch the real global config): `git config core.hooksPath .git/hooks` inside a disposable sandbox repo, purely local/repo-scoped.

**Unrelated trap hit while testing in a sandbox:** a global `init.templateDir` auto-installs a `pre-commit` hook (gitleaks) into every freshly-`git init`'d repo, independent of `core.hooksPath`. Its default pattern `\bsk-(?!ant-)[A-Za-z0-9]{32,}\b` uses a Perl negative lookahead that Go's RE2 (gitleaks/wasilibs/go-re2) doesn't support — panics (`bad perl operator: (?!`) and blocks ANY commit regardless of staged content. Pre-existing, unrelated to AiDex hooks work. Workaround in a disposable sandbox only: `mv .git/hooks/pre-commit .git/hooks/pre-commit.disabled-for-test`. Never touch the real global template.

See [[project-shared-repo-swarm]] for the peer-collision issues encountered in the same session (`/tmp` scratch path, Write/Bash visibility).
