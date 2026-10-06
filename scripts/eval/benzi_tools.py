"""Measure which Benzi tools agents actually call, from Benzi's own public traces.

Usage: python -I scripts/eval/benzi_tools.py <path-to-Benzi-clone>

Two independent sources shipped in the Benzi repo:
  - swebench/trajs/*.md          : 500 SWE-bench Verified trajectories (deepseek-v4-flash)
  - benchmark/results/runs.jsonl : 24-bug vendor benchmark, per-run tool counters
"""
import collections
import glob
import json
import os
import re
import sys

root = sys.argv[1]

# --- Source 1: SWE-bench trajectories -------------------------------------
call_re = re.compile(r"^- turn \d+: `([a-z_]+)`(.*)$")
calls, sessions = collections.Counter(), collections.Counter()
reads = reads_symbol = 0
shell_heads = collections.Counter()
header_total = 0
paths = sorted(glob.glob(os.path.join(root, "swebench", "trajs", "*.md")))
for p in paths:
    seen = set()
    for line in open(p, encoding="utf-8", errors="replace"):
        m = re.match(r"^- tool calls: (\d+)", line)
        if m:
            header_total += int(m.group(1))
        m = call_re.match(line)
        if not m:
            continue
        tool, rest = m.group(1), m.group(2)
        calls[tool] += 1
        seen.add(tool)
        if tool == "read_source":
            reads += 1
            reads_symbol += "::" in rest
        if tool == "shell" and rest.strip():
            shell_heads[rest.split()[0]] += 1
    sessions.update(seen)

total = sum(calls.values())
print(f"[swebench] trajectories={len(paths)} listed_calls={total} header_calls={header_total}")
for t, c in calls.most_common():
    print(f"  {t:28s}{c:6d} {100 * c / total:5.2f}%  sessions={sessions[t]}")
for t in ("call_tree", "trace_path", "backflow", "forwardflow", "external_calls", "check_last_execution"):
    print(f"  {t:28s}{calls[t]:6d}  (advertised in README)")
print(f"  read_source addressed by ::symbol: {reads_symbol}/{reads} = {100 * reads_symbol / reads:.1f}%")
print("  shell heads:", ", ".join(f"{k}={v}" for k, v in shell_heads.most_common(6)))

# --- Source 2: vendor benchmark runs --------------------------------------
rows = [json.loads(l) for l in open(os.path.join(root, "benchmark", "results", "runs.jsonl"), encoding="utf-8") if l.strip()]
CUTOFF = "2026-08-11T19:20"  # README: earlier runs used older engine versions
tools = collections.defaultdict(collections.Counter)
agg = collections.defaultdict(lambda: [0, 0, 0])  # input tokens, turns, runs
per_task = collections.defaultdict(lambda: collections.defaultdict(list))
for r in rows:
    if (r.get("ts") or "") < CUTOFF or r["arm"] not in ("control", "benzi_product"):
        continue
    key = (r["arm"], r.get("model"))
    tools[key].update(r.get("tools") or {})
    if r.get("model") != "sonnet":
        continue
    tok = (r.get("in_tokens") or 0) + (r.get("cache_read") or 0) + (r.get("cache_write") or 0)
    a = agg[r["arm"]]
    a[0] += tok; a[1] += r.get("num_turns") or 0; a[2] += 1
    per_task[r["task"]][r["arm"]].append(tok)

for key, c in sorted(tools.items()):
    tot = sum(c.values())
    graph = {t: c[t] for t in ("get_callers", "profile", "get_hierarchy", "call_tree", "trace_path", "backflow", "forwardflow")}
    print(f"[bench] {key} calls={tot} graph_tools={graph}")
for arm, (tok, turns, n) in agg.items():
    print(f"[bench] sonnet {arm}: runs={n} turns/run={turns / n:.1f} input_tokens/turn={tok // turns}")
mean = lambda xs: sum(xs) / len(xs)
paired = [(mean(d["control"]), mean(d["benzi_product"])) for d in per_task.values() if "control" in d and "benzi_product" in d]
c_sum, b_sum = sum(p[0] for p in paired), sum(p[1] for p in paired)
print(f"[bench] sonnet paired tasks={len(paired)} input_tokens control={int(c_sum)} benzi={int(b_sum)} ratio={b_sum / c_sum:.2f}")
