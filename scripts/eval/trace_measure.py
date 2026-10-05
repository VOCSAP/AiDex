#!/usr/bin/env python3
"""Measure, on real Claude Code transcripts, the needs behind two studies.

See docs/plans/sem-entity-diff-study.md (section 4) and
docs/plans/mex-study.md (section 4). Stdlib only, read-only on the trace.

Measures:
  sem-git-diff   git diff / show / log -p run by the agent through Bash,
                 their output weight, and the Read that follows.
  mex-read-after Read that follows an aidex search (query / signature /
                 signatures / search), whole vs partial, and whether the
                 partial range sits inside a method span AiDex had returned.
  mex-stale      aidex_query hits on a file edited earlier in the same turn
                 (the index is only refreshed by the Stop hook).
  mex-routes     Grep / grep / rg patterns that look like a web route.

Transcript conventions this parser relies on (checked on a 2026-10 file):
  - one JSONL entry per content block; an assistant API message is split
    across several entries sharing message.id (usage is repeated: dedupe);
  - tool_use.id <-> tool_result.tool_use_id pairs a call with its result;
  - a real user prompt is a `user` entry whose content is a string or holds
    `text` blocks and no `tool_result` block; tool results also travel in
    `user` entries and must NOT open a new turn;
  - subagent transcripts are separate files with isSidechain=true; they are
    scanned as their own sessions, so a subagent edit is invisible to the
    parent session (known limit for mex-stale).

Usage:
  python scripts/eval/trace_measure.py [--root DIR] [--project SUBSTR]
                                       [--window 3] [--samples 20]
                                       [--seed 1] [--json OUT]
"""

import argparse
import json
import random
import re
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

BYTES_PER_TOKEN = 4.35  # midpoint of the 4.2-4.5 observed in CLAUDE.md

AIDEX_SEARCH_RE = re.compile(r'(?:^|__)aidex_(query|signature|signatures|search)$')
AIDEX_QUERY_RE = re.compile(r'(?:^|__)aidex_query$')
EDIT_TOOLS = {'Edit', 'Write', 'MultiEdit', 'NotebookEdit'}

GIT_RE = re.compile(
    r'\bgit\s+(?:(?:-C|-c)\s+\S+\s+|--no-pager\s+|--git-dir=\S+\s+)*(diff|show|log)\b([^|;&]*)')
STAT_RE = re.compile(r'--(?:stat|shortstat|numstat|dirstat)\b')
NAMES_RE = re.compile(r'--name-(?:only|status)\b')
PATCH_RE = re.compile(r'(?:\s-p\b|--patch\b|\s-u\b)')
SHOW_BLOB_RE = re.compile(r'\s\S*:\S+')  # git show <ref>:<path>

DIFF_PATH_RES = [
    re.compile(r'^diff --git a/(\S+) b/(\S+)', re.M),
    re.compile(r'^\+\+\+ b/(\S+)', re.M),
    re.compile(r'^ (\S+?)\s+\|\s+(?:\d+|Bin)', re.M),  # --stat line
    re.compile(r'^[AMDRCTU]\d*\t(\S+)(?:\t(\S+))?$', re.M),  # --name-status
]

# aidex_query: "<file>" line followed by "  :<n> (<type>)" lines.
QUERY_FILE_RE = re.compile(r'^(\S[^\n]*?)\n((?:\s+:\d+[^\n]*\n?)+)', re.M)
QUERY_LINE_RE = re.compile(r':(\d+)')
SIG_FILE_RE = re.compile(r'^# Signature: (.+)$', re.M)
SIG_SPAN_RE = re.compile(r'\(line (\d+)(?:-(\d+))?\)')

ROUTE_RE = re.compile(r'''(?:^|["'`\s(])/(?:api|v\d+|[a-z][\w-]*)(?:/[\w:{}\[\].-]*)+''', re.I)
GREP_CMD_RE = re.compile(r'\b(?:grep|rg|egrep|findstr)\b')


def norm(p):
    return p.replace('\\', '/').strip().strip('"\'').lower()


def same_file(read_path, candidate):
    """candidate is usually project-relative, read_path absolute."""
    a, b = norm(read_path), norm(candidate)
    if not a or not b:
        return False
    return a == b or a.endswith('/' + b.lstrip('./')) or b.endswith('/' + a.lstrip('./'))


def result_text(block):
    c = block.get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return '\n'.join(x.get('text', '') for x in c if isinstance(x, dict))
    return ''


def is_user_prompt(entry):
    if entry.get('type') != 'user' or entry.get('isMeta') or entry.get('isCompactSummary'):
        return False
    c = entry.get('message', {}).get('content')
    if isinstance(c, str):
        return True
    if isinstance(c, list):
        kinds = {x.get('type') for x in c if isinstance(x, dict)}
        return 'tool_result' not in kinds and bool(kinds & {'text', 'image'})
    return False


class Call:
    __slots__ = ('id', 'name', 'input', 'turn', 'msg', 'seq', 'text', 'nbytes', 'error')

    def __init__(self, cid, name, inp, turn, msg, seq):
        self.id, self.name, self.input = cid, name, inp or {}
        self.turn, self.msg, self.seq = turn, msg, seq
        self.text, self.nbytes, self.error = '', 0, False


def load_session(path):
    calls, by_id = [], {}
    turn, seq, msg_order = 0, 0, {}
    sidechain = False
    with open(path, encoding='utf-8', errors='replace') as fh:
        for raw in fh:
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            sidechain = sidechain or bool(e.get('isSidechain'))
            if is_user_prompt(e):
                turn += 1
                continue
            m = e.get('message') or {}
            content = m.get('content')
            if not isinstance(content, list):
                continue
            if e.get('type') == 'assistant':
                mid = m.get('id') or e.get('uuid')
                if mid not in msg_order:
                    msg_order[mid] = len(msg_order)
                for b in content:
                    if isinstance(b, dict) and b.get('type') == 'tool_use':
                        c = Call(b.get('id'), b.get('name', ''), b.get('input'), turn,
                                 msg_order[mid], seq)
                        seq += 1
                        calls.append(c)
                        by_id[c.id] = c
            elif e.get('type') == 'user':
                for b in content:
                    if isinstance(b, dict) and b.get('type') == 'tool_result':
                        c = by_id.get(b.get('tool_use_id'))
                        if c is not None:
                            c.text = result_text(b)
                            c.nbytes = len(c.text.encode('utf-8'))
                            c.error = bool(b.get('is_error'))
    return calls, sidechain


def followups(calls, i, window):
    """Calls in the next `window` assistant messages of the same turn.
    Calls of the same message (parallel batch) are excluded: they could not
    have been caused by this call's result."""
    base = calls[i]
    out = []
    for c in calls[i + 1:]:
        if c.turn != base.turn or c.msg - base.msg > window:
            break
        if c.msg > base.msg:
            out.append(c)
    return out


def read_range(c):
    off, lim = c.input.get('offset'), c.input.get('limit')
    if off is None and lim is None:
        return None  # whole file (or the tool's default cap)
    # Model-emitted inputs are not always numeric (e.g. offset "195, 340").
    start = _first_int(off, 1)
    return (start, start + _first_int(lim, 2000) - 1)


def _first_int(v, default):
    m = re.search(r'\d+', str(v)) if v is not None else None
    return int(m.group()) if m else default


def summarize(values):
    if not values:
        return {'n': 0, 'sum': 0, 'median': 0}
    return {'n': len(values), 'sum': sum(values), 'median': statistics.median(values)}


SECTION_RE = re.compile(r'^(?:# Signature: |## )(.+)$', re.M)
NON_FILE_HEADINGS = ('Header Comments', 'Types', 'Methods')
SPAN_RES = [SIG_SPAN_RE, re.compile(r' :(\d+)(?:-(\d+))?$', re.M)]
# aidex_search: "N. [kind] name" then an indented "<file>:<line>" line.
SEARCH_HIT_RE = re.compile(r'^\s+(\S[^\n:]*?):(\d+)\s*$', re.M)


def parse_aidex_files(c):
    """Return {file: {'hits': set(lines), 'spans': [(a, b)]}} from an aidex result.

    Formats (src/server/tools.ts): aidex_signature "# Signature: <file>" then
    "(line A-B)"; aidex_signatures "## <file>" then "  - <proto> :A-B";
    aidex_query "<file>" then "  :<n> (<type>)" lines.
    """
    out = defaultdict(lambda: {'hits': set(), 'spans': []})
    t = c.text
    heads = [m for m in SECTION_RE.finditer(t)
             if not m.group(1).strip().startswith(NON_FILE_HEADINGS)]
    for k, m in enumerate(heads):
        f = m.group(1).strip()
        body = t[m.end():heads[k + 1].start() if k + 1 < len(heads) else len(t)]
        for r in SPAN_RES:
            for a, b in r.findall(body):
                out[f]['spans'].append((int(a), int(b or a)))
    for m in QUERY_FILE_RE.finditer(t):
        f = m.group(1).strip()
        if f.startswith(('Found ', 'No matches', 'Terms ', '#', '-', '`')):
            continue
        for ln in QUERY_LINE_RE.findall(m.group(2)):
            out[f]['hits'].add(int(ln))
    if t.startswith('# Search results'):
        for f, ln in SEARCH_HIT_RE.findall(t):
            out[f.strip()]['hits'].add(int(ln))
    if not out and c.input.get('file'):
        out[str(c.input['file'])]['hits']  # file named in the input, no span parsed
    return out


def measure(files, window, samples, seed):
    rng = random.Random(seed)
    total = {'sessions': 0, 'sidechain_sessions': 0, 'calls': 0, 'result_bytes': 0}
    sem = {'calls': [], 'unpiped': [], 'by_kind': Counter(), 'sessions': set(), 'piped': 0,
           'follow_read': 0, 'follow_read_whole': 0, 'follow_read_bytes': [], 'samples': []}
    rd = {'calls': 0, 'by_tool': Counter(), 'sessions': set(), 'with_read': 0,
          'reads_whole': 0, 'reads_partial': 0, 'partial_in_span': 0,
          'partial_on_hit': 0, 'partial_in_span_or_hit': 0, 'read_bytes': [], 'samples': []}
    st = {'queries': 0, 'stale_queries': 0, 'samples': []}
    rt = {'occurrences': 0, 'distinct': Counter()}

    for path in files:
        calls, side = load_session(path)
        total['sessions'] += 1
        total['sidechain_sessions'] += int(side)
        total['calls'] += len(calls)
        total['result_bytes'] += sum(c.nbytes for c in calls)
        sid = str(path)
        spans_seen = defaultdict(list)  # file -> spans returned earlier in session
        edited_in_turn = defaultdict(set)  # turn -> edited paths

        for i, c in enumerate(calls):
            name = c.name
            # --- sem: git diff family -------------------------------------
            if name == 'Bash':
                cmd = str(c.input.get('command', ''))
                m = GIT_RE.search(cmd)
                if m:
                    verb, rest = m.group(1), m.group(2)
                    kind = None
                    if verb == 'show' and SHOW_BLOB_RE.search(rest):
                        kind = 'show-blob'
                    elif verb == 'log' and not PATCH_RE.search(' ' + rest):
                        kind = None  # plain log carries no diff
                    elif STAT_RE.search(rest):
                        kind = f'{verb}-stat'
                    elif NAMES_RE.search(rest):
                        kind = f'{verb}-names'
                    else:
                        kind = f'{verb}-patch'
                    if kind:
                        sem['by_kind'][kind] += 1
                    if kind == 'show-blob':
                        kind = None  # reads a file at a ref: not what an entity diff replaces
                    if kind:
                        sem['sessions'].add(sid)
                        sem['calls'].append(c.nbytes)
                        # Output piped into wc/head/grep is not the diff the agent read.
                        if '|' in cmd[m.end() - len(rest):]:
                            sem['piped'] += 1
                        else:
                            sem['unpiped'].append(c.nbytes)
                        paths = set()
                        for r in DIFF_PATH_RES:
                            for g in r.findall(c.text):
                                paths.update(x for x in (g if isinstance(g, tuple) else (g,)) if x)
                        reads = [f for f in followups(calls, i, window)
                                 if f.name == 'Read' and any(
                                     same_file(f.input.get('file_path', ''), p) for p in paths)]
                        if reads:
                            sem['follow_read'] += 1
                            sem['follow_read_whole'] += int(any(read_range(r) is None for r in reads))
                            sem['follow_read_bytes'].extend(r.nbytes for r in reads)
                        sem['samples'].append({'session': sid, 'kind': kind, 'bytes': c.nbytes,
                                               'command': cmd[:300],
                                               'reads': [r.input.get('file_path') for r in reads]})
                if GREP_CMD_RE.search(cmd):
                    for r in ROUTE_RE.findall(cmd):
                        rt['occurrences'] += 1
                        rt['distinct'][r.strip(' "\'`(')] += 1
            elif name == 'Grep':
                for r in ROUTE_RE.findall(' ' + str(c.input.get('pattern', ''))):
                    rt['occurrences'] += 1
                    rt['distinct'][r.strip(' "\'`(')] += 1

            if name in EDIT_TOOLS:
                fp = c.input.get('file_path') or c.input.get('notebook_path') or ''
                if fp:
                    edited_in_turn[c.turn].add(fp)

            # --- mex: Read after aidex search ------------------------------
            if AIDEX_SEARCH_RE.search(name):
                rd['calls'] += 1
                rd['by_tool'][AIDEX_SEARCH_RE.search(name).group(1)] += 1
                rd['sessions'].add(sid)
                found = parse_aidex_files(c)
                for f, info in found.items():
                    spans_seen[norm(f)].extend(info['spans'])
                reads = [f for f in followups(calls, i, window)
                         if f.name == 'Read' and any(
                             same_file(f.input.get('file_path', ''), p) for p in found)]
                if reads:
                    rd['with_read'] += 1
                for r in reads:
                    rd['read_bytes'].append(r.nbytes)
                    rng_ = read_range(r)
                    if rng_ is None:
                        rd['reads_whole'] += 1
                        continue
                    rd['reads_partial'] += 1
                    fp = r.input.get('file_path', '')
                    spans = [s for k, v in spans_seen.items() if same_file(fp, k) for s in v]
                    in_span = any(a <= rng_[0] + 3 and rng_[1] - 3 <= b for a, b in spans)
                    hits = [h for k, v in found.items() if same_file(fp, k) for h in v['hits']]
                    on_hit = any(rng_[0] <= h <= rng_[1] for h in hits)
                    rd['partial_in_span'] += int(in_span)
                    rd['partial_on_hit'] += int(on_hit)
                    # The two flags overlap; their sum can exceed reads_partial.
                    rd['partial_in_span_or_hit'] += int(in_span or on_hit)
                rd['samples'].append({'session': sid, 'tool': name, 'input': c.input,
                                      'files': list(found)[:5],
                                      'reads': [(r.input.get('file_path'), read_range(r))
                                                for r in reads]})

                # --- mex: stale hits -----------------------------------
                if AIDEX_QUERY_RE.search(name):
                    st['queries'] += 1
                    edited = edited_in_turn.get(c.turn, set())
                    stale = [f for f in found if any(same_file(e, f) for e in edited)]
                    if stale:
                        st['stale_queries'] += 1
                        st['samples'].append({'session': sid, 'term': c.input.get('term'),
                                              'stale_files': stale})

    def sample(lst):
        return rng.sample(lst, min(samples, len(lst)))

    rb = total['result_bytes'] or 1
    sem_sum = sum(sem['calls'])
    return {
        'scope': total,
        'bytes_per_token_estimate': BYTES_PER_TOKEN,
        'sem_git_diff': {
            'calls_by_kind': dict(sem['by_kind']),
            'sessions_with_call': len(sem['sessions']),
            'result_bytes': summarize(sem['calls']),
            'share_of_all_result_bytes': round(sem_sum / rb, 4),
            'piped_calls': sem['piped'],
            'unpiped_result_bytes': summarize(sem['unpiped']),
            'unpiped_share_of_all_result_bytes': round(sum(sem['unpiped']) / rb, 4),
            'calls_followed_by_read_of_diffed_file': sem['follow_read'],
            'of_which_whole_file': sem['follow_read_whole'],
            'followup_read_bytes': summarize(sem['follow_read_bytes']),
            'random_sample': sample(sem['samples']),
        },
        'mex_read_after_search': {
            'calls_by_tool': dict(rd['by_tool']),
            'sessions_with_call': len(rd['sessions']),
            'calls_followed_by_read_of_returned_file': rd['with_read'],
            'reads_whole_file': rd['reads_whole'],
            'reads_partial': rd['reads_partial'],
            'partial_inside_returned_method_span': rd['partial_in_span'],
            'partial_covering_a_returned_hit_line': rd['partial_on_hit'],
            'partial_in_span_or_hit': rd['partial_in_span_or_hit'],
            'followup_read_bytes': summarize(rd['read_bytes']),
            'random_sample': sample(rd['samples']),
        },
        'mex_stale': {
            'aidex_query_calls': st['queries'],
            'calls_hitting_file_edited_earlier_same_turn': st['stale_queries'],
            'random_sample': sample(st['samples']),
        },
        'mex_routes': {
            'occurrences': rt['occurrences'],
            'distinct_patterns': len(rt['distinct']),
            'patterns': rt['distinct'].most_common(),
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--root', default=str(Path.home() / '.claude' / 'projects'))
    ap.add_argument('--project', default='', help='substring filter on the path')
    ap.add_argument('--window', type=int, default=3,
                    help='assistant messages scanned after a call (same turn)')
    ap.add_argument('--samples', type=int, default=20)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--json', help='write the full report here')
    a = ap.parse_args()

    files = sorted(p for p in Path(a.root).rglob('*.jsonl') if a.project in str(p))
    if not files:
        sys.exit(f'no .jsonl under {a.root!r} matching {a.project!r}')
    rep = measure(files, a.window, a.samples, a.seed)

    text = json.dumps(rep, indent=2, ensure_ascii=False, default=list)
    if a.json:
        Path(a.json).write_text(text, encoding='utf-8')
    short = {k: ({kk: vv for kk, vv in v.items() if kk not in ('random_sample', 'patterns')}
                 if isinstance(v, dict) else v) for k, v in rep.items()}
    print(json.dumps(short, indent=2, ensure_ascii=False, default=list))


if __name__ == '__main__':
    main()
