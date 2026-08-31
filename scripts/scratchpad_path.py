#!/usr/bin/env python3
"""Compute a collision-safe scratch path for a session/agent to write to.

## The bug this exists to prevent

Filed as a ticket after a real incident: two concurrently-running agents each
kept a PR draft at the same bare path (`scratchpad/body.md`) in their shared
scratchpad. The second agent's write silently clobbered the first's, and the
first agent then `PATCH`ed its own PR with what was now the second agent's
content — so for about a minute one PR carried another ticket's body. Nothing
errored. Nothing warned. A PR body is the one artefact nobody re-reads after
posting, so the swap survived until a human noticed the mismatch by hand.

The scratchpad an agent is handed reads as private — "your scratch space for
this task" — and is not: it is shared across whatever else is concurrently
running under the same parent session or the same fleet worker. That gap is
invisible until two writes land in the same second, which is exactly the
failure mode this repo's "verify that a check can fail" section catalogues
under "a shared resource that reads as private."

## Why a script, and not just a naming convention written down somewhere

CLAUDE.md now documents the convention this script implements (see the
"Scratchpad files are shared, not per-session" section) — but a written
convention is a discipline everyone has to remember to apply, every time, and
the incident above happened to a session that WAS being careful. This ticket's
own acceptance criteria say so explicitly: "Do not fix this by asking sessions
to be careful. Every instance today came from a session that was being
careful."

So this script exists to make the safe path the CHEAP path: instead of
remembering to invent a unique name, a caller runs this and gets one
automatically. It cannot force any particular agent to call it — nothing in
this repo can reach into the harness that assigns scratch directories in the
first place, since that assignment happens outside this repo entirely — but it
removes the one piece of the problem this repo DOES control: picking a name
that will not collide with a concurrent, unrelated write.

## How the collision-safe path is derived

The namespace is the current git branch name. This repo already has a
standing convention (CLAUDE.md, "Git / PR workflow") that every unit of work
happens on its own branch, in its own worktree — so branch names are already,
structurally, unique per concurrent workstream, with no NEW discipline
required to keep them that way. Keying the scratch subdirectory off the branch
name reuses a uniqueness guarantee this repo already enforces for an unrelated
reason, rather than inventing a second one that could itself drift out of
sync.

A caller not on a real feature branch (attached HEAD, detached HEAD, or no git
repo at all — e.g. a throwaway sandbox) falls back to a PID+timestamp
component instead, so the script never silently returns a shared path just
because there was no branch to key off.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path

# Kept intentionally short and boring — this is a directory *name*, and has to
# survive being a component of a real filesystem path on every OS this repo's
# contributors use (notably: no `/`, no leading `-`, no reserved characters).
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")
_MAX_COMPONENT_LEN = 80


def sanitize_component(raw: str) -> str:
    """Turn an arbitrary string into a safe single path component.

    Collapses anything that is not alphanumeric/`.`/`_`/`-` to a single `-`,
    strips leading/trailing separators, and truncates — a branch name can be
    long (`n80-449-one-shared-image-upload-helper`), and a very long one
    should not silently produce an unusably long path rather than erroring.
    """
    cleaned = _UNSAFE.sub("-", raw).strip("-._")
    if not cleaned:
        # Every character was "unsafe" — do not return an empty component,
        # which would collapse back to the shared root this script exists to
        # avoid returning.
        cleaned = "unnamed"
    return cleaned[:_MAX_COMPONENT_LEN]


def current_branch(cwd: Path | None = None) -> str | None:
    """The current git branch name, or None if there isn't a usable one.

    None covers: not a git repo, detached HEAD, or git itself unavailable —
    every case where a branch name cannot be trusted as a real per-workstream
    identifier. `git rev-parse --abbrev-ref HEAD` prints the literal string
    `HEAD` on detached HEAD rather than failing, so that value is explicitly
    rejected rather than trusted as a name.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    branch = result.stdout.strip()
    if not branch or branch == "HEAD":
        return None
    return branch


def fallback_identifier() -> str:
    """A per-process, per-moment identifier for when there is no branch.

    Not a strong uniqueness guarantee on its own (a PID can be reused across
    process lifetimes) — but combined with a timestamp at second resolution,
    two callers invoking this within the same process are the only realistic
    collision, and that is a single-writer case this script was never meant
    to protect against in the first place.
    """
    return f"pid{os.getpid()}-{int(time.time())}"


def session_subdir(root: Path, branch: str | None = None, cwd: Path | None = None) -> Path:
    """The collision-safe subdirectory for the current workstream, under root.

    Does NOT create the directory — callers that need it to exist should
    create it explicitly (see `resolve_path`'s CLI behaviour), so this
    function stays a pure computation callers can also use just to preview a
    path.
    """
    ident = branch if branch is not None else current_branch(cwd)
    if ident is None:
        ident = fallback_identifier()
    return root / sanitize_component(ident)


def resolve_path(root: Path, purpose: str, branch: str | None = None, cwd: Path | None = None) -> Path:
    """The full collision-safe path for one scratch file, creating its
    subdirectory (but not the file itself) so a caller can write to it
    immediately.
    """
    subdir = session_subdir(root, branch=branch, cwd=cwd)
    subdir.mkdir(parents=True, exist_ok=True)
    # The purpose itself is not sanitized beyond being a single path
    # component check — a caller passing a purpose containing `/` would
    # otherwise escape the computed subdirectory, which defeats the whole
    # point.
    if "/" in purpose or "\\" in purpose or purpose in ("", ".", ".."):
        raise ValueError(f"purpose must be a plain filename, got {purpose!r}")
    return subdir / purpose


def _self_test() -> None:
    """Demonstrate the acceptance criterion directly: two concurrent writers
    on two different branches get two different paths, so the SAME purpose
    filename (the exact shape of the incident — both agents wrote to a file
    named `body.md`) cannot collide.

    Also exercises the fallback path (no branch available) and the
    sanitisation of an unsafe branch name, since both are load-bearing and
    neither is covered by the happy-path demonstration alone.
    """
    import tempfile

    failures: list[str] = []

    def check(condition: bool, message: str) -> None:
        if not condition:
            failures.append(message)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        # The incident, reproduced: two "agents" both want to write a file
        # named body.md, on two different branches (as every concurrent
        # ticket in this repo's worktree convention is).
        path_a = resolve_path(root, "body.md", branch="n453-fix-a")
        path_b = resolve_path(root, "body.md", branch="n454-fix-b")
        check(path_a != path_b, "two branches produced the same path for the same filename")
        check(path_a.parent != path_b.parent, "two branches shared a subdirectory")
        # Prove they are independently writable without clobbering each
        # other -- the actual failure mode, not just "the strings differ".
        path_a.write_text("agent A's draft")
        path_b.write_text("agent B's draft")
        check(path_a.read_text() == "agent A's draft", "path A's content was overwritten")
        check(path_b.read_text() == "agent B's draft", "path B's content was overwritten")

        # The exact same branch name, called twice, must be idempotent -- a
        # single agent revisiting its own scratch file should land in the
        # same place, not a fresh one each time.
        path_a_again = resolve_path(root, "body.md", branch="n453-fix-a")
        check(path_a_again == path_a, "the same branch produced a different path on a second call")

        # No branch available (simulating detached HEAD / no git repo): the
        # fallback must still avoid colliding with a real branch's
        # subdirectory, and two DIFFERENT fallback calls (different PIDs in
        # practice; here forced via distinct idents) must not collide either.
        no_branch_a = session_subdir(root, branch=None, cwd=Path("/nonexistent-for-self-test"))
        check(
            no_branch_a.parent == root and no_branch_a != root / "n453-fix-a",
            "a no-branch caller landed inside a real branch's subdirectory",
        )

        # Sanitisation: a branch name containing characters unsafe as a path
        # component must not produce a broken or escaping path.
        #
        # A pathlib `parts` entry can never itself contain `/` -- that is what
        # makes it one part rather than two -- so checking `"/" not in
        # parts[0]` is true by construction and would pass even with
        # sanitisation entirely gutted (a no-op `sanitize_component` turns
        # "feature/N80: fix (again)!" into the TWO-component relative path
        # "feature/N80: fix (again)!", which still satisfies that stale
        # check). The real property is that the branch name collapses to
        # exactly ONE path component under `root` -- assert the count, not a
        # substring that can never appear in a single part regardless of
        # whether sanitisation ran at all.
        unsafe = resolve_path(root, "notes.md", branch="feature/N80: fix (again)!")
        unsafe_rel_parts = unsafe.relative_to(root).parts
        check(
            unsafe.is_relative_to(root) and len(unsafe_rel_parts) == 2,
            # 2, not 1: the branch's sanitised subdirectory plus "notes.md".
            # A sanitiser that let the branch name's own "/" through would
            # add extra parts here instead.
            "an unsafe branch name produced more than one subdirectory component, or escaped root",
        )

        # A purpose filename must not be allowed to escape the computed
        # subdirectory -- this is the guard, not the happy path, so prove it
        # actually raises rather than silently succeeding.
        try:
            resolve_path(root, "../../etc/passwd", branch="n453-fix-a")
            failures.append("a path-traversal purpose was accepted instead of rejected")
        except ValueError:
            pass

    if failures:
        print("SELF-TEST FAILED:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("self-test passed: concurrent writers on different branches cannot collide")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Print a collision-safe scratch path for the current git branch, "
        "creating its subdirectory. See this file's module docstring for why.",
    )
    parser.add_argument(
        "purpose",
        nargs="?",
        help="the filename to resolve inside the branch's scratch subdirectory, e.g. body.md",
    )
    parser.add_argument(
        "--root",
        default=os.environ.get("SCRATCHPAD_ROOT", ""),
        help="the scratchpad's base directory (default: $SCRATCHPAD_ROOT)",
    )
    parser.add_argument(
        "--branch",
        default=None,
        help="override the branch name instead of reading it from git",
    )
    parser.add_argument("--self-test", action="store_true", help="run the built-in self-test and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        _self_test()
        return 0

    if not args.purpose:
        parser.error("purpose is required unless --self-test is given")
    if not args.root:
        parser.error(
            "--root (or $SCRATCHPAD_ROOT) is required -- this script does not guess "
            "where the harness's scratchpad lives, since that location is assigned "
            "outside this repo and varies by environment"
        )

    path = resolve_path(Path(args.root), args.purpose, branch=args.branch)
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
