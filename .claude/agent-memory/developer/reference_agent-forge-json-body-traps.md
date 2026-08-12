---
name: agent-forge-json-body-traps
description: Two concrete traps writing agent-forge --input JSON bodies via Bash heredoc — invalid regex escapes, and roadmap append size caps.
metadata:
  type: reference
---

`agent-forge spec-task`/`verify`/etc bodies are strict JSON parsed with `Failed to parse JSON: invalid escape at line N column M` on any bad escape. A literal `\s+` (or other regex-style backslash sequence) typed straight into a JSON string value is an INVALID JSON escape — JSON only allows `\" \\ \/ \b \f \n \r \t \uXXXX`. Describe regex behavior in plain English instead ("collapse runs of whitespace to a single space") rather than embedding the pattern text.

Diagnosis pattern when a submission fails: don't trust `Read` on the `/tmp/af/*.json` body file (see [[reference_tmp-write-edit-vs-bash-mount-trap]] — Read can show stale/wrong content on this Windows/MSYS setup); use `sed -n '<line>p' /tmp/af/body.json` via Bash to see the actual byte content at the reported line/column.

Separately: `roadmap_append_context` has a 4000-char PER-CALL cap and a 16000-char TOTAL-context cap per card. A long final report needs to be split into multiple append calls, and once a card's context is already near 16000 total (e.g. from earlier progress-note appends), a large final append can be flatly refused (409) with no room left — the remedy is NOT a `roadmap_update` context replace (that overwrites, no undo, risky on a card shared with other peers' prior notes) but delivering the overflow content directly via `send_message` to whoever needs it instead.

**Why:** JSON escape rules are stricter than "looks like a string to me"; regex fragments are the most common accidental violation. The roadmap caps exist to bound card size but have no graceful auto-split, so a report writer must plan for the cap rather than discover it mid-delivery.

**How to apply:** Before writing any agent-forge JSON body or a roadmap append with technical prose, scan for backslash sequences and either escape them properly (`\\s` for literal `\s` if truly needed) or reword in English. For long roadmap reports, draft in a scratch file first, check length, and pre-split at the 4000-char boundary; if total context is likely near cap, default straight to `send_message` for the bulk of the content and keep the card append to a short pointer.
