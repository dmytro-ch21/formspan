#!/usr/bin/env python3
"""Label a pull request that has gone CONFLICTING, and tell it how to fix that.

## The failure this makes loud (N199, #635)

A pull request that conflicts with its base gets **zero new check runs**.
`pull_request` workflows run on `refs/pull/N/merge`; while that merge cannot be
built, GitHub creates no run and says nothing. Every surface shows an absence,
and an absence reads exactly like nothing failing. `pnpm run ci:checks` detects
it — but only for whoever thinks to run it, on the pull request they thought to
run it against, and the pull requests this bites are the ones nobody is looking
at. Measured the morning #624 merged: #631 sat CONFLICTING with zero runs while
its agent reported local `verify` results believing it had CI.

So this runs without anyone choosing to look — on every push to `main` (the
moment most conflicts are born) and on a schedule (the backstop for the rest) —
and puts the state on the pull request's own page: a `needs-rebase` label while
it conflicts, and one comment naming the fix.

## The decision, as one pure function (`decide`)

    state   mergeable     labelled  told at this head  ->  actions
    open    CONFLICTING   no        no                     comment, then label
    open    CONFLICTING   no        yes                    label only
    open    CONFLICTING   yes       either                 nothing
    open    MERGEABLE     yes       -                      remove label
    open    MERGEABLE     no        -                      nothing
    open    UNKNOWN/null  either    -                      nothing (ask next cycle)
    closed  any           yes       -                      remove label
    closed  any           no        -                      nothing

Four rules are load-bearing, and each is a trap the ticket named:

1. **Only `mergeable` decides — never the presence or colour of checks.** Runs
   already created are never withdrawn, so a CONFLICTING pull request can show
   a full green set (#395: six green runs, conflict nineteen seconds later).
   `decide` takes the head's check summary as an argument precisely so the
   self-test can prove it is ignored in both directions.
2. **UNKNOWN is "ask again", never conflicting.** REST reads `mergeable: null`
   while GitHub computes it — for seconds after any push, and for every open
   pull request right after `main` moves. `sweep` re-reads nulls after short
   delays; anything still null is left alone until the next run.
3. **Comment once per conflict episode.** The label is the episode: while it
   stands, nothing is re-posted, even if the comment was deleted by hand (that
   is a person's decision, and the label still carries the state). The comment
   carries a hidden sentinel naming the HEAD it was written at, and is posted
   BEFORE the label, so a run that dies between the two writes can never leave
   a label with no comment — the next run sees the sentinel and adds only the
   label. A sentinel from an earlier head is an earlier episode (a rebase makes
   a new head), so a pull request that conflicts again after a rebase is told
   again.
4. **Never rebase, never push, never check out pull request code.** Making the
   state visible is the whole job; a human pushes.

The conflicting file(s) themselves are not in any API — only a merge knows. What
REST can say without checking anything out is which files changed on BOTH sides
since they diverged (`pulls/N/files` against `compare/HEAD...BASE`), which is a
true superset of the conflict. The comment says exactly that, and says so when
the list is incomplete or could not be read, rather than guessing.

Draft pull requests are labelled too: a conflicting draft gets zero runs just
the same, and a draft is where an author is iterating on the belief that CI is
running.

A closed pull request still wearing the label has it removed. A pull request
rebased and merged inside one cycle is never seen open-and-mergeable, and would
otherwise keep `needs-rebase` for good — a scar, not a state.

## Why the logic is here and not in the workflow YAML

Same reason as `evidence-latch.py`: `push`/`schedule` workflows run the default
branch's copy, so logic inline in YAML is untestable until it has merged. Here
the decision is pure (`--self-test`, no network), the whole sweep runs end to
end against a fake transport, and `--dry-run` reads the live repository and
prints what it would do without writing anything.

Stdlib-only. REST only, through one `gh api` call site that refuses GraphQL —
every session in this fleet shares one GraphQL budget (H27, #1099).
"""

from __future__ import annotations

from pathlib import Path
import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from urllib.parse import quote

LABEL = "needs-rebase"
LABEL_COLOR = "b60205"
LABEL_DESC = "Conflicts with its base, so CI cannot run on it until it is rebased"

REMEDY = "git fetch origin && git rebase origin/main && git push --force-with-lease"

MERGEABLE = "MERGEABLE"
CONFLICTING = "CONFLICTING"
UNKNOWN = "UNKNOWN"

COMMENT = "comment"
ADD_LABEL = "add_label"
REMOVE_LABEL = "remove_label"

# REST re-read delays for `mergeable: null`, in seconds. Short on purpose: the
# push-triggered run lands seconds after a merge to `main`, which is exactly
# when every open pull request's mergeability is being recomputed. Past the
# last delay a null stays UNKNOWN and the next run asks again.
MERGEABLE_RETRY_DELAYS = (3, 5, 10)

# `compare` returns at most 300 files for a whole comparison (GitHub REST docs),
# so a list that long may be cut off. `pulls/N/files` pages to 3,000.
COMPARE_FILE_CAP = 300
PAGE_CAP = 30
FILE_LIST_CAP = 20

DEPENDABOT = "dependabot[bot]"


# --------------------------------------------------------------------------
# Pure logic — everything down to `# --- I/O ---` is network-free.
# --------------------------------------------------------------------------


def mergeable_from_rest(value) -> str:
    """REST's `mergeable` (true / false / null) in GraphQL's vocabulary.

    Only a real boolean is an answer. `1 == True` in Python, so an integer must
    not be mistaken for one; anything else is UNKNOWN, which acts on nothing.
    """
    if isinstance(value, bool):
        return MERGEABLE if value else CONFLICTING
    return UNKNOWN


def sentinel(head_sha: str) -> str:
    return f"<!-- conflict-label head={head_sha} -->"


def has_sentinel(comments: list[dict], head_sha: str) -> bool:
    """Whether this pull request was already told about a conflict AT this head."""
    marker = sentinel(head_sha)
    return bool(head_sha) and any(marker in (c.get("body") or "") for c in comments)


@dataclass(frozen=True)
class Decision:
    actions: tuple[str, ...]
    reason: str


def decide(
    *,
    state: str,
    mergeable: str,
    labelled: bool,
    has_sentinel: bool,
    head_checks: str | None = None,
) -> Decision:
    """The whole policy. See the table in the module docstring.

    `head_checks` ("green", "failing", "none" or None) is accepted and NEVER
    read. It is here so the self-test can hand this function the #395 case — a
    full green set on a conflicting pull request — and prove the answer does not
    move. A check-keyed "simplification" would otherwise have nothing to fail.
    """
    if state != "open":
        if labelled:
            return Decision((REMOVE_LABEL,), "closed while still labelled; the label is a live state")
        return Decision((), "not open")

    if mergeable == CONFLICTING:
        if labelled:
            return Decision((), "label stands, so this conflict was already announced")
        if has_sentinel:
            return Decision((ADD_LABEL,), "already told at this head; restoring the label only")
        return Decision((COMMENT, ADD_LABEL), "conflicting and not yet announced")

    if mergeable == MERGEABLE:
        if labelled:
            return Decision((REMOVE_LABEL,), "no longer conflicting")
        return Decision((), "mergeable")

    return Decision((), "mergeability not computed yet; asking again next run")


def _file_names(entries) -> set[str]:
    names: set[str] = set()
    for entry in entries or []:
        for key in ("filename", "previous_filename"):
            if entry.get(key):
                names.add(entry[key])
    return names


def both_sides(pr_files, base_files) -> list[str]:
    """Files changed on this branch AND on its base since they diverged.

    A superset of the conflicting files, never a guess at them. Renames count
    under both names, because a rename on one side against an edit on the other
    is a conflict on the old name.
    """
    return sorted(_file_names(pr_files) & _file_names(base_files))


def workflow_permissions(text: str) -> dict[str, str]:
    """The top-level `permissions:` block of a workflow file, as {scope: access}.

    Stdlib only, so `verify` and the Scripts CI job need no YAML parser. It reads
    the first column-0 `permissions:` line and the indented `scope: access` lines
    under it, skipping comments and blank lines, and stops at the next column-0
    line. A job-level block is indented, so it is never mistaken for this one.
    """
    out: dict[str, str] = {}
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.rstrip() != "permissions:":
            continue
        for nxt in lines[i + 1:]:
            stripped = nxt.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if not nxt.startswith((" ", "\t")):
                break
            key, sep, value = stripped.partition(":")
            if sep:
                out[key.strip()] = value.split("#", 1)[0].strip()
        break
    return out


def code_span(text: str) -> str:
    """Render untrusted text (a file name, a branch name) as ONE inline code span.

    The text comes from the pull request's author, and this comment is posted
    by the repository's own bot on a public repository, so it must not be able
    to break out of its span and inject markdown: links, images, @mentions.
    CommonMark closes a code span at the first backtick run of the SAME length
    as the opener, so the fence is one backtick longer than the longest run
    inside the text, padded with a space when the text starts or ends with a
    backtick. A line break (legal in a git path) would end the list item, so it
    is shown as a literal `\\n`. Found in N199's review; not reachable today only
    because a file is listed when `main` changed it too.
    """
    flat = text.replace("\r", "\\r").replace("\n", "\\n")
    longest = run = 0
    for ch in flat:
        run = run + 1 if ch == "`" else 0
        longest = max(longest, run)
    fence = "`" * (longest + 1)
    pad = " " if flat.startswith("`") or flat.endswith("`") or not flat.strip() else ""
    return f"{fence}{pad}{flat}{pad}{fence}"


def render_comment(
    *,
    head_sha: str,
    base_ref: str,
    files: list[str] | None,
    files_complete: bool,
    dependabot: bool = False,
) -> str:
    base = base_ref or "main"
    lines = [
        sentinel(head_sha),
        f"**This pull request conflicts with {code_span(base)}, so CI is not running on it.**",
        "",
        "A `pull_request` check runs on the merge of this branch into its base, and GitHub "
        "cannot build that merge while the two conflict — so **no new check runs are "
        "created**, and nothing else on this page says so. Checks already shown here "
        "describe a merge that no longer exists, even when they are green.",
        "",
    ]
    if dependabot:
        lines += [
            "**To fix it**, comment `@dependabot rebase` on this pull request. Dependabot "
            "normally rebases a conflicting branch by itself; avoid pushing to its branch "
            "yourself, which stops it managing that branch.",
            "",
        ]
    else:
        lines += [
            "**To fix it**, rebase and push:",
            "",
            f"    git fetch origin && git rebase origin/{base} && git push --force-with-lease",
            "",
        ]

    if files is None:
        lines += [
            "Which file(s) conflict could not be listed: GitHub's API does not report it, "
            "and this workflow never checks out pull request code. `git rebase` names "
            "them when it stops.",
            "",
        ]
    elif not files:
        lines += [
            f"GitHub's API shows no file changed on both this branch and {code_span(base)} since they "
            "diverged, so the conflicting file(s) cannot be named from here. `git rebase` "
            "names them when it stops.",
            "",
        ]
    else:
        shown = files[:FILE_LIST_CAP]
        lines += [
            f"Changed on **both** this branch and {code_span(base)} since they diverged — the conflict "
            "is in one or more of these (GitHub's API does not say which):",
            "",
        ]
        lines += [f"- {code_span(name)}" for name in shown]
        if len(files) > len(shown):
            lines.append(f"- …and {len(files) - len(shown)} more")
        if not files_complete:
            lines += [
                "",
                "This list may be incomplete: one side changed more files than GitHub's API "
                "returns for one comparison.",
            ]
        lines.append("")

    lines += [
        f"Labelled `{LABEL}` while it conflicts. The label comes off by itself once GitHub "
        "reads this pull request as mergeable again. It is a prompt, not a check — "
        "`pnpm run ci:checks` is still the gate.",
        "",
    ]
    return "\n".join(lines)


def checks_summary(runs: list[dict]) -> str:
    if not runs:
        return "none"
    if all(r.get("conclusion") == "success" for r in runs):
        return "green"
    return "failing"


_SLUG = re.compile(
    r"^(?:[a-z+]+://)?(?:[^@/\s]+@)?github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$"
)


def resolve_repo(explicit: str | None, env, origin_url: str) -> str:
    """`--repo`, then GH_REPO, then GITHUB_REPOSITORY, then `origin`. Never a literal.

    Deliberately not `gh repo view`, which is GraphQL.
    """
    for value in (explicit, env.get("GH_REPO"), env.get("GITHUB_REPOSITORY")):
        if value and value.strip():
            return value.strip()
    m = _SLUG.match((origin_url or "").strip())
    if m:
        return f"{m.group(1)}/{m.group(2)}"
    raise SystemExit(
        "conflict-label: cannot tell which repository to act on — pass --repo, set "
        "GH_REPO or GITHUB_REPOSITORY, or run inside a checkout whose origin is on github.com"
    )


# --------------------------------------------------------------------------
# --- I/O ---
# --------------------------------------------------------------------------


def gh_api(method: str, path: str, *, fields=None, body=None, tolerate=()):
    """The ONLY way this script talks to GitHub: one REST call through `gh api`.

    `tolerate` names stderr markers (e.g. "HTTP 404") that mean "already in the
    state we wanted"; those return None. Anything else raises, so a failed write
    can never be printed as a success.
    """
    if path.lstrip("/").split("?", 1)[0].split("/", 1)[0] == "graphql":
        raise RuntimeError("conflict-label is REST-only (H27, #1099): refusing a GraphQL call")
    args = ["gh", "api", "-X", method, path]
    for key, value in (fields or {}).items():
        args += ["-f", f"{key}={value}"]
    if body is not None:
        args += ["-F", "body=@-"]
    proc = subprocess.run(args, capture_output=True, text=True, input=body)
    if proc.returncode != 0:
        if any(marker in proc.stderr for marker in tolerate):
            return None
        raise RuntimeError(f"gh api -X {method} {path} failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout) if proc.stdout.strip() else None


def _origin_url() -> str:
    try:
        proc = subprocess.run(
            ["git", "config", "--get", "remote.origin.url"], capture_output=True, text=True
        )
    except OSError:
        return ""
    return proc.stdout if proc.returncode == 0 else ""


class Client:
    def __init__(self, repo: str, *, dry_run: bool, transport=gh_api):
        self.repo = repo
        self.dry_run = dry_run
        self.transport = transport
        self.performed: list[str] = []
        self._label_ready = False

    def get(self, path: str, tolerate=()):
        return self.transport("GET", path, tolerate=tolerate)

    def write(self, method: str, path: str, *, fields=None, body=None, tolerate=()):
        # Second, independent guard: `_do` already skips writes in a dry run.
        # This one refuses at the transport boundary, so a future caller that
        # forgets `_do` still cannot write from `--dry-run`.
        if self.dry_run:
            raise RuntimeError(f"dry run: refusing to {method} {path}")
        return self.transport(method, path, fields=fields, body=body, tolerate=tolerate)

    def _do(self, description: str, fn) -> None:
        if self.dry_run:
            self.performed.append(f"would {description}")
            print(f"      would {description}")
            return
        fn()
        self.performed.append(description)
        print(f"      {description}")

    def pages(self, path: str) -> tuple[list, bool]:
        """Every page of a list endpoint. The bool is False if PAGE_CAP cut it off."""
        out: list = []
        sep = "&" if "?" in path else "?"
        for page in range(1, PAGE_CAP + 1):
            chunk = self.get(f"{path}{sep}per_page=100&page={page}") or []
            out += chunk
            if len(chunk) < 100:
                return out, True
        return out, False

    def ensure_label(self) -> None:
        if self._label_ready:
            return
        if self.get(f"repos/{self.repo}/labels/{LABEL}", tolerate=("HTTP 404",)) is None:
            self._do(
                f"create the `{LABEL}` label",
                lambda: self.write(
                    "POST", f"repos/{self.repo}/labels",
                    fields={"name": LABEL, "color": LABEL_COLOR, "description": LABEL_DESC},
                    tolerate=("HTTP 422",),  # created concurrently: already exists
                ),
            )
        self._label_ready = True


def conflict_files(client: Client, pull: dict) -> tuple[list[str] | None, bool]:
    n = pull["number"]
    head = (pull.get("head") or {}).get("sha", "")
    base = (pull.get("base") or {}).get("ref", "") or "main"
    try:
        pr_files, pr_complete = client.pages(f"repos/{client.repo}/pulls/{n}/files")
        cmp = client.get(f"repos/{client.repo}/compare/{head}...{quote(base, safe='/')}")
    except RuntimeError as err:
        print(f"      (could not list changed files for #{n}: {err})")
        return None, False
    base_files = (cmp or {}).get("files") or []
    return both_sides(pr_files, base_files), pr_complete and len(base_files) < COMPARE_FILE_CAP


def act_on(client: Client, pull: dict, *, with_checks: bool) -> None:
    n = pull["number"]
    state = pull.get("state", "")
    head = (pull.get("head") or {}).get("sha", "")
    labelled = any(l.get("name") == LABEL for l in pull.get("labels") or [])
    mergeable = mergeable_from_rest(pull.get("mergeable")) if state == "open" else UNKNOWN

    told = False
    if state == "open" and mergeable == CONFLICTING:
        # Read whether or not the label stands, so the I/O never encodes an
        # assumption about which inputs `decide` looks at.
        comments, _ = client.pages(f"repos/{client.repo}/issues/{n}/comments")
        told = has_sentinel(comments, head)

    checks = None
    if with_checks and state == "open" and head:
        runs = (client.get(
            f"repos/{client.repo}/commits/{head}/check-runs?per_page=100&filter=latest"
        ) or {}).get("check_runs", [])
        checks = f"{len(runs)} {checks_summary(runs)}"

    decision = decide(
        state=state, mergeable=mergeable, labelled=labelled, has_sentinel=told,
        head_checks=checks.split(" ", 1)[1] if checks else None,
    )
    print(
        f"  #{n} {state}{' draft' if pull.get('draft') else ''} "
        f"mergeable={mergeable} ({pull.get('mergeable_state') or '-'}) "
        f"labelled={'yes' if labelled else 'no'} told-at-head={'yes' if told else 'no'}"
        + (f" checks={checks}" if checks else "")
        + f" -> {' + '.join(decision.actions) or 'nothing'}: {decision.reason}"
    )

    for action in decision.actions:
        if action == COMMENT:
            files, complete = conflict_files(client, pull)
            text = render_comment(
                head_sha=head,
                base_ref=(pull.get("base") or {}).get("ref", ""),
                files=files,
                files_complete=complete,
                dependabot=(pull.get("user") or {}).get("login") == DEPENDABOT,
            )
            if client.dry_run:
                listed = "unlisted" if files is None else (", ".join(files) or "none on both sides")
                print(f"      files on both sides: {listed}{'' if complete else ' (incomplete)'}")
            client._do(
                f"comment on #{n}",
                lambda: client.write("POST", f"repos/{client.repo}/issues/{n}/comments", body=text),
            )
        elif action == ADD_LABEL:
            client.ensure_label()
            client._do(
                f"add `{LABEL}` to #{n}",
                lambda: client.write(
                    "POST", f"repos/{client.repo}/issues/{n}/labels", fields={"labels[]": LABEL}
                ),
            )
        elif action == REMOVE_LABEL:
            client._do(
                f"remove `{LABEL}` from #{n}",
                lambda: client.write(
                    "DELETE", f"repos/{client.repo}/issues/{n}/labels/{LABEL}",
                    tolerate=("HTTP 404",),
                ),
            )


def sweep(client: Client, *, sleep=time.sleep, delays=MERGEABLE_RETRY_DELAYS,
          with_checks: bool = False) -> int:
    listed, _ = client.pages(f"repos/{client.repo}/pulls?state=open")
    detail: dict[int, dict] = {}
    errors = 0
    # The list endpoint carries no `mergeable` at all; only the single-PR read
    # does, and that read is also what asks GitHub to compute it.
    for item in listed:
        n = item["number"]
        try:
            detail[n] = client.get(f"repos/{client.repo}/pulls/{n}")
        except RuntimeError as err:
            print(f"  #{n}: could not read: {err}")
            errors += 1

    for delay in delays:
        pending = [n for n, p in detail.items() if p.get("state") == "open" and p.get("mergeable") is None]
        if not pending:
            break
        sleep(delay)
        for n in pending:
            try:
                detail[n] = client.get(f"repos/{client.repo}/pulls/{n}")
            except RuntimeError as err:
                print(f"  #{n}: could not re-read: {err}")

    print(f"{len(detail)} open pull request(s) in {client.repo}:")
    for n in sorted(detail):
        try:
            act_on(client, detail[n], with_checks=with_checks)
        except RuntimeError as err:
            print(f"  #{n}: FAILED: {err}")
            errors += 1

    closed, _ = client.pages(f"repos/{client.repo}/issues?state=closed&labels={LABEL}")
    closed_prs = [i for i in closed if "pull_request" in i]
    if closed_prs:
        print(f"{len(closed_prs)} closed pull request(s) still labelled `{LABEL}`:")
    for issue in closed_prs:
        try:
            act_on(client, {**issue, "state": "closed"}, with_checks=False)
        except RuntimeError as err:
            print(f"  #{issue.get('number')}: FAILED: {err}")
            errors += 1

    print(f"{'would write' if client.dry_run else 'wrote'}: {len(client.performed)}; errors: {errors}")
    return 1 if errors else 0


# --------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------


class _FakeGitHub:
    """A transport answering from dicts, recording every call. No network."""

    def __init__(self, *, pulls, comments=None, pr_files=None, base_files=None,
                 closed=None, label_exists=False):
        self.pulls = pulls  # number -> list of payloads, one per successive read
        self.reads: dict[int, int] = {}
        self.comments = comments or {}
        self.pr_files = pr_files or {}
        self.base_files = base_files or []
        self.closed = closed or []
        self.label_exists = label_exists
        self.calls: list[tuple] = []

    def writes(self) -> list[str]:
        return [f"{m} {p}" for m, p, _, _ in self.calls if m != "GET"]

    def bodies(self, n: int) -> list[str]:
        return [b for m, p, _, b in self.calls if m == "POST" and p == f"repos/o/r/issues/{n}/comments"]

    def __call__(self, method, path, *, fields=None, body=None, tolerate=()):
        self.calls.append((method, path, dict(fields or {}), body))
        if method != "GET":
            return {}
        bare, _, query = path.partition("?")
        page = re.search(r"(?:^|&)page=(\d+)", query)
        if page and int(page.group(1)) > 1:
            return []
        if bare == "repos/o/r/pulls":
            return [{"number": n} for n in self.pulls]
        m = re.fullmatch(r"repos/o/r/pulls/(\d+)", bare)
        if m:
            n = int(m.group(1))
            answers = self.pulls[n]
            i = self.reads.get(n, 0)
            self.reads[n] = i + 1
            return answers[min(i, len(answers) - 1)]
        m = re.fullmatch(r"repos/o/r/pulls/(\d+)/files", bare)
        if m:
            return self.pr_files.get(int(m.group(1)), [])
        m = re.fullmatch(r"repos/o/r/issues/(\d+)/comments", bare)
        if m:
            return self.comments.get(int(m.group(1)), [])
        if bare.startswith("repos/o/r/compare/"):
            return {"files": self.base_files}
        if bare == "repos/o/r/issues":
            return self.closed
        if bare == f"repos/o/r/labels/{LABEL}":
            return {"name": LABEL} if self.label_exists else None  # a tolerated 404
        if bare.startswith("repos/o/r/commits/"):
            return {"check_runs": []}
        raise RuntimeError(f"fake GitHub: unrouted {method} {path}")


def _pull(n, mergeable, *, labelled=False, state="open", head=None, draft=False,
          base="main", user="dmytro-ch21") -> dict:
    return {
        "number": n, "state": state, "draft": draft, "mergeable": mergeable,
        "mergeable_state": {True: "clean", False: "dirty"}.get(mergeable, "unknown"),
        "labels": [{"name": LABEL}] if labelled else [],
        "head": {"sha": head or f"head{n}", "ref": f"branch{n}"},
        "base": {"ref": base}, "user": {"login": user},
    }


def self_test() -> int:
    import contextlib
    import io

    failures: list[str] = []

    def check(name, got, want) -> None:
        if got != want:
            failures.append(f"{name}: got {got!r}, wanted {want!r}")

    def acts(**kw) -> tuple[str, ...]:
        base = dict(state="open", mergeable=CONFLICTING, labelled=False, has_sentinel=False)
        base.update(kw)
        return decide(**base).actions

    # --- the decision table -------------------------------------------------
    check("CONFLICTING, no label, never told -> comment THEN label",
          acts(), (COMMENT, ADD_LABEL))
    check("CONFLICTING, labelled, told -> nothing (comment once per episode)",
          acts(labelled=True, has_sentinel=True), ())
    check("CONFLICTING, labelled, NOT told (comment deleted by hand) -> nothing while the label stands",
          acts(labelled=True, has_sentinel=False), ())
    check("CONFLICTING, no label, already told at this head -> label only, never a second comment",
          acts(has_sentinel=True), (ADD_LABEL,))
    check("MERGEABLE, labelled -> remove the label (a live state, not a scar)",
          acts(mergeable=MERGEABLE, labelled=True), (REMOVE_LABEL,))
    check("MERGEABLE, no label -> nothing", acts(mergeable=MERGEABLE), ())
    check("UNKNOWN, no label -> nothing (never treated as conflicting)",
          acts(mergeable=UNKNOWN), ())
    check("UNKNOWN, labelled -> nothing (not removed either; ask again)",
          acts(mergeable=UNKNOWN, labelled=True), ())
    check("UNKNOWN, told -> nothing", acts(mergeable=UNKNOWN, has_sentinel=True), ())
    check("closed, no label, REST still says false -> nothing",
          acts(state="closed", mergeable=CONFLICTING), ())
    check("closed (merged), no label -> nothing", acts(state="closed", mergeable=MERGEABLE), ())
    check("closed, still labelled -> remove the label",
          acts(state="closed", mergeable=UNKNOWN, labelled=True), (REMOVE_LABEL,))

    # --- keyed on mergeable, never on checks (#395) ----------------------------
    check("#395: a FULL GREEN SET on a CONFLICTING pull request is still flagged",
          acts(head_checks="green"), (COMMENT, ADD_LABEL))
    check("green checks while labelled and conflicting do not remove the label",
          acts(labelled=True, head_checks="green"), ())
    check("ZERO checks on a MERGEABLE pull request is not a conflict",
          acts(mergeable=MERGEABLE, head_checks="none"), ())
    check("ZERO checks do not keep a label on a MERGEABLE pull request",
          acts(mergeable=MERGEABLE, labelled=True, head_checks="none"), (REMOVE_LABEL,))
    check("failing checks change nothing either",
          acts(mergeable=MERGEABLE, head_checks="failing"), ())

    # --- REST's tri-state ---------------------------------------------------------
    check("REST false is CONFLICTING", mergeable_from_rest(False), CONFLICTING)
    check("REST true is MERGEABLE", mergeable_from_rest(True), MERGEABLE)
    check("REST null is UNKNOWN", mergeable_from_rest(None), UNKNOWN)
    check("an integer 0 is not a boolean", mergeable_from_rest(0), UNKNOWN)
    check("an integer 1 is not a boolean", mergeable_from_rest(1), UNKNOWN)
    check("a string is not a boolean", mergeable_from_rest("false"), UNKNOWN)

    # --- episodes: the sentinel is per head -------------------------------------
    told_at_a = [{"body": render_comment(head_sha="aaa", base_ref="main", files=None, files_complete=False)}]
    check("told at head aaa is recognised at aaa", has_sentinel(told_at_a, "aaa"), True)
    check("told at an EARLIER head is an earlier episode", has_sentinel(told_at_a, "bbb"), False)
    check("an empty head never matches", has_sentinel(told_at_a, ""), False)
    check("a comment without the sentinel is not a telling",
          has_sentinel([{"body": "this conflicts, rebase please"}], "aaa"), False)
    # The exit gesture, end to end in pure form: conflict -> told -> rebased and
    # mergeable -> label off -> conflicts again at the new head -> told again.
    episode = [
        acts(),
        acts(labelled=True, has_sentinel=has_sentinel(told_at_a, "aaa")),
        acts(mergeable=MERGEABLE, labelled=True, has_sentinel=has_sentinel(told_at_a, "bbb")),
        acts(has_sentinel=has_sentinel(told_at_a, "ccc")),
    ]
    check("EPISODES: announce, hold, release on rebase, announce the next conflict",
          episode, [(COMMENT, ADD_LABEL), (), (REMOVE_LABEL,), (COMMENT, ADD_LABEL)])

    # --- files on both sides ------------------------------------------------------
    check("intersection of changed files",
          both_sides([{"filename": "a"}, {"filename": "b"}], [{"filename": "b"}, {"filename": "c"}]), ["b"])
    check("a rename on one side conflicts under its OLD name",
          both_sides([{"filename": "old.go"}], [{"filename": "new.go", "previous_filename": "old.go"}]),
          ["old.go"])
    check("nothing in common", both_sides([{"filename": "a"}], [{"filename": "b"}]), [])

    # --- the comment ----------------------------------------------------------------
    text = render_comment(head_sha="abc123", base_ref="main",
                          files=["docs/decisions/history.md"], files_complete=True)
    check("comment carries the sentinel for its head", sentinel("abc123") in text, True)
    check("comment names the exact remedy", REMEDY in text, True)
    check("comment names the file", "`docs/decisions/history.md`" in text, True)
    check("comment names the label", f"`{LABEL}`" in text, True)
    check("comment says the label is not the gate", "pnpm run ci:checks" in text, True)
    check("a complete list does not claim to be incomplete", "may be incomplete" in text, False)
    check("an incomplete list says so",
          "may be incomplete" in render_comment(head_sha="h", base_ref="main", files=["x"], files_complete=False), True)
    unlisted = render_comment(head_sha="h", base_ref="main", files=None, files_complete=False)
    check("unlistable files are SAID, not guessed", "could not be listed" in unlisted, True)
    check("a stacked base is rebased onto its own base",
          "git rebase origin/feature/x &&" in render_comment(
              head_sha="h", base_ref="feature/x", files=None, files_complete=False), True)
    # Untrusted names cannot break out of their code span (N199 review hardening).
    check("code_span: plain", code_span("a/b.ts"), "`a/b.ts`")
    check("code_span: an inner backtick gets a longer fence", code_span("a`b"), "``a`b``")
    check("code_span: a leading backtick is padded", code_span("`x"), "`` `x ``")
    check("code_span: a line break is shown, not obeyed", code_span("a\nb"), "`a\\nb`")
    evil = "x`) [click](https://evil.example) ![i](https://evil.example/i.png) @someone (`"
    hostile = render_comment(head_sha="h", base_ref="main", files=[evil, "ok.ts"], files_complete=True)
    item = next(l for l in hostile.splitlines() if "evil.example" in l)
    check("a hostile file name renders as one code span", item, "- " + code_span(evil))
    check("a hostile file name's line opens with a fence longer than its inner run", item.startswith("- ``"), True)
    nl = render_comment(head_sha="h", base_ref="main", files=["a\nb.ts"], files_complete=True)
    check("a file name with a line break stays on one list item", any(l == "- `a\\nb.ts`" for l in nl.splitlines()), True)
    tick_base = render_comment(head_sha="h", base_ref="rel`x", files=["f"], files_complete=True)
    check("a backtick in the base branch name cannot open a span", "conflicts with ``rel`x``" in tick_base, True)
    capped = render_comment(head_sha="h", base_ref="main", files=[f"f{i}" for i in range(25)], files_complete=True)
    check("a long list is capped and counts the rest", "…and 5 more" in capped, True)
    bot = render_comment(head_sha="h", base_ref="main", files=None, files_complete=False, dependabot=True)
    check("Dependabot is told to rebase itself", "`@dependabot rebase`" in bot, True)
    check("...and is never told to force-push its branch", "--force-with-lease" in bot, False)
    check("...and no line STARTS with the command, so it is never issued by this bot",
          any(l.startswith("@dependabot") for l in bot.splitlines()), False)
    check("no comment can release the evidence latch (/evidence at column zero)",
          any(l.startswith("/evidence") for t in (text, unlisted, bot, capped) for l in t.splitlines()), False)

    # --- repository resolution ----------------------------------------------------------
    def repo(explicit, env, origin):
        try:
            return resolve_repo(explicit, env, origin)
        except SystemExit:
            return "<refused>"

    check("repo: --repo wins", repo("a/b", {"GH_REPO": "c/d"}, ""), "a/b")
    check("repo: GH_REPO", repo(None, {"GH_REPO": "c/d", "GITHUB_REPOSITORY": "e/f"}, ""), "c/d")
    check("repo: GITHUB_REPOSITORY", repo(None, {"GITHUB_REPOSITORY": "e/f"}, ""), "e/f")
    check("repo: origin URL", repo(None, {}, "git@github.com:o/r.git\n"), "o/r")
    check("repo: nothing to go on refuses", repo(None, {}, "https://gitlab.com/o/r.git"), "<refused>")

    # --- REST only -----------------------------------------------------------------------
    for path in ("graphql", "/graphql", "graphql?x=1"):
        try:
            gh_api("POST", path)
            failures.append(f"gh_api: GraphQL path {path!r} was not refused")
        except RuntimeError as err:
            check(f"gh_api refuses {path!r} for the right reason", "REST-only" in str(err), True)
    own = open(__file__, encoding="utf-8").read()
    check("exactly one `gh` subprocess in this file, inside gh_api",
          re.findall(re.escape('["' + 'gh"') + r"[^\]]*\]", own), ['["' + 'gh", "api", "-X", method, path]'])

    # --- the whole sweep, end to end, against a fake transport ----------------------
    old = sentinel("old-head")

    def fixture() -> _FakeGitHub:
        return _FakeGitHub(
            pulls={
                1: [_pull(1, False)],                                  # conflicting, never told
                2: [_pull(2, True, labelled=True)],                    # rebased: label comes off
                3: [_pull(3, None)],                                   # never computed
                4: [_pull(4, None), _pull(4, False)],                  # computed on the re-read
                5: [_pull(5, False, labelled=True)],                   # already announced
                6: [_pull(6, False, draft=True)],                      # a draft
                7: [_pull(7, False)],                                  # told at this head, label lost
                8: [_pull(8, False)],                                  # told at an older head
                9: [_pull(9, False, user=DEPENDABOT)],                 # a Dependabot branch
            },
            comments={
                5: [{"body": sentinel("head5")}],
                7: [{"body": sentinel("head7")}],
                8: [{"body": old}],
            },
            pr_files={1: [{"filename": "docs/decisions/history.md"}, {"filename": "a.go"}]},
            base_files=[{"filename": "docs/decisions/history.md"},
                        {"filename": "b.go", "previous_filename": "a.go"}],
            closed=[{"number": 20, "pull_request": {}, "labels": [{"name": LABEL}]},
                    {"number": 21, "labels": [{"name": LABEL}]}],  # an ISSUE, not a PR
        )

    fake = fixture()
    slept: list[int] = []
    client = Client("o/r", dry_run=False, transport=fake)
    with contextlib.redirect_stdout(io.StringIO()):
        code = sweep(client, sleep=slept.append)
    check("E2E: the sweep exits 0", code, 0)
    check("E2E: exactly these writes, in this order", fake.writes(), [
        "POST repos/o/r/issues/1/comments",
        "POST repos/o/r/labels",
        "POST repos/o/r/issues/1/labels",
        f"DELETE repos/o/r/issues/2/labels/{LABEL}",
        "POST repos/o/r/issues/4/comments",
        "POST repos/o/r/issues/4/labels",
        "POST repos/o/r/issues/6/comments",
        "POST repos/o/r/issues/6/labels",
        "POST repos/o/r/issues/7/labels",
        "POST repos/o/r/issues/8/comments",
        "POST repos/o/r/issues/8/labels",
        "POST repos/o/r/issues/9/comments",
        "POST repos/o/r/issues/9/labels",
        f"DELETE repos/o/r/issues/20/labels/{LABEL}",
    ])
    check("E2E: nulls are re-read with every delay before giving up", slept, list(MERGEABLE_RETRY_DELAYS))
    check("E2E: a PR null throughout is read once per delay plus once", fake.reads[3], 1 + len(MERGEABLE_RETRY_DELAYS))
    check("E2E: a PR that answered is not re-read again", fake.reads[4], 2)
    body1 = "\n".join(fake.bodies(1))
    check("E2E: the comment names the files changed on both sides",
          "`docs/decisions/history.md`" in body1 and "`a.go`" in body1 and "`b.go`" not in body1, True)
    check("E2E: the comment is stamped with the head it was written at", sentinel("head1") in body1, True)
    check("E2E: the Dependabot comment points at Dependabot",
          "`@dependabot rebase`" in "\n".join(fake.bodies(9)), True)
    check("E2E: the label is added with the label name",
          [f for m, p, f, _ in fake.calls if p == "repos/o/r/issues/1/labels"], [{"labels[]": LABEL}])

    rerun = fixture()
    rerun.label_exists = True
    rerun.pulls[1] = [_pull(1, False, labelled=True)]
    rerun.comments[1] = [{"body": body1}]
    with contextlib.redirect_stdout(io.StringIO()):
        sweep(Client("o/r", dry_run=False, transport=rerun), sleep=lambda _d: None)
    check("E2E: the next run on the same state never comments on #1 again",
          [w for w in rerun.writes() if "/issues/1/" in w], [])
    check("E2E: an existing label is not re-created", "POST repos/o/r/labels" in rerun.writes(), False)

    dry = fixture()
    dry_client = Client("o/r", dry_run=True, transport=dry)
    with contextlib.redirect_stdout(io.StringIO()):
        dry_code = sweep(dry_client, sleep=lambda _d: None, with_checks=True)
    # Exit 0 proves `_do` never even ATTEMPTED a write: an attempt would be
    # refused by `Client.write` and counted as an error. Without this, the
    # second guard would mask a broken first one and the test would stay green.
    check("DRY RUN: the sweep exits 0, so no write was even attempted", dry_code, 0)
    check("DRY RUN: not one non-GET call reaches the transport", dry.writes(), [])
    check("DRY RUN: it still reports what it would do",
          "would comment on #1" in dry_client.performed and f"would remove `{LABEL}` from #2" in dry_client.performed,
          True)
    try:
        Client("o/r", dry_run=True, transport=dry).write("POST", "repos/o/r/issues/1/comments", body="x")
        failures.append("DRY RUN: Client.write did not refuse")
    except RuntimeError as err:
        check("DRY RUN: the transport-level guard refuses on its own", "dry run: refusing" in str(err), True)

    # The token must be able to WRITE to pull requests (N199 follow-up). Measured on
    # the first live run, 35001451760: with `issues: write` and `pull-requests:
    # read`, POST /issues/{pr}/comments on a pull request returned 403.
    sample = "on:\n  push:\npermissions:\n  # c\n  contents: read\n\n  pull-requests: write  # x\njobs:\n  a:\n    permissions:\n      issues: none\n"
    check("workflow_permissions: reads the top-level block, skipping comments and blanks",
          workflow_permissions(sample), {"contents": "read", "pull-requests": "write"})
    check("workflow_permissions: no top-level block reads as empty", workflow_permissions("jobs:\n  a:\n    permissions:\n      x: write\n"), {})
    wf = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "conflict-label.yml"
    if wf.is_file():
        perms = workflow_permissions(wf.read_text())
        check("conflict-label.yml grants pull-requests: write (a PR comment 403s without it)", perms.get("pull-requests"), "write")
        check("conflict-label.yml grants issues: write (creating the label)", perms.get("issues"), "write")
        check("conflict-label.yml grants no write beyond pull-requests and issues",
              sorted(k for k, v in perms.items() if v == "write"), ["issues", "pull-requests"])
    else:
        failures.append(f"conflict-label.yml not found at {wf}")

    if failures:
        print(f"conflict-label self-test: {len(failures)} FAILED", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("conflict-label self-test: all checks passed")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--self-test", action="store_true", help="pure logic and a faked sweep, no network")
    mode.add_argument("--dry-run", action="store_true",
                      help="read the live repository and print what would be done; writes nothing")
    mode.add_argument("--execute", action="store_true",
                      help="label, comment and unlabel for real (what the workflow runs)")
    p.add_argument("--repo", help="owner/name; defaults to GH_REPO, GITHUB_REPOSITORY, then origin")
    args = p.parse_args()

    if args.self_test:
        return self_test()
    if not (args.dry_run or args.execute):
        # No default mode: a bare run by hand must not write to the live repository.
        p.error("pass --dry-run to see what would happen, or --execute to act")

    client = Client(resolve_repo(args.repo, os.environ, _origin_url()), dry_run=args.dry_run)
    try:
        return sweep(client, with_checks=args.dry_run)
    except (RuntimeError, OSError) as err:
        print(f"conflict-label: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
