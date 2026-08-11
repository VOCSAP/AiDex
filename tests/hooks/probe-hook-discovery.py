"""The hook must carry no machine-specific path of its own.

Two things are checked, because either alone can pass while the other is broken:
  1. the SOURCE holds no absolute path -- grep-level, catches a path typed back in;
  2. discovery actually RESOLVES on this machine, and an explicit override still
     wins over it -- behavioural, catches a discovery that finds nothing and
     leaves the hook permanently inert.
"""
import importlib.util
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK = os.path.join(REPO_ROOT, "hooks", "claude", "aidex-grep-nudge.py")

failures = 0


def check(ok, label, detail=""):
    global failures
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'} {label}{(' -> ' + detail) if detail else ''}")


# 1. No absolute path baked into the source. Windows drive letters, POSIX
#    absolute paths under the usual roots, and %ENVVAR%-style expansions.
source = open(HOOK, encoding="utf-8").read()
BAKED = [
    (r"[A-Za-z]:[\\/]", "windows drive path"),
    (r"%[A-Z_]+%[\\/]", "environment-variable path expansion"),
    (r"[\"']/(?:home|Users|opt|usr)/", "posix absolute path"),
]
for pattern, label in BAKED:
    hits = [m.group(0) for m in re.finditer(pattern, source)]
    check(not hits, f"source carries no {label}", ", ".join(sorted(set(hits))[:3]))

spec = importlib.util.spec_from_file_location("h", HOOK)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

# 2. Discovery resolves here, and points at files that exist.
node, entry = module.discover_aidex()
check(bool(node and entry), "discovery finds the aidex MCP declaration", f"{node} | {entry}")
if node and entry:
    check(os.path.isfile(entry), "the discovered entry point exists", entry)

# 3. An explicit override still wins. Re-import with the env set, since the
#    module resolves its candidates at import time.
os.environ["AIDEX_NODE"] = "OVERRIDDEN_NODE"
os.environ["AIDEX_ENTRY"] = "OVERRIDDEN_ENTRY"
spec2 = importlib.util.spec_from_file_location("h2", HOOK)
module2 = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(module2)
check(module2.NODE_CANDIDATES[0] == "OVERRIDDEN_NODE", "AIDEX_NODE takes precedence")
check(module2.AIDEX_ENTRY == "OVERRIDDEN_ENTRY", "AIDEX_ENTRY takes precedence")
del os.environ["AIDEX_NODE"], os.environ["AIDEX_ENTRY"]

print(f"\n{6 - failures}/6 green")
sys.exit(1 if failures else 0)
