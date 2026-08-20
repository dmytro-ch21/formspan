#!/usr/bin/env python3
"""Reopen an issue that closed while its human-evidence criteria were unmet.

## The failure this prevents

`closes #N` in a PR body fires on merge. That is correct for a ticket the diff
finishes, and **wrong for every ticket carrying a `NEEDS HUMAN EVIDENCE`
criterion** — where the code has landed and the evidence has not. That is not an
edge case; it is the normal end state for device-reported work, which is most of
what this project's athlete actually notices.

On 2026-08-20 six tickets closed that way and were reopened by hand: #414, #365,
#406, #434, #444, #388. Five more were closed the same day with an unmet
evidence criterion and were NOT reopened — #388, #402, #409, #433, #446 — because
nobody happened to be watching those merges. **A closed ticket is the one state
nobody re-reads**, so its outstanding criteria go with it.

GitHub cannot be told not to close. So this does not fight the merge: it converts
the wrong close back into the right state within seconds, automatically, which is
the same action a human performed six times by hand that day.

Because it keys on the **close event** rather than on a merge, it also catches an
issue closed by somebody clicking — the #380 / #423 shape — at no extra cost.

## Two rules that are load-bearing, and why each is measured rather than assumed

### 1. Only a CHECKBOX is a criterion. A mention is not.

Measured across all 88 issues: 30 issue bodies contain the phrase, in 31 places.
**28 of them are criteria** — a checkbox whose text OPENS with the marker, in one
of four punctuation forms all present in the corpus:

    - [ ] **NEEDS HUMAN EVIDENCE** — exercised on a real device
    - [ ] **NEEDS HUMAN EVIDENCE:** seen on a device, both belts
    - [ ] **NEEDS HUMAN EVIDENCE — demonstrated firing on a REAL PR**
    - [ ] NEEDS HUMAN EVIDENCE: `/_search` returns the row

The other three are **mentions**, and a naive substring search latches all three
wrongly:

  * #456 in prose — "It is wrong for every ticket carrying a `NEEDS HUMAN
    EVIDENCE` criterion";
  * #456 and #410 mid-checkbox — a criterion that *refers* to the concept while
    asking for something a diff can settle.

Both live vectors are in `--self-test` as must-not-match cases. This matters more
than it looks: #456 is the ticket that asked for this mechanism, so **every future
ticket that merely discusses the feature would be reopened forever** under the
naive rule — the never-opens-gate failure arriving through the front door.

### 2. The gate has to be SATISFIABLE, and the obvious exit gesture is not.

This repo has a standing rule about verifying a check *can fail*. Pointed the
other way it is just as sharp, and it killed this script's first design.

**Measured: 0 of 415 acceptance-criteria checkboxes in this repo's entire issue
history have ever been ticked.** Not the evidence ones — *any* of them. So
"tick the box to release the latch" would have been an exit gesture nobody has
ever performed, and a gate that never opens gets ripped out within a week —
taking the problem it solved with it.

The exit is therefore an **attestation comment**, which is a gesture people
already make:

    /evidence ran it on the 15 Pro, both belts, expanded and collapsed — labels
    stay above the keyboard

The observation is **required**, and that requirement is the whole value. A bare
`/done` is deliberately REJECTED (see `parse_attestation`): it would recreate the
tick-box in a costume — an assertion that evidence exists, with no record of what
was seen. Do not add it later as a convenience.

Ticking the boxes by hand also works, because it is the natural gesture even if
it is currently unused; it is the second path, not the primary one.

## The silent majority path stays silent

Most closes are legitimate. An issue with no unticked evidence criterion is not
touched, not labelled and not commented on. A gate that chirps on ordinary
tickets becomes noise and gets muted, which is the same death as one that never
opens.

## Why the logic is here and not inline in the workflow YAML

`issues:` events **always run the workflow from the default branch**. A design
with its logic inline in the YAML could not be exercised until after it landed —
untestable in the way that matters. Everything below runs standalone against the
real API (`--issue N --simulate ...`) and its decisions are pure functions with
no network at all (`--self-test`).

Stdlib-only, matching its siblings, so the `Scripts (Python)` CI job needs no
toolchain. I/O goes through `gh`, which the runner image ships and a developer
machine already has authenticated.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field

MARKER = "NEEDS HUMAN EVIDENCE"
LABEL = "evidence-outstanding"
LABEL_COLOR = "d93f0b"
LABEL_DESC = "Code merged, human evidence not yet produced"

DEFAULT_REPO = "dmytro-ch21/formspan"

# A markdown task list item. GitHub accepts `-` and `*` and any indentation.
CHECKBOX_RE = re.compile(r"^[ \t]*[-*][ \t]+\[([ xX])\][ \t]*(.*)$", re.MULTILINE)

# `/evidence <observation>`, at the start of a line so it cannot be triggered by
# somebody quoting the instruction mid-paragraph.
ATTEST_RE = re.compile(r"^[ \t]*/evidence\b[ \t:]*(.*)$", re.MULTILINE)

# Forms deliberately NOT accepted, answered with guidance instead of silence.
REJECTED_RE = re.compile(r"^[ \t]*/(done|verified|evidence-done|ok)\b.*$", re.MULTILINE)

# An observation shorter than this is not an observation.
MIN_OBSERVATION = 8


# --------------------------------------------------------------------------
# Pure logic. Everything below this line to `# --- I/O ---` is network-free and
# is what `--self-test` exercises.
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Criterion:
    checked: bool
    text: str
    line: int


def _strip_emphasis(text: str) -> str:
    """Drop markdown emphasis and code ticks so the marker is comparable.

    The corpus wraps the marker four different ways (`**X**`, `**X:**`, bare
    `X:`, `**X —`). Removing the decoration is what makes one rule cover all of
    them without a regex that enumerates punctuation it has not seen yet.
    """
    return re.sub(r"[*_`]", "", text).strip()


def is_evidence_criterion(checkbox_text: str) -> bool:
    """True when this checkbox IS an evidence criterion, not one that mentions one.

    The distinction is positional and that is the entire rule: the marker OPENS
    the criterion. A checkbox that refers to `NEEDS HUMAN EVIDENCE` while asking
    for something else is a mention, and latching on it is how this mechanism
    would reopen every ticket that discusses it.
    """
    return _strip_emphasis(checkbox_text).upper().startswith(MARKER)


def evidence_criteria(body: str | None) -> list[Criterion]:
    """Every evidence criterion in an issue body, checked or not."""
    out: list[Criterion] = []
    for m in CHECKBOX_RE.finditer(body or ""):
        if is_evidence_criterion(m.group(2)):
            line = (body or "").count("\n", 0, m.start())
            out.append(Criterion(m.group(1).lower() == "x", m.group(2).strip(), line))
    return out


def outstanding(body: str | None) -> list[Criterion]:
    """Evidence criteria still unticked — the reason to latch."""
    return [c for c in evidence_criteria(body) if not c.checked]


def tick_evidence(body: str) -> str:
    """Tick every evidence checkbox, leaving ordinary criteria alone.

    Run on attestation so the ticket's own record matches what happened. Only
    evidence boxes move: an attestation says the device checks were run, not
    that every criterion on the ticket was satisfied.
    """

    def repl(m: re.Match[str]) -> str:
        if not is_evidence_criterion(m.group(2)):
            return m.group(0)
        return m.group(0).replace("[ ]", "[x]", 1)

    return CHECKBOX_RE.sub(repl, body or "")


@dataclass(frozen=True)
class Attestation:
    kind: str  # "evidence" | "empty" | "rejected"
    observation: str = ""


def parse_attestation(comment: str | None) -> Attestation | None:
    """Read an attestation out of a comment, or None if it is an ordinary one.

    `/done` and friends are matched ON PURPOSE rather than ignored. Silence
    there would read as the mechanism being broken, and the person would try
    again or give up; `rejected` lets the caller answer with the right form.
    """
    text = comment or ""
    m = ATTEST_RE.search(text)
    if m:
        observation = m.group(1).strip().strip("`\"'")
        if len(observation) < MIN_OBSERVATION:
            return Attestation("empty")
        return Attestation("evidence", observation)
    if REJECTED_RE.search(text):
        return Attestation("rejected")
    return None


@dataclass(frozen=True)
class Action:
    kind: str  # "latch" | "relatch" | "resolve" | "guidance" | "noop"
    reason: str = ""
    criteria: tuple[Criterion, ...] = field(default=())
    observation: str = ""


def decide(
    *,
    event: str,
    state: str,
    state_reason: str | None,
    body: str | None,
    labelled: bool,
    comment: str | None = None,
    actor_is_bot: bool = False,
    is_pull_request: bool = False,
) -> Action:
    """The whole state machine, as one pure function.

    Kept pure precisely so the interesting cases are testable without a network,
    a repository, or a merge.
    """
    if is_pull_request:
        return Action("noop", "pull requests are not tickets")
    if actor_is_bot:
        return Action("noop", "ignoring a bot actor, so the latch cannot answer itself")

    unmet = tuple(outstanding(body))

    if event == "closed":
        # `not_planned` is a deliberate decision that the work is not happening.
        # Outstanding evidence is irrelevant to it, and reopening would overrule
        # a human on purpose.
        if state_reason == "not_planned":
            return Action("noop", "closed as not planned, which is a decision, not a slip")
        if not unmet:
            # The silent majority. No label, no comment, no trace.
            return Action("noop", "no unmet evidence criteria")
        return Action("relatch" if labelled else "latch", "closed with evidence outstanding", unmet)

    if event == "comment":
        if not labelled:
            return Action("noop", "not awaiting evidence")
        att = parse_attestation(comment)
        if att is None:
            return Action("noop", "ordinary comment")
        if att.kind == "evidence":
            return Action("resolve", "attested", unmet, att.observation)
        if att.kind == "empty":
            return Action("guidance", "attestation carried no observation", unmet)
        return Action("guidance", "unsupported form; an observation is required", unmet)

    if event == "edited":
        if not labelled:
            return Action("noop", "not awaiting evidence")
        if unmet:
            return Action("noop", "evidence criteria still outstanding")
        if not evidence_criteria(body):
            # Every evidence criterion was deleted rather than satisfied. Do not
            # treat that as evidence: drop the label so the board is honest, but
            # do not close on the strength of a body edit that removed the ask.
            return Action("guidance", "evidence criteria were removed, not ticked")
        return Action("resolve", "all evidence criteria ticked by hand", ())

    return Action("noop", f"unhandled event {event!r}")


def render_latch_comment(criteria: tuple[Criterion, ...], *, again: bool) -> str:
    lines = [c.text for c in criteria]
    checklist = "\n".join(f"{i}. {t}" for i, t in enumerate(lines, 1))
    if again:
        return (
            f"**Still awaiting evidence — reopened again.**\n\n{checklist}\n\n"
            f"When you have run these, reply with what you saw:\n\n"
            f"    /evidence <what you observed>\n"
        )
    return (
        f"**Reopened: the code merged, the evidence has not been produced.**\n\n"
        f"This ticket closed automatically, and it carries "
        f"{len(lines)} criterion that a diff cannot settle:\n\n"
        f"{checklist}\n\n"
        f"---\n\n"
        f"It is now labelled `{LABEL}` — merged, awaiting evidence — and will show "
        f"in that board view rather than sitting closed where nobody re-reads it.\n\n"
        f"**To finish it**, reply with what you actually saw:\n\n"
        f"    /evidence ran it on the 15 Pro, both belts — labels stay above the keyboard\n\n"
        f"That ticks the criteria above, drops the label and closes this ticket. "
        f"The observation is required: a bare `/done` is rejected on purpose, "
        f"because a ticket saying evidence exists without saying what was seen is "
        f"the tick-box this mechanism replaced.\n"
    )


def render_resolve_comment(observation: str) -> str:
    return (
        f"**Evidence recorded — closing.**\n\n> {observation}\n\n"
        f"Evidence criteria ticked, `{LABEL}` removed.\n"
    )


def render_guidance_comment(action: Action) -> str:
    if action.reason.startswith("evidence criteria were removed"):
        return (
            f"The evidence criteria were removed from this ticket rather than ticked, "
            f"so `{LABEL}` has been dropped, but it has not been closed — deleting the "
            f"ask is not the same as answering it. Close it by hand if that was intended."
        )
    checklist = "\n".join(f"{i}. {c.text}" for i, c in enumerate(action.criteria, 1))
    return (
        f"That does not release the latch, because it does not say what you saw.\n\n"
        f"    /evidence <what you observed>\n\n"
        f"Still outstanding:\n\n{checklist}\n"
    )


# --------------------------------------------------------------------------
# --- I/O ---
# --------------------------------------------------------------------------


def gh(*args: str, check: bool = True, stdin: str | None = None) -> str:
    proc = subprocess.run(
        ["gh", *args], capture_output=True, text=True, input=stdin
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def gh_json(*args: str):
    return json.loads(gh(*args) or "null")


class Client:
    def __init__(self, repo: str, dry_run: bool):
        self.repo = repo
        self.dry_run = dry_run
        self.performed: list[str] = []

    def _do(self, description: str, fn) -> None:
        if self.dry_run:
            print(f"    would {description}")
            self.performed.append(f"would {description}")
            return
        fn()
        print(f"    {description}")
        self.performed.append(description)

    def issue(self, number: int) -> dict:
        return gh_json("api", f"repos/{self.repo}/issues/{number}")

    def ensure_label(self) -> None:
        proc = subprocess.run(
            ["gh", "api", f"repos/{self.repo}/labels/{LABEL}"],
            capture_output=True, text=True,
        )
        if proc.returncode == 0:
            return
        self._do(
            f"create the `{LABEL}` label",
            lambda: gh(
                "api", "-X", "POST", f"repos/{self.repo}/labels",
                "-f", f"name={LABEL}", "-f", f"color={LABEL_COLOR}",
                "-f", f"description={LABEL_DESC}",
            ),
        )

    def reopen(self, n: int) -> None:
        self._do(
            f"reopen #{n}",
            lambda: gh("api", "-X", "PATCH", f"repos/{self.repo}/issues/{n}", "-f", "state=open"),
        )

    def close(self, n: int) -> None:
        self._do(
            f"close #{n} as completed",
            lambda: gh(
                "api", "-X", "PATCH", f"repos/{self.repo}/issues/{n}",
                "-f", "state=closed", "-f", "state_reason=completed",
            ),
        )

    def add_label(self, n: int) -> None:
        self._do(
            f"label #{n} `{LABEL}`",
            lambda: gh(
                "api", "-X", "POST", f"repos/{self.repo}/issues/{n}/labels",
                "-f", f"labels[]={LABEL}",
            ),
        )

    def remove_label(self, n: int) -> None:
        self._do(
            f"remove `{LABEL}` from #{n}",
            lambda: gh(
                "api", "-X", "DELETE", f"repos/{self.repo}/issues/{n}/labels/{LABEL}",
                check=False,
            ),
        )

    def comment(self, n: int, body: str) -> None:
        self._do(
            f"comment on #{n}",
            lambda: gh("api", "-X", "POST", f"repos/{self.repo}/issues/{n}/comments",
                       "-F", "body=@-", stdin=body),
        )

    def set_body(self, n: int, body: str) -> None:
        self._do(
            f"tick the evidence criteria on #{n}",
            lambda: gh("api", "-X", "PATCH", f"repos/{self.repo}/issues/{n}",
                       "-F", "body=@-", stdin=body),
        )


def apply(client: Client, number: int, issue: dict, action: Action) -> int:
    print(f"  #{number}: {action.kind.upper()} — {action.reason}")
    if action.kind == "noop":
        return 0
    if action.kind in ("latch", "relatch"):
        client.ensure_label()
        client.reopen(number)
        if action.kind == "latch":
            client.add_label(number)
        client.comment(number, render_latch_comment(action.criteria, again=action.kind == "relatch"))
        return 0
    if action.kind == "resolve":
        if action.observation:
            client.set_body(number, tick_evidence(issue.get("body") or ""))
        client.remove_label(number)
        client.comment(number, render_resolve_comment(
            action.observation or "all evidence criteria ticked on the ticket"))
        client.close(number)
        return 0
    if action.kind == "guidance":
        if action.reason.startswith("evidence criteria were removed"):
            client.remove_label(number)
        client.comment(number, render_guidance_comment(action))
        return 0
    return 0


# --------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------


def from_event(client: Client, path: str) -> int:
    with open(path) as fh:
        payload = json.load(fh)

    name = os.environ.get("GITHUB_EVENT_NAME", "")
    action_name = payload.get("action", "")
    raw_issue = payload.get("issue") or {}
    number = raw_issue.get("number")
    if number is None:
        print("no issue in payload; nothing to do")
        return 0

    if name == "issue_comment":
        event = "comment"
    elif action_name in ("closed", "edited"):
        event = action_name
    else:
        print(f"event {name}/{action_name} is not one this latch acts on")
        return 0

    comment = (payload.get("comment") or {}).get("body")
    actor = ((payload.get("comment") or {}).get("user") or {}).get("type", "")

    # Re-read the issue rather than trusting the payload: an `edited` payload is
    # a snapshot, and two edits in quick succession would otherwise be decided
    # against the older one.
    issue = client.issue(number)
    act = decide(
        event=event,
        state=issue.get("state", ""),
        state_reason=issue.get("state_reason"),
        body=issue.get("body"),
        labelled=any(l["name"] == LABEL for l in issue.get("labels", [])),
        comment=comment,
        actor_is_bot=actor == "Bot",
        is_pull_request="pull_request" in raw_issue,
    )
    return apply(client, number, issue, act)


def simulate(client: Client, number: int, event: str, comment: str | None) -> int:
    issue = client.issue(number)
    act = decide(
        event=event,
        state=issue.get("state", ""),
        state_reason=issue.get("state_reason"),
        body=issue.get("body"),
        labelled=any(l["name"] == LABEL for l in issue.get("labels", [])),
        comment=comment,
        is_pull_request="pull_request" in issue,
    )
    return apply(client, number, issue, act)


def backfill(client: Client) -> int:
    """List (and optionally reopen) issues already closed with evidence outstanding.

    Always run `--dry-run` first and get the list approved. Reopening several
    tickets is a bulk board move, and this repo's `ticket-manager` convention
    says bulk moves get confirmed.
    """
    raw = gh("api", "--paginate", f"repos/{client.repo}/issues?state=closed&per_page=100")
    decoder, items, i = json.JSONDecoder(), [], 0
    while i < len(raw):
        while i < len(raw) and raw[i].isspace():
            i += 1
        if i >= len(raw):
            break
        chunk, i = decoder.raw_decode(raw, i)
        items += chunk

    hits = [
        x for x in items
        if "pull_request" not in x
        and x.get("state_reason") != "not_planned"
        and outstanding(x.get("body"))
    ]
    hits.sort(key=lambda x: x["number"])
    print(f"{len(hits)} closed issue(s) with an unticked evidence criterion:\n")
    for x in hits:
        print(f"  #{x['number']}  {x['title'][:70]}")
        print(f"          closed {x['closed_at'][:10]} as {x.get('state_reason')}")
        for c in outstanding(x.get("body")):
            print(f"          · {c.text[:96]}")
    if client.dry_run:
        print("\n(dry run — nothing changed)")
        return 0
    for x in hits:
        apply(client, x["number"], x,
              Action("latch", "backfill: closed with evidence outstanding",
                     tuple(outstanding(x.get("body")))))
    return 0


# --------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------

# Real lines from this repository, so the parser is tested against its actual
# input rather than against input invented to suit it.
REAL_CRITERIA = [
    "- [ ] **NEEDS HUMAN EVIDENCE** — exercised on a real device, with the web app closed.",
    "- [ ] **NEEDS HUMAN EVIDENCE:** seen on a device, both belts, expanded and collapsed.",
    "- [ ] **NEEDS HUMAN EVIDENCE — demonstrated firing on a REAL ready-for-review PR.**",
    "- [ ] NEEDS HUMAN EVIDENCE: `/_search` returns the row.",
    "- [ ] **NEEDS HUMAN EVIDENCE — the decisive experiment is run: all 20 tests active.**",
]

# Every real occurrence in the corpus that is NOT a criterion. A naive substring
# search matches all three, and reopens every ticket that discusses the feature.
REAL_MENTIONS = [
    "**It is wrong for every ticket carrying a `NEEDS HUMAN EVIDENCE` criterion** — where the code has landed and the evidence has not.",
    "- [ ] A PR can land its code without closing a ticket whose `NEEDS HUMAN EVIDENCE` criteria are outstanding — without relying on anyone remembering to omit `closes`.",
    "- [ ] The staleness boundary is established — what makes a session pick up a `NEEDS HUMAN EVIDENCE` agent definition.",
]


def self_test() -> int:
    failures: list[str] = []

    def check(name: str, got, want) -> None:
        if got != want:
            failures.append(f"{name}: got {got!r}, wanted {want!r}")

    # --- the positional rule, against real input --------------------------
    for line in REAL_CRITERIA:
        check(f"criterion recognised: {line[:44]}", len(evidence_criteria(line)), 1)
        check(f"criterion outstanding: {line[:44]}", len(outstanding(line)), 1)
    for line in REAL_MENTIONS:
        check(f"mention must NOT match: {line[:44]}", evidence_criteria(line), [])

    check("ticked criterion is not outstanding",
          outstanding("- [x] **NEEDS HUMAN EVIDENCE** — seen on a device."), [])
    check("ticked criterion is still a criterion",
          len(evidence_criteria("- [x] **NEEDS HUMAN EVIDENCE** — seen.")), 1)
    check("ordinary criterion is not an evidence criterion",
          evidence_criteria("- [ ] The audit row is updated from `open` to the PR."), [])
    check("body with no checkboxes at all", outstanding("just prose about the marker"), [])
    check("empty body", outstanding(None), [])
    check("`*` bullets are checkboxes too",
          len(outstanding("* [ ] **NEEDS HUMAN EVIDENCE** — on a device.")), 1)
    check("indented checkbox counts",
          len(outstanding("  - [ ] **NEEDS HUMAN EVIDENCE** — on a device.")), 1)

    # --- ticking ----------------------------------------------------------
    body = ("## Acceptance criteria\n\n"
            "- [ ] The audit row is updated.\n"
            "- [ ] **NEEDS HUMAN EVIDENCE** — seen on a device.\n")
    ticked = tick_evidence(body)
    check("tick marks the evidence box", "- [x] **NEEDS HUMAN EVIDENCE**" in ticked, True)
    check("tick leaves ordinary criteria alone", "- [ ] The audit row is updated." in ticked, True)
    check("tick is idempotent", tick_evidence(ticked), ticked)
    check("ticked body has nothing outstanding", outstanding(ticked), [])

    # --- attestation ------------------------------------------------------
    check("attestation with an observation",
          parse_attestation("/evidence ran it on the 15 Pro, labels stay put"),
          Attestation("evidence", "ran it on the 15 Pro, labels stay put"))
    check("attestation may be preceded by prose lines",
          parse_attestation("Did the run just now.\n/evidence both belts, expanded and collapsed").kind,
          "evidence")
    check("bare /evidence carries no observation", parse_attestation("/evidence").kind, "empty")
    check("too-short observation rejected", parse_attestation("/evidence ok").kind, "empty")
    check("/done is rejected, not silently ignored", parse_attestation("/done").kind, "rejected")
    check("/verified is rejected", parse_attestation("/verified").kind, "rejected")
    check("ordinary comment is not an attestation", parse_attestation("looks good to me"), None)
    check("mid-line /evidence does not trigger",
          parse_attestation("reply with /evidence <what you saw> when done"), None)

    # --- the state machine ------------------------------------------------
    unmet = "- [ ] **NEEDS HUMAN EVIDENCE** — seen on a device."
    met = "- [x] **NEEDS HUMAN EVIDENCE** — seen on a device."
    plain = "- [ ] The audit row is updated."

    def d(**kw):
        base = dict(event="closed", state="closed", state_reason="completed",
                    body=unmet, labelled=False)
        base.update(kw)
        return decide(**base).kind

    check("closed with evidence outstanding latches", d(), "latch")
    check("closed again while latched re-latches", d(labelled=True), "relatch")
    check("SILENT MAJORITY: ordinary ticket is untouched", d(body=plain), "noop")
    check("SILENT MAJORITY: no criteria at all", d(body="narrative only"), "noop")
    check("already-satisfied evidence closes normally", d(body=met), "noop")
    check("closed as not planned is left alone", d(state_reason="not_planned"), "noop")
    check("a pull request is never a ticket", d(is_pull_request=True), "noop")
    check("attestation on a latched issue resolves",
          d(event="comment", labelled=True, comment="/evidence saw it on the device"), "resolve")
    check("attestation on an unlatched issue does nothing",
          d(event="comment", labelled=False, comment="/evidence saw it on the device"), "noop")
    check("bare /evidence gets guidance",
          d(event="comment", labelled=True, comment="/evidence"), "guidance")
    check("/done gets guidance, not a close",
          d(event="comment", labelled=True, comment="/done"), "guidance")
    check("ordinary comment on a latched issue is silent",
          d(event="comment", labelled=True, comment="nice one"), "noop")
    check("the latch never answers its own comment",
          d(event="comment", labelled=True, comment="/evidence saw it on the device",
            actor_is_bot=True), "noop")
    check("ticking every box by hand resolves",
          d(event="edited", labelled=True, body=met), "resolve")
    check("editing while still outstanding does nothing",
          d(event="edited", labelled=True, body=unmet), "noop")
    check("deleting the criteria does not count as evidence",
          d(event="edited", labelled=True, body=plain), "guidance")
    check("edit on an unlabelled issue does nothing",
          d(event="edited", labelled=False, body=unmet), "noop")

    # --- the comment a human actually reads -------------------------------
    crit = tuple(outstanding(unmet))
    latch_text = render_latch_comment(crit, again=False)
    check("latch comment names the outstanding criterion",
          "seen on a device" in latch_text, True)
    check("latch comment gives the exit gesture", "/evidence" in latch_text, True)
    check("latch comment says a bare /done is refused", "`/done`" in latch_text, True)
    check("resolve comment quotes the observation",
          "> ran it twice" in render_resolve_comment("ran it twice"), True)

    if failures:
        print(f"evidence-latch self-test: {len(failures)} FAILED", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("evidence-latch self-test: all checks passed")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--self-test", action="store_true", help="pure-logic tests, no network")
    p.add_argument("--event-file", help="a GitHub Actions event payload (what the workflow passes)")
    p.add_argument("--issue", type=int, help="act on one issue, reading its live state")
    p.add_argument("--simulate", choices=["closed", "edited", "comment"], default="closed",
                   help="which event to decide as, with --issue")
    p.add_argument("--comment", help="comment body, with --simulate comment")
    p.add_argument("--backfill", action="store_true",
                   help="issues already closed with evidence outstanding")
    p.add_argument("--dry-run", action="store_true", help="decide and print, change nothing")
    p.add_argument("--repo", default=os.environ.get("GH_REPO", DEFAULT_REPO))
    args = p.parse_args()

    if args.self_test:
        return self_test()

    client = Client(args.repo, args.dry_run)
    if args.backfill:
        return backfill(client)
    if args.event_file:
        return from_event(client, args.event_file)
    if args.issue:
        return simulate(client, args.issue, args.simulate, args.comment)
    p.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
