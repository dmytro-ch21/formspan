#!/usr/bin/env python3
"""Fail on a migration-version defect golang-migrate itself will not report.

Part of N149 (#553): sequential migration numbering is collision-prone under
parallel AI workers, so `backend/migrations/` moved from
`NNNNNN_description.{up,down}.sql` (a shared counter every branch increments
independently) to `YYYYMMDDHHMMSS_description.{up,down}.sql` (each agent's own
clock, no coordination needed). See CLAUDE.md's "Git / PR workflow" section
and `docs/decisions/history.md`'s N149 entry for the full reasoning. This
script is the CI-side half of that ticket's acceptance criteria: it asserts,
mechanically, the three properties the new (and old) numbering still depends
on.

## What it checks, and why each one is real

1. **Every migration has an up/down pair.** golang-migrate pairs files by
   version number, taken from the filename, not by name — parsed with the
   SAME regex golang-migrate's own `source/parse.go` uses internally
   (`^([0-9]+)_(.*)\\.(up|down)\\.(.*)$`, mirrored below as MIGRATION_RE). A
   `.up.sql` with no matching `.down.sql` breaks `migrate down` the first time
   anyone needs it, silently, until that moment.

2. **No two migrations claim the same version number.** `migrate.New` refuses
   to even start when two files parse to the same version — but that refusal
   happens at RUNTIME, against whatever `MIGRATIONS_PATH` points at, which
   this repo's CI never does today (the `backend` job runs `go run
   ./cmd/migrate up` against a throwaway database, but nothing runs it against
   a merged, multi-branch view of `backend/migrations/`). Two PRs each adding
   a distinct migration can each look fine individually and still collide the
   moment both land — CLAUDE.md's own account of the `000043` incident is
   exactly this, for the OLD sequential scheme. The new timestamp scheme
   makes an accidental collision between two independently-generated versions
   astronomically unlikely (see the history.md entry for the arithmetic), but
   "unlikely" is not "impossible": two agents invoking `date -u
   +%Y%m%d%H%M%S` in the same wall-clock second produce an EXACT collision,
   with certainty, not probability. This check is what catches that, and
   catches an old-scheme collision on `backend/migrations/000043_*` just as
   well — the logic does not care which scheme a version came from.

3. **A migration new in this branch is versioned ABOVE everything at the
   merge base with `origin/main`.** This is the acceptance criterion asking
   for "a migration added by a PR is valid against the PR's merge base" and
   "the merge queue re-validates immediately before merge" — this repo has no
   merge queue (see CLAUDE.md's Git/PR workflow section; a plain `pull_request`
   CI job that reruns after every rebase is what stands in for one here, and
   the history.md entry argues explicitly why that already gives the
   property the ticket asks for). Read literally: golang-migrate applies only
   versions STRICTLY ABOVE the one recorded in `schema_migrations`, so a new
   migration numbered at or below whatever is already on `origin/main` is
   PRECISELY the "would be silently skipped" trap CLAUDE.md documents at
   length, just caught here — before merge — instead of days later as a
   `column "..." does not exist` error in production. The timestamp scheme
   makes this nearly unreachable by accident (a 14-digit "now" is always
   above a 6-digit historical version, and above any other 14-digit
   timestamp generated earlier), but a hand-typed version string can still
   get this wrong, which is exactly what this check exists to catch instead
   of golang-migrate's own runtime silence.

## What it does NOT do

It cannot see a collision or an ordering violation that only exists in the
MERGED tree of several still-open PRs, each individually fine against
`origin/main` — the same blind spot CLAUDE.md documents for
`git diff origin/main...HEAD` on the old scheme. Nothing running only on a
single PR's branch can see that; it is caught the moment the first of the
colliding PRs actually merges and the second one rebases onto it (a rebase
this repo's own workflow already forces before a conflicting PR can get any
CI runs at all — see "CI can run ZERO checks" in CLAUDE.md).

## Self-test

`--self-test` exercises all three checks against synthetic fixtures — the
pairing and duplicate checks need no git repo at all; the merge-base check
builds a REAL throwaway git repository (same technique as
`append-only-merge.py --self-test`) so the merge-base logic is exercised
against actual git plumbing rather than a mock of it. Wired into `verify`
ahead of the real check, matching `check-expo-native-config.py`'s
`--self-test && <real check>` chaining — self-test proves the logic can fail
before the real check is trusted to say it didn't.

The real check (no flags) needs a git repository with `origin/main`
reachable, which is exactly what the "Scripts (Python)" CI job's
`fetch-depth: 0` checkout plus its `git fetch --no-tags origin
main:refs/remotes/origin/main` step (added for `check-tasks-integrity.py`)
already provides — reused here rather than duplicated.
"""

import argparse
import re
import subprocess
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = ROOT / "backend" / "migrations"
UPSTREAM = "origin/main"
MIGRATIONS_REL = "backend/migrations"

# Mirrors golang-migrate's own source/parse.go Regex exactly (down to
# accepting any suffix after the direction, not just .sql) so a file this
# script would flag is a file golang-migrate itself would flag, and vice
# versa — this check must never be stricter, or looser, than the tool it is
# standing in for.
MIGRATION_RE = re.compile(r"^([0-9]+)_(.+)\.(up|down)\.(.+)$")

# golang-migrate's Version fields are Go `uint` (64-bit on every platform
# this repo builds for — amd64, arm64) and Postgres's schema_migrations
# stores it as `bigint` (signed 64-bit). A version that overflows either is
# not a real migration version; catch it here rather than as an obscure
# parse failure on `migrate up`.
MAX_VERSION = 2**64 - 1


class Migration:
    __slots__ = ("version", "stem", "direction", "path")

    def __init__(self, version: int, stem: str, direction: str, path: Path):
        self.version = version
        self.stem = stem
        self.direction = direction
        self.path = path


def parse_migrations(names: list[str], dir_for_path: Path | None = None) -> tuple[list[Migration], list[str]]:
    """Parse migration filenames. Returns (migrations, unparseable-names).

    `dir_for_path` is only used to build a display path; the parsing itself
    only ever looks at the filename, matching how golang-migrate itself
    reads a source directory.
    """
    migs: list[Migration] = []
    bad: list[str] = []
    for name in names:
        m = MIGRATION_RE.match(name)
        if not m:
            bad.append(name)
            continue
        digits, stem, direction, _ext = m.groups()
        version = int(digits)
        path = (dir_for_path / name) if dir_for_path else Path(name)
        migs.append(Migration(version, stem, direction, path))
    return migs, bad


def check_pairing(migs: list[Migration]) -> list[str]:
    """Every stem needs exactly one .up and one .down file, at the SAME version."""
    by_stem: dict[str, dict[str, Migration]] = {}
    for m in migs:
        by_stem.setdefault(m.stem, {})[m.direction] = m

    problems = []
    for stem, dirs in sorted(by_stem.items()):
        if "up" not in dirs:
            problems.append(f"{stem}: has .down.sql but no matching .up.sql")
        if "down" not in dirs:
            problems.append(f"{stem}: has .up.sql but no matching .down.sql")
        if "up" in dirs and "down" in dirs and dirs["up"].version != dirs["down"].version:
            problems.append(
                f"{stem}: .up.sql is version {dirs['up'].version} but .down.sql "
                f"is version {dirs['down'].version} — golang-migrate pairs by "
                "version number, not filename, so these are two DIFFERENT "
                "migrations to it despite sharing a name"
            )
    return problems


def check_duplicates(migs: list[Migration]) -> list[str]:
    """No two DISTINCT migrations (stems) may claim the same version number."""
    by_version: dict[int, set[str]] = {}
    for m in migs:
        by_version.setdefault(m.version, set()).add(m.stem)

    problems = []
    for version, stems in sorted(by_version.items()):
        if version > MAX_VERSION:
            problems.append(
                f"version {version} exceeds {MAX_VERSION} (max uint64 / Postgres "
                f"bigint) — golang-migrate cannot represent this version at all"
            )
        if len(stems) > 1:
            problems.append(
                f"version {version} is claimed by {len(stems)} different "
                f"migrations: {', '.join(sorted(stems))} — golang-migrate's "
                "migrate.New refuses to start against a source with a duplicate "
                "version, and if it somehow ran, only one of these would ever "
                "apply"
            )
    return problems


def git(*args: str, cwd: Path | None = None) -> str | None:
    try:
        return subprocess.run(
            ["git", *args], capture_output=True, text=True, check=True, cwd=cwd
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def git_lines(*args: str, cwd: Path | None = None) -> list[str] | None:
    out = git(*args, cwd=cwd)
    if out is None:
        return None
    return [line for line in out.splitlines() if line]


def check_new_migrations_above_merge_base(
    repo_root: Path, upstream: str = UPSTREAM, migrations_rel: str = MIGRATIONS_REL
) -> tuple[list[str], bool]:
    """Every migration file new in this branch must version-sort above every
    migration that already existed at the merge base with `upstream`.

    Returns (problems, ok_to_judge) — ok_to_judge is False when the merge base
    itself could not be established, which is a hard failure (see module
    docstring: "not a skip"), not a silent pass.
    """
    merge_base = git("merge-base", "HEAD", upstream, cwd=repo_root)
    if not merge_base:
        return (
            [
                f"cannot compute the merge base with {upstream}, so a new "
                "migration's version cannot be checked against it. Run `git "
                "fetch origin` (CI: the workflow must fetch the base branch with "
                "enough history) and try again."
            ],
            False,
        )

    base_names = git_lines(
        "ls-tree", "-r", "--name-only", merge_base, "--", migrations_rel, cwd=repo_root
    )
    if base_names is None:
        base_names = []
    base_names = [Path(n).name for n in base_names]

    here_names = sorted(p.name for p in (repo_root / migrations_rel).glob("*") if p.is_file())

    base_migs, _ = parse_migrations(base_names)
    here_migs, _ = parse_migrations(here_names)

    highest_base = max((m.version for m in base_migs), default=None)
    base_name_set = set(base_names)
    new_names = [n for n in here_names if n not in base_name_set]
    new_migs, _ = parse_migrations(new_names)

    problems = []
    if highest_base is not None:
        for m in new_migs:
            if m.version <= highest_base:
                problems.append(
                    f"{m.path.name}: version {m.version} is not above {highest_base}, "
                    f"the highest migration version already at the merge base with "
                    f"{upstream}. golang-migrate applies only versions STRICTLY "
                    "ABOVE the one recorded in schema_migrations — a migration "
                    "landing at or below an already-deployed version is SILENTLY "
                    "SKIPPED (`migrate up` prints \"done\", exits 0, and never runs "
                    "it). See CLAUDE.md's \"Git / PR workflow\" section for the "
                    "full mechanism and the incident that first found it."
                )
    return problems, True


def run_check(repo_root: Path = ROOT, migrations_dir: Path = MIGRATIONS_DIR) -> int:
    if not migrations_dir.is_dir():
        print(f"check-migration-versions: {migrations_dir} does not exist")
        return 1

    names = sorted(p.name for p in migrations_dir.glob("*") if p.is_file())
    migs, unparseable = parse_migrations(names, dir_for_path=migrations_dir)

    problems: list[str] = []
    if unparseable:
        problems.append(
            "these files do not match golang-migrate's own version regex "
            f"({MIGRATION_RE.pattern}) and would be silently ignored by it "
            "as a migration source (only .up.sql/.down.sql pairs matter): "
            + ", ".join(unparseable)
        )
    problems += check_pairing(migs)
    problems += check_duplicates(migs)

    merge_base_problems, ok = check_new_migrations_above_merge_base(repo_root)
    if not ok:
        # Hard failure per module docstring — cannot judge, must not pass.
        print("check-migration-versions: " + merge_base_problems[0])
        return 1
    problems += merge_base_problems

    if problems:
        print(
            f"check-migration-versions: {len(problems)} problem(s) in "
            f"{migrations_dir.relative_to(repo_root)}:\n"
        )
        for p in problems:
            print(f"  - {p}")
        return 1

    print(
        f"check-migration-versions: ok — {len(migs)} migration files, "
        f"{len({m.stem for m in migs})} distinct migrations, no duplicates, "
        "every new one versioned above the merge base"
    )
    return 0


# --------------------------------------------------------------------------
# --self-test: synthetic fixtures. Pairing/duplicate checks need no git; the
# merge-base check builds a real throwaway git repository (same technique as
# append-only-merge.py --self-test) so it is exercised against real git
# plumbing, not a mock of it.
# --------------------------------------------------------------------------


def _mk(dir_path: Path, name: str) -> None:
    (dir_path / name).write_text(f"-- {name}\n")


def self_test() -> int:
    failures: list[str] = []

    def check(label: str, condition: bool) -> None:
        if not condition:
            failures.append(label)

    # 1. Pairing: a clean pair passes; a missing .down.sql is caught.
    migs, _ = parse_migrations([
        "000001_init.up.sql", "000001_init.down.sql",
        "000002_add_col.up.sql",  # missing .down.sql
    ])
    problems = check_pairing(migs)
    check(
        "pairing check catches a migration missing its .down.sql",
        any("add_col" in p and "no matching .down.sql" in p for p in problems),
    )
    check(
        "pairing check does not flag the clean pair",
        not any("init" in p for p in problems),
    )

    # 2. Duplicates: the mutation-check the ticket explicitly asks for — force
    #    two DIFFERENT migrations onto the exact same version, confirm the
    #    check catches it, then remove the artificial duplicate and confirm
    #    it goes green again (restore is confirmed by re-running, not by
    #    re-reading the fixture).
    clean_names = [
        "20260907120000_add_foo.up.sql", "20260907120000_add_foo.down.sql",
        "20260907130000_add_bar.up.sql", "20260907130000_add_bar.down.sql",
    ]
    colliding_names = clean_names + [
        # Same version as add_foo, different stem: an exact collision, the
        # one mode the ticket calls out as still reachable even with
        # timestamps (two agents in the same wall-clock second).
        "20260907120000_add_baz.up.sql", "20260907120000_add_baz.down.sql",
    ]
    clean_migs, _ = parse_migrations(clean_names)
    colliding_migs, _ = parse_migrations(colliding_names)
    problems_clean = check_duplicates(clean_migs)
    problems_colliding = check_duplicates(colliding_migs)
    check("duplicate check passes on a clean set", problems_clean == [])
    check(
        "duplicate check catches an exact version collision between two agents",
        any("20260907120000" in p and "add_foo" in p and "add_baz" in p for p in problems_colliding),
    )
    # Restore: remove the artificial duplicate, confirm it is green again.
    problems_restored = check_duplicates(clean_migs)
    check("removing the artificial duplicate makes it pass again", problems_restored == [])

    # 3. Overflow guard.
    huge_migs, _ = parse_migrations([f"{MAX_VERSION + 1}_x.up.sql", f"{MAX_VERSION + 1}_x.down.sql"])
    check(
        "a version beyond uint64/bigint range is flagged",
        any("exceeds" in p for p in check_duplicates(huge_migs)),
    )

    # 4. Merge-base check, against a REAL throwaway git repository.
    failures += _self_test_merge_base()

    # 5. The property that closes the ticket's "merge queue" acceptance
    #    criterion: two migrations under DIFFERENT filenames, whose versions
    #    collide, merge into git with NO textual conflict (ac-verifier found
    #    this — see docs/decisions/history.md's N149 entry) — so the
    #    merge-base check alone is blind to it. What catches it is
    #    `run_check()` ITSELF, invoked exactly as CI invokes it, once BOTH
    #    files are present with neither "new" relative to the ref being
    #    compared against (the state a `push`-to-`main` CI run sees, since
    #    HEAD and origin/main are the same commit right after a merge). This
    #    exercises the real entry point, not just `check_duplicates()` in
    #    isolation (case 2 above), so a future change that scoped duplicate
    #    detection to only "new" files — which would silently reopen this
    #    exact gap — fails HERE.
    failures += _self_test_post_merge_duplicate_via_run_check()

    if failures:
        print("check-migration-versions self-test FAILED:\n", file=sys.stderr)
        for label in failures:
            print(f"  - {label}", file=sys.stderr)
        return 1

    print("check-migration-versions self-test ok")
    return 0


def _run_git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


def _self_test_merge_base() -> list[str]:
    failures: list[str] = []
    tmp = Path(tempfile.mkdtemp(prefix="check-migration-versions-selftest-"))
    try:
        repo = tmp / "repo"
        repo.mkdir()
        _run_git(repo, "init", "-q", "-b", "main")
        _run_git(repo, "config", "user.email", "test@example.com")
        _run_git(repo, "config", "user.name", "Test")

        mig_dir = repo / MIGRATIONS_REL
        mig_dir.mkdir(parents=True)
        # The "already on main" state: highest version 000001.
        _mk(mig_dir, "000001_init.up.sql")
        _mk(mig_dir, "000001_init.down.sql")
        _run_git(repo, "add", "-A")
        _run_git(repo, "commit", "-q", "-m", "base")

        _run_git(repo, "checkout", "-q", "-b", "feature")

        # Case A: a genuinely new migration, versioned above the base — must
        # pass, whether it's timestamp-shaped or sequential-shaped.
        _mk(mig_dir, "20260907120000_add_foo.up.sql")
        _mk(mig_dir, "20260907120000_add_foo.down.sql")
        _run_git(repo, "add", "-A")
        _run_git(repo, "commit", "-q", "-m", "good migration")

        problems, ok = check_new_migrations_above_merge_base(repo, upstream="main")
        if not ok:
            failures.append("merge-base check: could not establish merge base in the throwaway repo at all")
        if problems:
            failures.append(f"merge-base check: false positive on a genuinely-new, above-base migration: {problems}")

        # Case B: the silent-skip trap re-created — a new migration versioned
        # AT OR BELOW the merge base's highest (000000 < 000001). This is the
        # exact CLAUDE.md incident shape ("add a 000065 when the database is
        # already at 66"), reproduced here with the new checker in front of
        # it instead of behind it.
        _mk(mig_dir, "000000_bad_too_low.up.sql")
        _mk(mig_dir, "000000_bad_too_low.down.sql")
        _run_git(repo, "add", "-A")
        _run_git(repo, "commit", "-q", "-m", "bad migration: too low")

        problems2, ok2 = check_new_migrations_above_merge_base(repo, upstream="main")
        if not ok2:
            failures.append("merge-base check: could not establish merge base after adding the bad migration")
        if not any("bad_too_low" in p for p in problems2):
            failures.append(f"merge-base check: FAILED TO CATCH a new migration versioned at/below the merge base: {problems2}")

        # Restore: remove the bad migration (git rm, then commit), confirm
        # green again by RE-RUNNING the check, not by inspecting the tree.
        _run_git(repo, "rm", "-q", "backend/migrations/000000_bad_too_low.up.sql", "backend/migrations/000000_bad_too_low.down.sql")
        _run_git(repo, "commit", "-q", "-m", "revert bad migration")
        problems3, ok3 = check_new_migrations_above_merge_base(repo, upstream="main")
        if not ok3 or problems3:
            failures.append(f"merge-base check: did not go green again after removing the bad migration: {problems3}")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return failures


def _self_test_post_merge_duplicate_via_run_check() -> list[str]:
    """Reproduce a `push`-to-`main` CI run AFTER two non-conflicting PRs have
    landed a version collision, and confirm `run_check()` — the actual CI
    entry point, not an internal function in isolation — reports it.

    Two branches off one base each add a DIFFERENTLY-NAMED migration with the
    SAME colliding version; merging both sequentially is git-clean (no
    textual conflict, confirmed here exactly as `ac-verifier` first found).
    `origin/main` is then pointed at the merged HEAD — the state a `push`-to-
    `main` CI run sees, where neither file is "new" relative to what is being
    compared against. `run_check()` must still catch the duplicate, via its
    unconditional whole-directory scan, not the merge-base-vs-new-files path
    (which is provably blind here — asserted explicitly below).
    """
    failures: list[str] = []
    tmp = Path(tempfile.mkdtemp(prefix="check-migration-versions-selftest-postmerge-"))
    try:
        repo = tmp / "repo"
        repo.mkdir()
        _run_git(repo, "init", "-q", "-b", "main")
        _run_git(repo, "config", "user.email", "test@example.com")
        _run_git(repo, "config", "user.name", "Test")

        mig_dir = repo / MIGRATIONS_REL
        mig_dir.mkdir(parents=True)
        _mk(mig_dir, "000001_init.up.sql")
        _mk(mig_dir, "000001_init.down.sql")
        _run_git(repo, "add", "-A")
        _run_git(repo, "commit", "-q", "-m", "base")
        base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True
        ).stdout.strip()

        _run_git(repo, "checkout", "-q", "-b", "pr-a", base_sha)
        _mk(mig_dir, "20260907120000_add_foo.up.sql")
        _mk(mig_dir, "20260907120000_add_foo.down.sql")
        _run_git(repo, "add", "-A")
        _run_git(repo, "commit", "-q", "-m", "PR A: add_foo")

        _run_git(repo, "checkout", "-q", "-b", "pr-b", base_sha)
        _mk(mig_dir, "20260907120000_add_bar.up.sql")  # SAME version, different name
        _mk(mig_dir, "20260907120000_add_bar.down.sql")
        _run_git(repo, "add", "-A")
        _run_git(repo, "commit", "-q", "-m", "PR B: add_bar (same timestamp)")

        _run_git(repo, "checkout", "-q", "main")
        _run_git(repo, "merge", "-q", "--no-ff", "-m", "merge PR A", "pr-a")
        merge_b = subprocess.run(
            ["git", "merge", "--no-ff", "-m", "merge PR B", "pr-b"],
            cwd=repo, capture_output=True, text=True,
        )
        if merge_b.returncode != 0:
            failures.append(
                "post-merge self-test: PR B did not merge cleanly — the fixture "
                f"itself is wrong (expected NO conflict): {merge_b.stderr}"
            )
            return failures

        # Simulate the push-to-main state: origin/main IS this commit.
        _run_git(repo, "update-ref", "refs/remotes/origin/main", "main")

        # Confirm the merge-base-vs-new-files path is indeed blind here —
        # this is the asserted precondition, not just a comment.
        mb_problems, mb_ok = check_new_migrations_above_merge_base(repo)
        if not mb_ok:
            failures.append("post-merge self-test: could not establish merge base at all")
        elif mb_problems:
            failures.append(
                "post-merge self-test: merge-base check UNEXPECTEDLY caught the "
                f"collision — the fixture no longer demonstrates the blind spot: {mb_problems}"
            )

        # The actual assertion: run_check(), the real CI entry point, still
        # catches the collision via its unconditional whole-directory scan.
        rc = run_check(repo_root=repo, migrations_dir=mig_dir)
        if rc == 0:
            failures.append(
                "post-merge self-test: run_check() PASSED on a directory with a "
                "genuine version collision between two non-conflicting PRs — "
                "the exact gap ac-verifier found would have reopened silently"
            )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Exercise the checking logic against synthetic fixtures, including a "
             "real throwaway git repository for the merge-base check. Runs anywhere.",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()
    return run_check()


if __name__ == "__main__":
    sys.exit(main())
