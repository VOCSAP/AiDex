#!/usr/bin/env python3
"""Headless A/B harness: tokens an AiDex feature saves on real tasks.

Three subcommands, stdlib only:

  pick    draw candidate tasks from Claude Code transcripts: the first user
          prompt of main (non-sidechain) sessions of one project that called
          an AiDex tool and no editing tool. Calibrate on prompts that were
          really sent, never on hand-written ones (CLAUDE.md doctrine).
  run     run every task x arm x repetition through `claude -p` in
          stream-json, one raw stream file per run. Arm order alternates per
          repetition; each prompt carries a distinct nonce so that two runs
          never share a prompt-cache prefix.
  report  per-run tokens from the final `result` line, paired delta per task.

Token source: the `result` line's `usage`. The per-message `usage` of the
stream's assistant lines is a streaming snapshot whose output_tokens is not
final (measured: 4 + 1 there against 174 in `result`), while result's input
fields equal the exact sum of the deduplicated messages. One path only.

Usage:
  python scripts/eval/ab_harness.py pick --project D--AI-MCPServer-AiDex --n 15 --out docs/dev-notes/ab/candidates.json
  python scripts/eval/ab_harness.py run --tasks T.json --arms A.json --reps 2 --cwd D:/repo --outdir docs/dev-notes/ab/aa1
  python scripts/eval/ab_harness.py report --outdir docs/dev-notes/ab/aa1 --json docs/dev-notes/ab/aa1/report.json
"""

import argparse
import json
import random
import re
import statistics
import subprocess
import sys
import uuid
from pathlib import Path

EDIT_TOOLS = ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')
READ_ONLY_TOOLS = ('Read', 'Grep', 'Glob', 'mcp__aidex')
DENIED_TOOLS = EDIT_TOOLS + ('Bash',)
NOISE_PREFIXES = ('<', '/', 'Caveat:', '[Request interrupted')


# --- pick ------------------------------------------------------------------

QUESTION_RE = re.compile(
    r"\?|\b(comment|pourquoi|o[uù]\b|quel(le)?s?|est-ce que|explique|how|where|why|what|which)\b",
    re.I)
# First prompts are mostly operational (measured: indexing requests, team-lead
# briefs, handoffs); these words mark a request that is not a code question.
OPERATIONAL_RE = re.compile(
    r"ind[eé]x|handoff|team-lead|whoami|peer_id|commit|push|roadmap|carte|"
    r"continue|reprend|lance |relance|npm run|merge|deploy|d[ée]ploie", re.I)


def session_prompts(path):
    """Return (all user prompt texts, set of tool names, sidechain, cwd)."""
    prompts, tools, side, cwd = [], set(), False, None
    with open(path, encoding='utf-8', errors='replace') as fh:
        for raw in fh:
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            side = side or bool(e.get('isSidechain'))
            cwd = cwd or e.get('cwd')
            m = e.get('message') or {}
            c = m.get('content')
            if e.get('type') == 'user' and not e.get('isMeta') and not e.get('isCompactSummary'):
                if isinstance(c, str):
                    prompts.append(c)
                elif isinstance(c, list) and not any(
                        isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
                    texts = [b.get('text', '') for b in c
                             if isinstance(b, dict) and b.get('type') == 'text']
                    if texts:
                        prompts.append('\n'.join(texts))
            if e.get('type') == 'assistant' and isinstance(c, list):
                tools.update(b.get('name', '') for b in c
                             if isinstance(b, dict) and b.get('type') == 'tool_use')
    return prompts, tools, side, cwd


def first_prompt_and_tools(path):
    """Return (first user prompt text or None, set of tool names, sidechain, cwd)."""
    prompt, tools, side, cwd = None, set(), False, None
    with open(path, encoding='utf-8', errors='replace') as fh:
        for raw in fh:
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            side = side or bool(e.get('isSidechain'))
            cwd = cwd or e.get('cwd')
            m = e.get('message') or {}
            c = m.get('content')
            if e.get('type') == 'user' and prompt is None and not e.get('isMeta'):
                if isinstance(c, str):
                    prompt = c
                elif isinstance(c, list):
                    texts = [b.get('text', '') for b in c
                             if isinstance(b, dict) and b.get('type') == 'text']
                    if texts and not any(isinstance(b, dict) and b.get('type') == 'tool_result'
                                         for b in c):
                        prompt = '\n'.join(texts)
            if e.get('type') == 'assistant' and isinstance(c, list):
                tools.update(b.get('name', '') for b in c
                             if isinstance(b, dict) and b.get('type') == 'tool_use')
    return prompt, tools, side, cwd


def cmd_pick(a):
    root = Path.home() / '.claude' / 'projects'
    cands = []
    for p in sorted(root.glob(f'*{a.project}*/*.jsonl')):
        if a.all_prompts:
            prompts, tools, side, cwd = session_prompts(p)
        else:
            first, tools, side, cwd = first_prompt_and_tools(p)
            prompts = [first] if first else []
        if side or not prompts or not cwd:
            continue
        if not any('__aidex_' in t for t in tools):
            continue
        if tools & set(EDIT_TOOLS) and not a.allow_edit_sessions:
            continue
        # Runs need the project's index; a task whose project lost it measures nothing.
        if not (Path(cwd) / '.aidex' / 'index.db').exists():
            continue
        for k, prompt in enumerate(prompts):
            prompt = prompt.strip()
            if not (a.min_chars <= len(prompt) <= a.max_chars) or prompt.startswith(NOISE_PREFIXES):
                continue
            if a.questions_only and (not QUESTION_RE.search(prompt) or OPERATIONAL_RE.search(prompt)):
                continue
            cands.append({'id': f'{p.stem[:8]}-{k}', 'session': p.name, 'cwd': cwd,
                          'edited': bool(tools & set(EDIT_TOOLS)), 'prompt': prompt})
    rng = random.Random(a.seed)
    rng.shuffle(cands)
    out = {'project': a.project, 'seed': a.seed, 'eligible': len(cands), 'tasks': cands[:a.n]}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding='utf-8')
    print(f'eligible prompts: {len(cands)}, written: {len(out["tasks"])} -> {a.out}')


# --- run -------------------------------------------------------------------

def build_cmd(prompt, arm, model, budget):
    cmd = ['claude', '-p', prompt,
           '--output-format', 'stream-json', '--verbose', '--include-hook-events',
           '--setting-sources', 'project,local',
           '--strict-mcp-config', '--mcp-config', arm['mcp_config'],
           '--no-session-persistence',
           '--allowedTools', *READ_ONLY_TOOLS,
           '--disallowedTools', *DENIED_TOOLS]
    if arm.get('settings'):
        cmd += ['--settings', arm['settings']]
    if model:
        cmd += ['--model', model]
    if budget:
        cmd += ['--max-budget-usd', str(budget)]
    return cmd


def cmd_run(a):
    tasks = json.loads(Path(a.tasks).read_text(encoding='utf-8'))['tasks']
    arms = json.loads(Path(a.arms).read_text(encoding='utf-8'))
    out = Path(a.outdir)
    out.mkdir(parents=True, exist_ok=True)
    for t in tasks:
        for rep in range(a.reps):
            order = arms if (rep + len(t['id'])) % 2 == 0 else list(reversed(arms))
            for arm in order:
                stem = f"{t['id']}__{arm['name']}__r{rep}"
                dest = out / f'{stem}.jsonl'
                if dest.exists() and not a.force:
                    print(f'skip {stem} (exists)')
                    continue
                nonce = uuid.uuid4().hex[:12]
                prompt = f"{t['prompt']}\n\n(run id {nonce})"
                with open(dest, 'w', encoding='utf-8') as fo, \
                        open(out / f'{stem}.err', 'w', encoding='utf-8') as fe:
                    # A timeout still writes its meta: without one, report never
                    # sees the run and a rerun skips the partial stream.
                    try:
                        rc = subprocess.run(build_cmd(prompt, arm, a.model, a.max_budget_usd),
                                            cwd=t.get('cwd') or a.cwd, stdout=fo, stderr=fe,
                                            timeout=a.timeout).returncode
                    except subprocess.TimeoutExpired:
                        rc = 'timeout'
                (out / f'{stem}.meta.json').write_text(json.dumps(
                    {'task': t['id'], 'arm': arm['name'], 'rep': rep, 'nonce': nonce,
                     'exit': rc}), encoding='utf-8')
                print(f'{stem} exit={rc}', flush=True)


# --- report ----------------------------------------------------------------

def read_result(path):
    """Return the `result` event of a stream, or None if the run has none."""
    res = None
    with open(path, encoding='utf-8', errors='replace') as fh:
        for raw in fh:
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            if e.get('type') == 'result':
                res = e
    return res


def run_tokens(res):
    u = res.get('usage') or {}
    i, c = u.get('input_tokens', 0), u.get('cache_creation_input_tokens', 0)
    r, o = u.get('cache_read_input_tokens', 0), u.get('output_tokens', 0)
    return {
        # Primary: independent of which arm warmed the shared system/tools prefix.
        'total_tokens': i + c + r + o,
        # Secondary: shifts with run order, the first run pays the cache creation
        # (measured on one A/A pair: billed 31358 vs 19440, total 92390 vs 92393).
        'billed_tokens': i + c + o,
        'cache_read_tokens': u.get('cache_read_input_tokens', 0),
        'cost_usd': res.get('total_cost_usd'),
        'num_turns': res.get('num_turns'),
    }


def summarize(vals):
    if not vals:
        return {'n': 0, 'median': None, 'sum': None}
    return {'n': len(vals), 'median': statistics.median(vals), 'sum': round(sum(vals), 4)}


def cmd_report(a):
    out = Path(a.outdir)
    runs, failed = [], []
    for meta_p in sorted(out.glob('*.meta.json')):
        meta = json.loads(meta_p.read_text(encoding='utf-8'))
        res = read_result(meta_p.with_name(meta_p.name.replace('.meta.json', '.jsonl')))
        if meta['exit'] != 0 or res is None or res.get('is_error'):
            failed.append(meta)
            continue
        runs.append(dict(meta, **run_tokens(res)))
    arms = sorted({r['arm'] for r in runs} | {f['arm'] for f in failed})
    if len(arms) != 2:
        sys.exit(f'expected exactly 2 arms, found {arms}')
    arm_a, arm_b = arms if not a.baseline else (a.baseline, next(x for x in arms if x != a.baseline))
    per_task = {}
    for r in runs:
        per_task.setdefault(r['task'], {}).setdefault(r['arm'], []).append(r)
    metrics = ('total_tokens', 'billed_tokens', 'cache_read_tokens')
    deltas = {m: [] for m in metrics}
    rows, dropped = [], []
    for task, by_arm in sorted(per_task.items()):
        if arm_a not in by_arm or arm_b not in by_arm:
            dropped.append(task)
            continue
        row = {'task': task}
        for m in metrics:
            ma = statistics.mean(r[m] for r in by_arm[arm_a])
            mb = statistics.mean(r[m] for r in by_arm[arm_b])
            d = (mb - ma) / ma if ma else None
            if d is not None:
                deltas[m].append(d)
            row[m] = {arm_a: [r[m] for r in by_arm[arm_a]], arm_b: [r[m] for r in by_arm[arm_b]],
                      'delta': round(d, 4) if d is not None else None}
        rows.append(row)
    rep = {
        'baseline_arm': arm_a, 'compared_arm': arm_b,
        'runs_ok': len(runs), 'runs_failed': len(failed), 'failed': failed,
        'tasks_dropped_missing_arm': dropped,
        'paired_delta_total': summarize(deltas['total_tokens']),
        'paired_delta_billed_order_dependent': summarize(deltas['billed_tokens']),
        'paired_delta_cache_read': summarize(deltas['cache_read_tokens']),
        'cost_usd_total': round(sum(r['cost_usd'] or 0 for r in runs), 4),
        'per_task': rows,
    }
    Path(a.json).write_text(json.dumps(rep, indent=1), encoding='utf-8')
    print(json.dumps({k: rep[k] for k in rep if k not in ('per_task', 'failed')}, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('pick')
    p.add_argument('--project', default='', help='substring of the encoded project dir (default: all)')
    p.add_argument('--allow-edit-sessions', action='store_true',
                   help='also draw from sessions that edited files (runs still deny editing tools)')
    p.add_argument('--all-prompts', action='store_true',
                   help='draw from every user prompt of a session, not only the first')
    p.add_argument('--questions-only', action='store_true',
                   help='keep prompts that look like a question and carry no operational keyword')
    p.add_argument('--n', type=int, default=15)
    p.add_argument('--seed', type=int, default=20261004)
    p.add_argument('--min-chars', type=int, default=40)
    p.add_argument('--max-chars', type=int, default=800)
    p.add_argument('--out', required=True)
    r = sub.add_parser('run')
    r.add_argument('--tasks', required=True)
    r.add_argument('--arms', required=True, help='JSON list of {name, mcp_config, settings?}')
    r.add_argument('--reps', type=int, default=2)
    r.add_argument('--cwd', help="working directory for tasks without their own 'cwd'")
    r.add_argument('--outdir', required=True)
    r.add_argument('--model')
    r.add_argument('--max-budget-usd', type=float)
    r.add_argument('--timeout', type=int, default=900)
    r.add_argument('--force', action='store_true')
    s = sub.add_parser('report')
    s.add_argument('--outdir', required=True)
    s.add_argument('--json', required=True)
    s.add_argument('--baseline', help='arm used as the denominator (default: first by name)')
    a = ap.parse_args()
    {'pick': cmd_pick, 'run': cmd_run, 'report': cmd_report}[a.cmd](a)


if __name__ == '__main__':
    main()
