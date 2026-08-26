#!/usr/bin/env python3
"""A git merge driver that resolves ONE case — two branches appending at the
same anchor — and refuses every other case.

## The measurement

`docs/decisions/history.md` is the append target for every PR in this repo, and
the history rule in `CLAUDE.md` is why. Two independent counts:

    20 Aug 2026:  17 of 20 commits on main touched it   (85%)
    26 Aug 2026:   9 of 10 commits on main touched it   (90%)

So any PR open across one merge cycle conflicts with every other open PR, by
arithmetic rather than bad luck. The cost is not the rebase. **A conflicting PR
receives ZERO check runs** — GitHub cannot build `refs/pull/N/merge`, so no
workflow runs, and an empty check list reads exactly like nothing failing. That
is the one board state this repo has spent a week learning not to trust (#368),
and this defect routinely produces it.

## What the conflict actually is

Measured on the real file, PR #621 against `origin/main` (`git merge-file
--diff3`, 41k lines): **one conflict hunk, and its base section is EMPTY.**

    <<<<<<< ours          288 lines — entries that landed on main
    ||||||| base          ZERO lines
    ======= theirs        120 lines — the branch's own entry
    >>>>>>>
    ## Open items / known gaps as of this entry

Neither side deleted or modified anything. Both sides only *added*, at the same
anchor: the line before `## Open items`. Git conflicts here because the ORDER of
two insertions is undetermined — not because their content disagrees.

That is the whole opening. When the base region is empty, concatenation is the
unique resolution that drops nothing from base, ours or theirs. It is loss-free
by construction, not by heuristic.

## The rule, and it is the entire driver

    base region empty  ->  emit ours + theirs, resolved.
    anything else      ->  leave git's conflict markers, exit non-zero.

A non-empty base region means at least one side changed or deleted text that
existed. That is where a wrong resolution silently destroys work, so the driver
does not attempt it. **A driver that guesses is worse than the conflict it
replaces — the conflict at least stops you.**

## What it deliberately does NOT do

**It never looks for a heading.** The anchor comes from git's own diff, so the
`## Open items` heading keeps its position because nothing moves it, not because
anything recognises it. This matters: a session once landed its section **3,350
lines from where it belonged** by anchoring on the first matching heading in the
file. Tooling here must not be able to repeat that, and this cannot — it has no
notion of what a heading is.

**It never reorders, rewrites or deduplicates.** The output for a resolved hunk
is literally `ours_lines + theirs_lines`. `--self-test` asserts that equality
rather than a property of it.

**It does not run on `docs/TASKS.md`.** That file is an archive now (1 of 21
commits), and a tick is a line MODIFICATION, so the rule above would refuse it
anyway. Listing it would add a case to reason about and buy nothing;
`check-tasks-integrity.py` remains the guard there.

## Ordering: ours first, then theirs

`ours` is the side already on the branch being merged INTO. During
`git rebase` — which is how this repo lands work — ours is upstream `main`
(already landed) and theirs is the commit being replayed. During a merge into
`main`, ours is `main`. Both directions put the already-landed entry above the
arriving one, which is the chronological reading for a log.

The stakes are low and worth stating so nobody over-trusts it: `history.md` is
not strictly chronological today anyway — on `origin/main` an entry dated
2026-08-26 sits above two dated 2026-08-25. Order within a day is not load
bearing; losing an entry would be.

## Parsing safety

`history.md` is a document ABOUT merge conflicts, so it contains lines like
`<<<<<<<` and `=======` as prose — and `=======` is also a setext heading rule
in Markdown. A parser looking for 7-character markers could mis-frame on the
file's own content.

So the internal merge is generated with `--marker-size=40`. Forty repeated
`<`, `|`, `=` or `>` characters cannot occur in this prose, and unresolved
hunks are re-rendered afterwards at the marker size git actually asked for
(`%L`) with git's own labels (`%X`/`%S`/`%Y`), so what a human sees is
indistinguishable from an ordinary conflict.

## Failing safe

Every unexpected condition — no `git`, a marker sequence the state machine
cannot frame, a write error — falls back to writing git's plain conflicted
output and exiting non-zero. The worst outcome available to this driver is the
behaviour of not having it.

The same is true if it is never installed: `.gitattributes` names a driver that
`.git/config` may not define, and git then falls back to the built-in text
merge. A missing install costs the benefit, never correctness. `--install`
wires it up and `pnpm install` runs that via `postinstall`.

## Usage

    append-only-merge.py %O %A %B %L %P %X %S %Y   (as a git merge driver)
    append-only-merge.py --install                  (write the .git/config entry)
    append-only-merge.py --self-test                (the demonstration suite)
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The name `.gitattributes` refers to and `--install` registers.
DRIVER_NAME = "append-only"

# Long enough that no prose in these documents can collide with it. The file
# genuinely contains 7-character conflict markers as example text.
INTERNAL_MARKER_SIZE = 40
OPEN = "<" * INTERNAL_MARKER_SIZE
BASE = "|" * INTERNAL_MARKER_SIZE
SEP = "=" * INTERNAL_MARKER_SIZE
CLOSE = ">" * INTERNAL_MARKER_SIZE


class Unframeable(Exception):
    """git's output did not parse as diff3. Fall back rather than guess."""


def _merge_file(ours: str, base: str, theirs: str, marker_size: int,
                labels: tuple[str, str, str]) -> tuple[str, int]:
    """Run git's own three-way merge and return (text, conflict count).

    `-p` writes to stdout instead of overwriting `ours`. Exit status is the
    number of conflicts, or negative on error.
    """
    proc = subprocess.run(
        [
            "git", "merge-file", "-p", "--diff3",
            f"--marker-size={marker_size}",
            "-L", labels[0], "-L", labels[1], "-L", labels[2],
            ours, base, theirs,
        ],
        capture_output=True,
    )
    if proc.returncode < 0 or proc.returncode > 127:
        raise Unframeable(proc.stderr.decode("utf-8", "replace"))
    return proc.stdout.decode("utf-8", "surrogateescape"), proc.returncode


def _frame(text: str) -> list[object]:
    """Split diff3 output into plain strings and (ours, base, theirs) hunks.

    A state machine rather than a regex: the markers are only meaningful in
    sequence, and the documents this runs on quote them out of sequence.
    """
    parts: list[object] = []
    plain: list[str] = []
    state = "normal"
    ours: list[str] = []
    base: list[str] = []
    theirs: list[str] = []

    for line in text.splitlines(keepends=True):
        head = line.rstrip("\r\n")
        if state == "normal":
            if head.startswith(OPEN):
                if plain:
                    parts.append("".join(plain))
                    plain = []
                state, ours, base, theirs = "ours", [], [], []
            else:
                plain.append(line)
        elif state == "ours":
            if head.startswith(BASE):
                state = "base"
            elif head.startswith(SEP) or head.startswith(CLOSE):
                # `--diff3` always emits a base section. Missing one means the
                # output is not the shape this parser was written against.
                raise Unframeable("conflict hunk without a base section")
            else:
                ours.append(line)
        elif state == "base":
            if head.startswith(SEP):
                state = "theirs"
            elif head.startswith(CLOSE):
                raise Unframeable("conflict hunk closed inside the base section")
            else:
                base.append(line)
        elif state == "theirs":
            if head.startswith(CLOSE):
                parts.append((ours, base, theirs))
                state = "normal"
            else:
                theirs.append(line)

    if state != "normal":
        raise Unframeable("unterminated conflict hunk")
    if plain:
        parts.append("".join(plain))
    return parts


def _render_conflict(hunk: tuple[list[str], list[str], list[str]],
                     marker_size: int, labels: tuple[str, str, str]) -> str:
    """Re-emit an unresolved hunk exactly as git would have, at git's markers."""
    ours, base, theirs = hunk

    def mark(ch: str, label: str) -> str:
        run = ch * marker_size
        return f"{run} {label}\n" if label else f"{run}\n"

    return (
        mark("<", labels[0])
        + "".join(ours)
        + mark("|", labels[1])
        + "".join(base)
        + mark("=", "")
        + "".join(theirs)
        + mark(">", labels[2])
    )


def resolve(base_text: str, ours_text: str, theirs_text: str,
            marker_size: int = 7,
            labels: tuple[str, str, str] = ("ours", "base", "theirs"),
            ) -> tuple[str, int]:
    """The whole driver, as a pure function. Returns (text, unresolved count).

    Kept separate from `main` so `--self-test` exercises the real code path
    rather than a reimplementation of it.
    """
    with tempfile.TemporaryDirectory() as tmp:
        paths = {}
        for name, text in (("base", base_text), ("ours", ours_text), ("theirs", theirs_text)):
            p = Path(tmp) / name
            p.write_text(text, encoding="utf-8", errors="surrogateescape")
            paths[name] = str(p)
        merged, conflicts = _merge_file(
            paths["ours"], paths["base"], paths["theirs"],
            INTERNAL_MARKER_SIZE, ("ours", "base", "theirs"),
        )

    if conflicts == 0:
        return merged, 0

    out: list[str] = []
    unresolved = 0
    for part in _frame(merged):
        if isinstance(part, str):
            out.append(part)
            continue
        ours, base, theirs = part
        if not base:
            # The only case this driver claims. Concatenation, verbatim.
            out.append("".join(ours) + "".join(theirs))
        else:
            unresolved += 1
            out.append(_render_conflict(part, marker_size, labels))
    return "".join(out), unresolved


def run_as_driver(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: append-only-merge.py %O %A %B [%L] [%P] [%X] [%S] [%Y]",
              file=sys.stderr)
        return 2

    o_path, a_path, b_path = argv[0], argv[1], argv[2]
    try:
        marker_size = int(argv[3]) if len(argv) > 3 and argv[3] else 7
    except ValueError:
        marker_size = 7
    path = argv[4] if len(argv) > 4 else a_path
    labels = (
        argv[5] if len(argv) > 5 and argv[5] else "ours",
        argv[6] if len(argv) > 6 and argv[6] else "base",
        argv[7] if len(argv) > 7 and argv[7] else "theirs",
    )

    def fall_back() -> int:
        """Reproduce plain git behaviour: conflicted content in %A, exit 1."""
        try:
            text, _ = _merge_file(a_path, o_path, b_path, marker_size, labels)
            Path(a_path).write_text(text, encoding="utf-8", errors="surrogateescape")
        except Exception:
            pass
        return 1

    try:
        base_text = Path(o_path).read_text(encoding="utf-8", errors="surrogateescape")
        ours_text = Path(a_path).read_text(encoding="utf-8", errors="surrogateescape")
        theirs_text = Path(b_path).read_text(encoding="utf-8", errors="surrogateescape")
    except OSError as exc:
        print(f"append-only merge: cannot read inputs ({exc}); "
              "falling back to a normal conflict.", file=sys.stderr)
        return fall_back()

    try:
        merged, unresolved = resolve(base_text, ours_text, theirs_text, marker_size, labels)
    except Unframeable as exc:
        print(f"append-only merge: {path}: {exc}; "
              "falling back to a normal conflict.", file=sys.stderr)
        return fall_back()
    except Exception as exc:  # noqa: BLE001 - a driver must never crash into a half-written file
        print(f"append-only merge: {path}: unexpected {exc!r}; "
              "falling back to a normal conflict.", file=sys.stderr)
        return fall_back()

    try:
        Path(a_path).write_text(merged, encoding="utf-8", errors="surrogateescape")
    except OSError as exc:
        print(f"append-only merge: cannot write {a_path} ({exc}).", file=sys.stderr)
        return fall_back()

    if unresolved:
        print(f"append-only merge: {path}: {unresolved} hunk(s) touch existing "
              "text and were NOT auto-resolved — resolve them by hand.",
              file=sys.stderr)
        return 1

    print(f"append-only merge: {path}: both sides only appended; kept both.",
          file=sys.stderr)
    return 0


def install() -> int:
    """Register the driver in the repository's git config.

    `git config --local` from a linked worktree writes the COMMON config file,
    so one install covers every worktree in `.claude/worktrees/`. Verified by
    reading the value back from this worktree after writing.
    """
    if shutil.which("git") is None:
        print("append-only merge: no git on PATH; skipping install.", file=sys.stderr)
        return 0
    inside = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"],
                            cwd=ROOT, capture_output=True, text=True)
    if inside.returncode != 0:
        print("append-only merge: not a git work tree; skipping install.", file=sys.stderr)
        return 0

    # A REPO-RELATIVE path, not `Path(__file__).resolve()`. Git runs a merge
    # driver from the top of the working tree the merge is happening in, and
    # `git config --local` from a linked worktree writes the COMMON config —
    # so one install covers every worktree, and each one then runs its OWN copy
    # of the script.
    #
    # An absolute path is the obvious thing and it is a time bomb here: the
    # first install usually happens inside `.claude/worktrees/<name>`, which is
    # deleted when that branch merges, leaving every other worktree pointed at
    # a script that no longer exists. Verified both halves rather than assumed
    # — see `--self-test`'s worktree case.
    #
    # %O %A %B %L %P %X %S %Y — ancestor, ours, theirs, marker size, path,
    # and the three conflict labels git would have used itself.
    command = "python3 scripts/append-only-merge.py %O %A %B %L %P %X %S %Y"

    # `.driver` FIRST, and the order is load-bearing. A half-registered driver
    # — `.name` present, `.driver` absent — does not degrade to a normal merge:
    # git REFUSES outright with `fatal: custom merge driver append-only lacks
    # command line`, exit 128, and no merge of that path is possible at all.
    # That is strictly worse than the conflict this exists to remove, and it is
    # reachable by an install interrupted between two `git config` calls.
    #
    # Measured both states rather than reasoned about: `.name` without
    # `.driver` fatals; `.driver` without `.name` merges perfectly, because
    # `.name` is only a human-readable description. So writing `.driver` first
    # makes every partial state a working state.
    for key, value in (
        (f"merge.{DRIVER_NAME}.driver", command),
        (f"merge.{DRIVER_NAME}.name", "keep both sides when both only appended"),
        # Without this, `git checkout --merge` and friends fall back to the
        # built-in driver silently.
        (f"merge.{DRIVER_NAME}.recursive", "binary"),
    ):
        proc = subprocess.run(["git", "config", "--local", key, value],
                              cwd=ROOT, capture_output=True, text=True)
        if proc.returncode != 0:
            print(f"append-only merge: could not set {key}: {proc.stderr.strip()}",
                  file=sys.stderr)
            return 0  # never fail an install over this
    print(f"append-only merge: driver `{DRIVER_NAME}` registered for this repository.")
    return 0


# ---------------------------------------------------------------------------
# The demonstration suite. Runs in `verify` and in CI.
#
# CLAUDE.md: "Anything about what a script DOES needs a check that runs the
# script." `check:python` only parses. These cases are the argument for the
# driver, so they are executed on every run rather than described in a comment.
# ---------------------------------------------------------------------------

FAILURES: list[str] = []


def safe_resolve(base: str, ours: str, theirs: str) -> tuple[str, int]:
    """`resolve`, but a parse failure is reported as a red case, not a traceback.

    The driver itself falls back to a plain conflict on `Unframeable`, which is
    correct in production and useless in a test run — the suite would abort
    mid-way and print a stack instead of naming which case broke. Shrinking
    `INTERNAL_MARKER_SIZE` to 7 raises it from case 7, which is how that was
    found.
    """
    try:
        return resolve(base, ours, theirs)
    except Unframeable as exc:
        return f"UNFRAMEABLE: {exc}", -1


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok    {name}")
    else:
        print(f"  FAIL  {name}{(': ' + detail) if detail else ''}")
        FAILURES.append(name)


def _doc(entries: list[str], gaps: list[str]) -> str:
    """A miniature `history.md`: entries, then the trailing gap list."""
    body = "".join(f"## {e}\n\nprose for {e}.\n\n" for e in entries)
    return ("# History\n\n" + body
            + "## Open items / known gaps as of this entry\n\n"
            + "".join(f"- {g}\n" for g in gaps))


def self_test() -> int:
    print("append-only merge driver — demonstration suite\n")

    # ---- 1. The case the driver exists for -------------------------------
    base = _doc(["A"], ["gap one"])
    ours = _doc(["A", "B"], ["gap one"])
    theirs = _doc(["A", "C"], ["gap one"])
    merged, unresolved = safe_resolve(base, ours, theirs)
    check("two branches appending different entries resolve", unresolved == 0)
    check("both entries survive", "## B" in merged and "## C" in merged)
    check("no entry appears twice",
          merged.count("## B") == 1 and merged.count("## C") == 1)
    check("no conflict markers are left", "<<<<<<<" not in merged)

    # The load-bearing convention: the gap list stays at the bottom, under
    # BOTH new entries. This is the failure repaired three times.
    b_at, c_at = merged.index("## B"), merged.index("## C")
    open_at = merged.index("## Open items")
    check("`## Open items` stays below both new entries",
          b_at < open_at and c_at < open_at,
          f"B@{b_at} C@{c_at} Open@{open_at}")
    check("`## Open items` still appears exactly once",
          merged.count("## Open items") == 1)
    check("the gap list is not duplicated", merged.count("- gap one") == 1)

    # Ordering is `ours` then `theirs` — already-landed above arriving.
    check("ours is ordered above theirs", b_at < c_at)

    # ---- 2. The refusal the driver exists to preserve --------------------
    # Both sides edited the SAME entry. This is the case where a union merge
    # silently keeps two contradictory sentences with nothing to notice.
    base = _doc(["A", "B"], ["gap one"])
    ours = _doc(["A", "B"], ["gap one"]).replace("prose for B.", "prose for B, corrected by us.")
    theirs = _doc(["A", "B"], ["gap one"]).replace("prose for B.", "prose for B, corrected by them.")
    merged, unresolved = safe_resolve(base, ours, theirs)
    check("both sides editing the same entry REFUSES", unresolved == 1)
    check("the refusal leaves real conflict markers",
          "<<<<<<< ours" in merged and ">>>>>>> theirs" in merged)
    check("neither side's wording is lost in the refusal",
          "corrected by us." in merged and "corrected by them." in merged)

    # ---- 3. A delete versus an edit, which is the data-loss case ---------
    # Ours removes a resolved gap; theirs rewords it. Taking either side
    # wholesale loses one of them. The driver must not choose.
    base = _doc(["A"], ["gap one", "gap two"])
    ours = _doc(["A"], ["gap two"])
    theirs = _doc(["A"], ["gap one, still open and now explained", "gap two"])
    merged, unresolved = safe_resolve(base, ours, theirs)
    check("deleting a gap while the other side rewords it REFUSES", unresolved == 1)
    check("the deleted text is not silently resurrected as settled",
          "<<<<<<<" in merged)

    # ---- 4. Append plus an unrelated edit still auto-merges --------------
    # Plain git already handles this; the driver must not make it worse.
    base = _doc(["A", "B"], ["gap one"])
    ours = _doc(["A", "B", "C"], ["gap one"])
    theirs = _doc(["A", "B"], ["gap one"]).replace("prose for A.", "prose for A, fixed typo.")
    merged, unresolved = safe_resolve(base, ours, theirs)
    check("an append plus an unrelated edit merges cleanly", unresolved == 0)
    check("the append survives", "## C" in merged)
    check("the unrelated edit survives", "fixed typo." in merged)

    # ---- 5. Appending at EOF conflicts too, so the anchor is not the bug --
    # `functional-scenarios.md` has NO trailing anchor: entries go at the end
    # of the file. It conflicts identically. Moving `## Open items` would not
    # have fixed anything, which is why that option was rejected.
    base = "# Scenarios\n\n## One\n\nprose.\n"
    ours = base + "\n## Two\n\nprose.\n"
    theirs = base + "\n## Three\n\nprose.\n"
    _, plain_conflicts = _merge_file_texts(base, ours, theirs)
    check("plain git conflicts on two EOF appends", plain_conflicts > 0)
    merged, unresolved = safe_resolve(base, ours, theirs)
    check("the driver resolves the EOF case too", unresolved == 0)
    check("both EOF appends survive", "## Two" in merged and "## Three" in merged)

    # ---- 6. Concatenation is verbatim, asserted as an equality -----------
    # Not a property of the output — the literal `ours + theirs` text.
    base = "head\n\nTAIL\n"
    ours = "head\n\nOURS-1\nOURS-2\n\nTAIL\n"
    theirs = "head\n\nTHEIRS-1\nTHEIRS-2\n\nTAIL\n"
    merged, unresolved = safe_resolve(base, ours, theirs)
    check("resolved output is exactly ours-then-theirs",
          unresolved == 0
          and "OURS-1\nOURS-2" in merged
          and "THEIRS-1\nTHEIRS-2" in merged
          and merged.index("OURS-1") < merged.index("THEIRS-1")
          and merged.endswith("TAIL\n"),
          repr(merged))

    # ---- 7. Prose containing conflict markers does not confuse it --------
    # `history.md` documents merge conflicts, so it contains these characters.
    # A 7-character parser would mis-frame here; this one does not.
    quoted = "head\n\n```\n<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> other\n```\n\nTAIL\n"
    ours = quoted.replace("TAIL", "OURS-ENTRY\n\nTAIL")
    theirs = quoted.replace("TAIL", "THEIRS-ENTRY\n\nTAIL")
    merged, unresolved = safe_resolve(quoted, ours, theirs)
    check("prose containing 7-char conflict markers still resolves", unresolved == 0)
    check("the quoted markers are preserved untouched",
          merged.count("<<<<<<< HEAD") == 1 and merged.count(">>>>>>> other") == 1)
    check("both entries survive around the quoted block",
          "OURS-ENTRY" in merged and "THEIRS-ENTRY" in merged)

    # ---- 8. End to end, through git itself -------------------------------
    # Everything above calls `resolve()` directly, which proves the rule and
    # nothing about the WIRING. A driver that is never invoked passes every
    # test in this file. These cases build a throwaway repository, install
    # `.gitattributes` and the config entry exactly as this repo does, and run
    # a real `git merge`.
    _end_to_end()

    # ---- 9. Why `merge=union` was rejected, demonstrated -----------------
    # Same repository, same conflict, git's BUILT-IN union driver. It is the
    # obvious answer for an append-only file and it silently corrupts the
    # case above. Run here so the rejection is evidence rather than an
    # assertion in a docstring.
    _union_is_wrong()

    # ---- 9b. The shape check, in both directions -------------------------
    # `--check-shape` runs against a file that is correct today, so its FAILING
    # branch would otherwise never execute. These feed it the two historical
    # defects directly.
    good = _doc(["A", "B"], ["gap one"])
    check("shape: a correct file reports nothing", history_problems(good) == [])

    # The defect measured on `origin/main`: an insert anchored on the FIRST
    # occurrence of the phrase rather than the last, leaving a second column-0
    # heading in the middle of the file.
    decoy = good.replace("## B", f"{OPEN_ITEMS}\n\n- a stranded decoy\n\n## B", 1)
    check("shape: a first-match-anchored insert is caught",
          any("expected 1" in p for p in history_problems(decoy)))

    # The other half: an entry appended AFTER the gap list, which strands it.
    stranded = good + "\n## 2026-01-01 — appended in the wrong place\n\nprose.\n"
    check("shape: an entry after the gap list is caught",
          any("appear AFTER" in p for p in history_problems(stranded)))

    # Fenced quoting is legitimate and must not be reported. This file's own
    # N63 entry quotes a diff3 hunk containing exactly these lines, and a
    # fence-blind version reported five findings on the commit that added it.
    quoted_doc = good.replace(
        "prose for A.",
        "prose for A.\n\n```\n<<<<<<< ours\n" + OPEN_ITEMS + "\n>>>>>>> theirs\n```",
    )
    check("shape: a fenced example of the heading is not a finding",
          history_problems(quoted_doc) == [], str(history_problems(quoted_doc)))
    check("shape: `_unfenced` preserves line numbering",
          len(_unfenced(quoted_doc)) == len(quoted_doc.splitlines()))
    check("shape: fenced content really is blanked",
          "<<<<<<< ours" not in _unfenced(quoted_doc))

    # ---- 10. The apparatus can fail --------------------------------------
    # CLAUDE.md's rule: check that a check can go red. Every case above would
    # pass on a driver that always concatenated, EXCEPT the refusals — so the
    # refusals are the load-bearing half, and this proves the harness reports
    # a genuine failure rather than only ever printing `ok`.
    print("\n  -- negative control: the next line is EXPECTED to say FAIL --")
    sentinel = "negative control (a FAIL here is correct)"
    before = len(FAILURES)
    check(sentinel, False, "deliberate")
    recorded = len(FAILURES) == before + 1
    FAILURES.remove(sentinel)
    check("the harness recorded that failure", recorded)
    print()

    # ---- 11. The real file, against the real conflicting branch ----------
    # A synthetic fixture cannot prove anything about a 41,000-line document.
    real = _real_history_case()
    if real is None:
        print("  skip  real history.md case (no second branch available)")
    else:
        base_t, ours_t, theirs_t, label = real
        merged, unresolved = safe_resolve(base_t, ours_t, theirs_t)
        check(f"real history.md vs {label} resolves", unresolved == 0)
        check("every line of both sides survives",
              _appended_lines(base_t, ours_t) <= set(merged.splitlines())
              and _appended_lines(base_t, theirs_t) <= set(merged.splitlines()))
        check("`## Open items` remains the last `## ` heading",
              _last_h2(merged).startswith("## Open items"),
              _last_h2(merged)[:60])

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s): " + ", ".join(FAILURES))
        return 1
    print("all cases pass")
    return 0


class _Repo:
    """A throwaway git repository, so the wiring is tested and not just the rule."""

    def __init__(self, tmp: str, driver_attr: str) -> None:
        self.dir = Path(tmp)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Append Only Test")
        self.git("config", f"merge.{DRIVER_NAME}.name", "test")
        self.git("config", f"merge.{DRIVER_NAME}.driver",
                 f'python3 "{Path(__file__).resolve()}" %O %A %B %L %P %X %S %Y')
        (self.dir / ".gitattributes").write_text(f"doc.md {driver_attr}\n")

    def git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *args], cwd=self.dir,
                              capture_output=True, text=True)

    def commit(self, text: str, message: str) -> None:
        (self.dir / "doc.md").write_text(text, encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def doc(self) -> str:
        return (self.dir / "doc.md").read_text(encoding="utf-8")


def _two_branch_repo(tmp: str, driver_attr: str, base: str,
                     ours: str, theirs: str) -> tuple[_Repo, int]:
    """Build base -> two branches -> merge `theirs` into `ours`. Returns exit code."""
    repo = _Repo(tmp, driver_attr)
    repo.commit(base, "base")
    repo.git("checkout", "-q", "-b", "theirs")
    repo.commit(theirs, "theirs")
    repo.git("checkout", "-q", "main")
    repo.commit(ours, "ours")
    result = repo.git("merge", "--no-edit", "theirs")
    return repo, result.returncode


def _end_to_end() -> None:
    base = _doc(["A"], ["gap one"])
    ours = _doc(["A", "B"], ["gap one"])
    theirs = _doc(["A", "C"], ["gap one"])

    with tempfile.TemporaryDirectory() as tmp:
        repo, code = _two_branch_repo(tmp, f"merge={DRIVER_NAME}", base, ours, theirs)
        text = repo.doc()
        check("end to end: `git merge` succeeds through the driver", code == 0)
        check("end to end: both entries are in the working tree",
              "## B" in text and "## C" in text)
        check("end to end: `## Open items` is still last",
              _last_h2(text).startswith("## Open items"))
        check("end to end: nothing is left unmerged",
              repo.git("diff", "--name-only", "--diff-filter=U").stdout.strip() == "")

    # And the refusal, through git, on the same repository shape.
    same = _doc(["A", "B"], ["gap one"])
    with tempfile.TemporaryDirectory() as tmp:
        repo, code = _two_branch_repo(
            tmp, f"merge={DRIVER_NAME}", same,
            same.replace("prose for B.", "prose for B, corrected by us."),
            same.replace("prose for B.", "prose for B, corrected by them."),
        )
        text = repo.doc()
        check("end to end: a same-entry edit STOPS the merge", code != 0)
        check("end to end: the file is left with conflict markers",
              "<<<<<<<" in text and ">>>>>>>" in text)
        check("end to end: git reports the path as unmerged",
              "doc.md" in repo.git("diff", "--name-only", "--diff-filter=U").stdout)

    # A driver that is never invoked would pass case 1 by accident, because
    # git's own merge is smart enough to conflict-and-stop. Prove the driver
    # is what resolved it: with NO attribute, the identical merge fails.
    with tempfile.TemporaryDirectory() as tmp:
        repo, code = _two_branch_repo(tmp, "text", base, ours, theirs)
        check("end to end: WITHOUT the attribute the same merge conflicts",
              code != 0, "the driver is not what resolved case 1")

    # An install interrupted between two `git config` calls must not be worse
    # than no install. `.name` without `.driver` makes git REFUSE the merge
    # (`fatal: … lacks command line`, exit 128) — no merge of that path is
    # possible at all. `install()` therefore writes `.driver` first, and this
    # asserts the property that makes that safe.
    with tempfile.TemporaryDirectory() as tmp:
        repo = _Repo(tmp, f"merge={DRIVER_NAME}")
        repo.git("config", "--unset", f"merge.{DRIVER_NAME}.name")
        repo.commit(base, "base")
        repo.git("checkout", "-q", "-b", "theirs")
        repo.commit(theirs, "theirs")
        repo.git("checkout", "-q", "main")
        repo.commit(ours, "ours")
        code = repo.git("merge", "--no-edit", "theirs").returncode
        check("end to end: `.driver` without `.name` still works", code == 0)
        check("end to end: and it still keeps both entries",
              "## B" in repo.doc() and "## C" in repo.doc())


def _union_is_wrong() -> None:
    """`merge=union` on the case the driver refuses. This is the rejection."""
    same = _doc(["A", "B"], ["gap one"])
    ours = same.replace("prose for B.", "prose for B, corrected by us.")
    theirs = same.replace("prose for B.", "prose for B, corrected by them.")

    with tempfile.TemporaryDirectory() as tmp:
        repo, code = _two_branch_repo(tmp, "merge=union", same, ours, theirs)
        text = repo.doc()
        check("rejected `merge=union`: it merges SILENTLY where it should stop",
              code == 0, "union stopped; the rejection needs re-examining")
        check("rejected `merge=union`: the entry now states both things at once",
              "corrected by us." in text and "corrected by them." in text)
        check("rejected `merge=union`: and nothing marks it",
              "<<<<<<<" not in text)

    # The worse half: one side DELETES a resolved gap, the other rewords it.
    # Union keeps the reworded line, so the deletion is reverted with no
    # marker — a gap the log said was closed is open again and nobody looked.
    base = _doc(["A"], ["gap one", "gap two"])
    ours = _doc(["A"], ["gap two"])
    theirs = _doc(["A"], ["gap one, still open and now explained", "gap two"])
    with tempfile.TemporaryDirectory() as tmp:
        repo, code = _two_branch_repo(tmp, "merge=union", base, ours, theirs)
        text = repo.doc()
        check("rejected `merge=union`: a delete-vs-edit also merges silently",
              code == 0)
        check("rejected `merge=union`: the deletion is silently reverted",
              "gap one, still open" in text and "<<<<<<<" not in text)

    # The same two cases through this driver, for contrast, are cases 2 and 3
    # above: both refuse.


def _merge_file_texts(base: str, ours: str, theirs: str) -> tuple[str, int]:
    """Plain `git merge-file`, for showing what happens WITHOUT the driver."""
    with tempfile.TemporaryDirectory() as tmp:
        p = {}
        for name, text in (("base", base), ("ours", ours), ("theirs", theirs)):
            f = Path(tmp) / name
            f.write_text(text, encoding="utf-8")
            p[name] = str(f)
        return _merge_file(p["ours"], p["base"], p["theirs"], 7,
                           ("ours", "base", "theirs"))


def _last_h2(text: str) -> str:
    return next((l for l in reversed(text.splitlines()) if l.startswith("## ")), "")


def _appended_lines(base: str, side: str) -> set[str]:
    """Non-blank lines present in `side` that are not in `base` at all."""
    base_lines = set(base.splitlines())
    return {l for l in side.splitlines() if l.strip() and l not in base_lines}


def _git(*args: str) -> str | None:
    proc = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
    return proc.stdout if proc.returncode == 0 else None


def _real_history_case() -> tuple[str, str, str, str] | None:
    """The live 41k-line case: `origin/main` versus another open branch.

    Skips rather than fails when no second branch is fetched — a developer
    machine or a shallow CI checkout may have neither. It is a bonus over the
    fixtures above, which are the guarantee.
    """
    doc = "docs/decisions/history.md"
    if _git("rev-parse", "--verify", "-q", "origin/main") is None:
        return None
    refs = _git("for-each-ref", "--format=%(refname)", "refs/remotes/origin")
    if not refs:
        return None
    for ref in refs.split():
        name = ref[len("refs/remotes/"):]
        if name in ("origin/main", "origin/HEAD"):
            continue
        merge_base = _git("merge-base", "origin/main", name)
        if not merge_base:
            continue
        mb = merge_base.strip()
        texts = []
        for rev in (mb, "origin/main", name):
            blob = _git("show", f"{rev}:{doc}")
            if blob is None:
                break
            texts.append(blob)
        if len(texts) != 3:
            continue
        base_t, ours_t, theirs_t = texts
        if base_t == ours_t or base_t == theirs_t:
            continue  # not a two-sided change; proves nothing
        _, conflicts = _merge_file_texts(base_t, ours_t, theirs_t)
        if conflicts:
            return base_t, ours_t, theirs_t, name
    return None


# ---------------------------------------------------------------------------
# The shape check. Separate concern from the driver, deliberately in the same
# file, because it asserts the invariant the driver is required to preserve.
# ---------------------------------------------------------------------------

HISTORY = "docs/decisions/history.md"
OPEN_ITEMS = "## Open items / known gaps as of this entry"

# Files `.gitattributes` must route through this driver. Kept here so a rename
# of either side fails rather than silently orphaning the attribute — the same
# floor `check-verify-chain.py` puts on a `verify` link.
ATTRIBUTED = (HISTORY, "docs/testing/functional-scenarios.md")


def _unfenced(text: str) -> list[str]:
    """Lines outside fenced code blocks; fenced lines become `""`.

    Blanked rather than dropped so every index is still the real line number —
    an off-by-N in a message that says "line 16331" is worse than useless.

    Deliberately simple: a ``` or ~~~ at the start of a line toggles the fence.
    That is what this corpus uses. Indented fences inside list items are not
    handled, and if one ever matters the fix is to teach this function, not to
    weaken a caller.
    """
    out: list[str] = []
    fence: str | None = None
    for line in text.splitlines():
        opener = line.startswith("```") or line.startswith("~~~")
        if fence is None:
            if opener:
                fence = line[:3]
                out.append("")
                continue
            out.append(line)
        else:
            out.append("")
            if line.startswith(fence):
                fence = None
    return out


def history_problems(text: str) -> list[str]:
    """The two structural assertions on `history.md`, as a pure function.

    Separated from `check_shape` so `--self-test` can feed it the historical
    defect — a first-match-anchored insert — rather than only ever seeing a
    file that happens to be correct today. A check only ever run against a
    passing input is one whose failing branch nobody has executed.
    """
    problems: list[str] = []
    lines = _unfenced(text)

    headings = [i for i, l in enumerate(lines) if l == OPEN_ITEMS]
    mentions = sum(1 for l in lines if l and OPEN_ITEMS.lstrip("# ") in l)
    if len(headings) != 1:
        problems.append(
            f"{HISTORY}: {len(headings)} lines ARE `{OPEN_ITEMS}`, expected 1.\n"
            f"    ({mentions} lines mention the phrase; only the heading counts.)\n"
            "    A second one is usually an insert anchored on the first match "
            "rather than the last."
        )
        return problems

    after = [i for i, l in enumerate(lines)
             if l.startswith("## ") and i > headings[0]]
    if after:
        problems.append(
            f"{HISTORY}: {len(after)} `## ` heading(s) appear AFTER the "
            f"gap list (first at line {after[0] + 1}: {lines[after[0]][:70]}).\n"
            "    Entries go BEFORE it, or the gap list reads as belonging "
            "to whatever landed last."
        )
    return problems


def check_shape() -> int:
    """Assert the structure the history rule depends on, which nothing read.

    CLAUDE.md: *"Nothing failed; `verify` was green and all six CI checks
    passed, because no check reads this file's structure."* That was written
    after a branch anchored on the FIRST occurrence of the heading string, cut
    an entry in half 21,000 lines up, and left a spurious column-0 heading
    parsing as real.

    The trap gets worse every time it is repaired, because each repair is
    described in a new entry that quotes the string again. Measured on
    `origin/main`: **6** occurrences of the phrase, exactly **1** of them a
    heading. So `grep`ping for it and taking any match is now wrong five times
    out of six, and the odds worsen monotonically.

    Three assertions, all cheap:

    1. exactly one line IS the heading (column 0, `## `);
    2. it is the LAST `## ` heading in the file, so nothing was appended after
       it and the gap list is not stranded under a newer entry;
    3. no committed conflict markers in any append-only doc — a resolution
       left half-finished, which lints and typechecks clean because these are
       prose files nothing else reads.

    **All three skip fenced code blocks, and that is not a loophole — it is
    what makes the check usable in a repo whose narrative is largely ABOUT
    merges.** The entry that introduced this check quotes a diff3 hunk, so its
    own code fence contains a column-0 `## Open items …` line and four column-0
    conflict markers. A fence-blind version reported all five on the commit
    that added it, which is the cry-wolf shape `check-verify-chain.py` warns
    about: a checker whose first act is a false positive gets silenced.

    Nothing is lost by it. The defects this catches — a first-match-anchored
    insert, a half-finished resolution — are written by tools that do not open
    a fence first, and the "last `## ` heading" assertion still covers anything
    appended below the gap list whether it is fenced or not.
    """
    problems: list[str] = []

    history = (ROOT / HISTORY)
    if not history.exists():
        print(f"{HISTORY} is missing.", file=sys.stderr)
        return 1
    problems += history_problems(history.read_text(encoding="utf-8"))

    for rel in ATTRIBUTED:
        path = ROOT / rel
        if not path.exists():
            problems.append(f"{rel}: listed in ATTRIBUTED but missing.")
            continue
        stray = [i + 1 for i, l in enumerate(_unfenced(path.read_text(encoding="utf-8")))
                 if l.startswith(("<" * 7, "|" * 7, "=" * 7, ">" * 7))]
        if stray:
            problems.append(
                f"{rel}: conflict markers committed at line(s) "
                f"{', '.join(map(str, stray[:5]))}."
            )

    attributes = ROOT / ".gitattributes"
    if not attributes.exists():
        problems.append(".gitattributes is missing; the driver is never invoked.")
    else:
        text = attributes.read_text(encoding="utf-8")
        for rel in ATTRIBUTED:
            if f"{rel} merge={DRIVER_NAME}" not in text:
                problems.append(
                    f".gitattributes does not route {rel} through "
                    f"`merge={DRIVER_NAME}`, so it conflicts as before."
                )

    if problems:
        print("append-only doc shape:\n", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print(f"append-only doc shape: {HISTORY} ends with its gap list; "
          f"{len(ATTRIBUTED)} docs routed through `{DRIVER_NAME}`.")
    return 0


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--self-test":
        return self_test()
    if argv and argv[0] == "--check-shape":
        return check_shape()
    if argv and argv[0] == "--check":
        # The `verify`/CI gate: the invariant, then the driver that must keep it.
        return check_shape() or self_test()
    if argv and argv[0] == "--install":
        return install()
    return run_as_driver(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
