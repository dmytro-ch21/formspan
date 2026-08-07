#!/usr/bin/env python3
"""Parse every Python script in scripts/ and fail on a syntax error.

The floor, not the ceiling. Nothing in this repo read a .py file until this
existed — no CI step, no `verify` link, no pyproject/ruff config anywhere — so
a script could be committed broken and stay broken until someone ran it by
hand. These are content-pipeline tools; the one that imports the catalog is
run rarely and at exactly the moment being wrong is expensive.

The precedent: scan-library.py spent months building its corpus by
concatenating techniques.json with techniques.additions.json, counting every
addition twice and skewing the word rarities its FLOOR threshold was tuned
against. It was found by reading the code, not by any check. (The spreadsheet
retirement has since deleted that file and the bug with it — but a syntax
guard would not have caught that one either. This is the floor. Anything
about a script's BEHAVIOUR needs a check that runs the script.)

Uses ast.parse rather than py_compile/compileall on purpose: those write
__pycache__ next to the source, and a check that dirties the tree it is
checking will eventually show up in somebody's `git status`.

Deliberately not a linter. There is no ruff/uv/pipx on the machines this runs
on, and adding a Python toolchain to a pnpm+Go repo for six scripts is a
bigger decision than this guard needs to make. Stdlib only, so `pnpm run
verify` needs no install step.
"""
import ast
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[0]


def main() -> int:
    files = sorted(SCRIPTS.glob("*.py"))
    if not files:
        print("check-python-syntax: no .py files found — did scripts/ move?")
        return 1

    bad = 0
    for path in files:
        try:
            ast.parse(path.read_text(), filename=str(path))
        except SyntaxError as exc:
            rel = path.relative_to(SCRIPTS.parent)
            print(f"{rel}:{exc.lineno}:{exc.offset}: {exc.msg}")
            bad += 1

    if bad:
        print(f"check-python-syntax: {bad} of {len(files)} file(s) failed to parse")
        return 1
    print(f"check-python-syntax: {len(files)} files parse clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
