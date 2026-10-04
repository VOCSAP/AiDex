#!/usr/bin/env python3
"""Measure what an entity-level diff would show on real commits (sem study S4/S5).

Runs the `sem` binary (https://github.com/Ataraxy-Labs/sem) on the last N
non-merge commits of a repository and reports:
  - cosmetic share: modified entities whose change is formatting/comments
    only (`structuralChange: false`), counted BOTH per (commit, entity) pair
    and per distinct entityId -- never one of the two alone;
  - output size: lines of `sem diff --format plain` per commit, against the
    100-line cap aidex_query applies to its own output.

Usage:
  python scripts/eval/sem_cosmetic.py --repo PATH [--sem BIN] [-n 50]
"""

import argparse
import json
import os
import statistics
import subprocess


def run(cmd, cwd):
    env = dict(os.environ, SEM_NO_TELEMETRY='1')
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True,
                          encoding='utf-8', errors='replace').stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True)
    ap.add_argument('--sem', default='sem')
    ap.add_argument('-n', type=int, default=50)
    ap.add_argument('--dump', help='write every cosmetic change (JSON) here, for verbatim review')
    a = ap.parse_args()
    cosmetic_cases = []

    shas = run(['git', 'log', '--format=%h', '-n', str(a.n), '--no-merges'], a.repo).split()
    pairs = cosmetic_pairs = 0
    distinct, distinct_structural = set(), set()
    plain_lines, git_lines = [], []
    for sha in shas:
        out = run([a.sem, 'diff', '--commit', sha, '--format', 'json'], a.repo)
        try:
            doc = json.loads(out)
        except ValueError:
            continue
        for ch in doc.get('changes', []):
            if ch.get('changeType') != 'modified':
                continue
            pairs += 1
            eid = ch['entityId']
            distinct.add(eid)
            if ch.get('structuralChange') is False:
                cosmetic_pairs += 1
                cosmetic_cases.append(dict(ch, commit=sha))
            else:
                distinct_structural.add(eid)
        plain_lines.append(run([a.sem, 'diff', '--commit', sha, '--format', 'plain'],
                               a.repo).count('\n'))
        git_lines.append(run(['git', 'diff', f'{sha}~1', sha], a.repo).count('\n'))

    if a.dump:
        with open(a.dump, 'w', encoding='utf-8') as fh:
            json.dump(cosmetic_cases, fh, indent=1)

    # An entity is "only ever cosmetic" if no commit changed it structurally.
    only_cosmetic = len(distinct - distinct_structural)
    over_cap = sum(1 for n in plain_lines if n > 100)
    print(json.dumps({
        'commits': len(plain_lines),
        'modified_pairs': pairs,
        'cosmetic_pairs': cosmetic_pairs,
        'cosmetic_pair_share': round(cosmetic_pairs / pairs, 4) if pairs else None,
        'distinct_modified_entities': len(distinct),
        'distinct_only_ever_cosmetic': only_cosmetic,
        'distinct_cosmetic_share': round(only_cosmetic / len(distinct), 4) if distinct else None,
        'plain_lines_median': statistics.median(plain_lines) if plain_lines else None,
        'plain_commits_over_100_lines': over_cap,
        'git_diff_lines_median': statistics.median(git_lines) if git_lines else None,
    }, indent=2))


if __name__ == '__main__':
    main()
