#!/usr/bin/env python3
"""Makes an executor's release file (S18, §8.6): its source with executor_core.py's code in place of the block

    # >>> executor_core
    from executor_core import (...)
    # <<< executor_core

so the release holds one file. launch.sh runs it as it is, and an installed executor that predates executor_core
accepts the archive: it holds exactly the files that executor checks for, and the file says its VERSION once.

    python3 executor/bundle.py executor/deployer_executor.py > out/deployer_executor.py
"""
import ast
import pathlib
import re
import sys

BEGIN, END = "# >>> executor_core", "# <<< executor_core"


def bundle(source):
    source = pathlib.Path(source)
    lines = source.read_text().split("\n")
    begins = [i for i, line in enumerate(lines) if line.strip() == BEGIN]
    ends = [i for i, line in enumerate(lines) if line.strip() == END]
    if len(begins) != 1 or len(ends) != 1 or ends[0] < begins[0]:
        raise SystemExit(f"{source}: needs one {BEGIN} … {END} block")
    core_path = source.parent / "executor_core.py"
    core = core_path.read_text()
    tree = ast.parse(core)
    start = 0
    if tree.body and isinstance(tree.body[0], ast.Expr) and isinstance(getattr(tree.body[0], "value", None), ast.Constant):
        start = tree.body[0].end_lineno  # the module's docstring stays in executor_core.py
    body = core.split("\n")[start:]
    out = "\n".join(lines[:begins[0]] + [f"{BEGIN}: bundled from executor_core.py (edit that file, not this block)"]
                    + body + [END] + lines[ends[0] + 1:])
    if re.search(r"^\s*(from|import)\s+executor_core\b", out, re.M):
        raise SystemExit(f"{source}: still imports executor_core outside the block")
    if len(re.findall(r'^VERSION = "[^"]+"', out, re.M)) != 1:
        raise SystemExit(f"{source}: the bundled file must say VERSION exactly once")
    compile(out, source.name, "exec")
    return out


def main(argv):
    if len(argv) not in (2, 3):
        raise SystemExit("usage: bundle.py <executor source> [<out file>]")
    out = bundle(argv[1])
    if len(argv) == 3:
        pathlib.Path(argv[2]).write_text(out)
    else:
        sys.stdout.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
