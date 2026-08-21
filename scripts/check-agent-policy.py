#!/usr/bin/env python3
"""Validate the `.vola-agent/` policy contract, and prove the validation can fail.

## What `.vola-agent/` is

The machine-readable half of the AI-SDLC dev engine: `policy.json` (budgets,
human-gated paths/labels, auto-merge posture), `risk-rules.json` (raise-only
risk classification), `context-map.json` (path → docs/traps/gates for the
context builder), and `ticket-schema.md` (the required ticket sections the
dispatcher enforces). The engine consumes these; humans review changes to them
in PRs like any code. JSON rather than YAML on purpose — this script stays
stdlib-only (the `check:python` convention) and the Go engine reads it with
`encoding/json`, so neither side grows a dependency.

## Why a validator, and why it self-tests on every run

A policy file nothing parses is prose wearing a file extension: a typo'd path
in `human_gate.paths` would silently gate nothing, and `raise_only` flipping to
false would let an agent lower a risk a human wrote on a ticket — both invisible
to every other check in the repo. And per the repo's "verify that a check can
fail" rule, this script does not merely validate: on EVERY run it first mutates
copies of the real files (drops a required key, invents a risk level, points at
a path that does not exist, deletes a required heading, flips `raise_only`) and
asserts each mutation is caught. A validator that cannot go red is the
absence-reads-as-answer failure wearing a new hat.

## Deliberate rigidities

Two values are asserted, not just type-checked, so relaxing them is a two-file
change somebody has to argue for in review rather than a config drift:
- `auto_merge.enabled` must be false until the circuit-breaker/merge-policy
  engine exists (the phased rollout: V1 is human-merge always).
- `require_clean_tree` and `require_acceptance_criteria` must be true — both
  restate hard rules that predate the engine.
- `human_gate.paths` must keep `backend/internal/platform/auth/**` and
  `backend/migrations/**`: those two are the non-negotiable floor.

Like its siblings, this reads structure, not behaviour: it proves the files are
well-formed and internally consistent, not that the engine honours them.
"""

from __future__ import annotations

import json
import posixpath
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT_DIR = ".vola-agent"
RISK_LEVELS = ("low", "medium", "high")
REQUIRED_HEADINGS = (
    "## Athlete outcome",
    "## Scope",
    "## Acceptance criteria",
    "## Non-regressions",
    "## Test plan",
    "## Human evidence",
    "## Risk",
)
# The human-gate floor: paths that may never quietly leave the list.
REQUIRED_HUMAN_GATE_PATHS = (
    "backend/internal/platform/auth/**",
    "backend/migrations/**",
)


def glob_prefix(pattern: str) -> str:
    """The literal path before any glob character — what must exist on disk."""
    for i, ch in enumerate(pattern):
        if ch in "*?[":
            return pattern[:i].rstrip("/")
    return pattern


def check_path_pattern(pattern: str, repo_root: Path, where: str, errors: list[str]) -> None:
    prefix = glob_prefix(pattern)
    if not prefix:
        errors.append(f"{where}: pattern {pattern!r} has no literal prefix to check")
        return
    # Exactly two pattern forms exist: a literal path, or `<dir>/**`. The Go
    # engine's PathMatches implements only those two and treats ANY glob as
    # "everything under the prefix" — so a pattern like `apps/mobile/*.json`
    # would silently gate far more than it says. Rejecting other forms here is
    # what turns that doc comment into a checked property. Found in review.
    if pattern != prefix and pattern != prefix + "/**":
        errors.append(
            f"{where}: {pattern!r} — patterns must be a literal path or '<dir>/**'; "
            "any other glob is read as the whole prefix by the engine"
        )
        return
    if not (repo_root / prefix).exists():
        # A gated path that does not exist gates nothing — the typo'd-glob hole.
        errors.append(f"{where}: {pattern!r} — {prefix!r} does not exist in the repo")


def load_json(path: Path, errors: list[str]) -> dict | None:
    if not path.exists():
        errors.append(f"{path.name}: missing")
        return None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        errors.append(f"{path.name}: not valid JSON — {e}")
        return None
    if not isinstance(data, dict):
        errors.append(f"{path.name}: top level must be an object")
        return None
    return data


def validate_policy(agent_dir: Path, repo_root: Path) -> list[str]:
    errors: list[str] = []
    data = load_json(agent_dir / "policy.json", errors)
    if data is None:
        return errors

    if data.get("version") != 1:
        errors.append("policy.json: version must be 1")
    if not isinstance(data.get("base_branch"), str) or not data.get("base_branch"):
        errors.append("policy.json: base_branch must be a non-empty string")
    for key in ("max_ci_fix_attempts", "max_runtime_minutes"):
        v = data.get(key)
        if not isinstance(v, int) or isinstance(v, bool) or v < 1:
            errors.append(f"policy.json: {key} must be an integer >= 1")
    for key in ("require_clean_tree", "require_acceptance_criteria"):
        if data.get(key) is not True:
            errors.append(
                f"policy.json: {key} must be true — it restates a hard rule; "
                "disabling it is a validator change, not a config edit"
            )

    auto = data.get("auto_merge")
    if not isinstance(auto, dict):
        errors.append("policy.json: auto_merge must be an object")
    else:
        if auto.get("enabled") is not False:
            errors.append(
                "policy.json: auto_merge.enabled must be false until the "
                "circuit-breaker/merge-policy engine exists (rollout V1 is human-merge)"
            )
        allowed = auto.get("allowed_risk")
        if (
            not isinstance(allowed, list)
            or not allowed
            or any(r not in RISK_LEVELS for r in allowed)
            or set(allowed) - {"low"}
        ):
            errors.append("policy.json: auto_merge.allowed_risk must be a subset of ['low']")

    gate = data.get("human_gate")
    if not isinstance(gate, dict):
        errors.append("policy.json: human_gate must be an object")
    else:
        paths = gate.get("paths")
        if not isinstance(paths, list) or not paths:
            errors.append("policy.json: human_gate.paths must be a non-empty list")
        else:
            for p in paths:
                check_path_pattern(p, repo_root, "policy.json human_gate.paths", errors)
            for required in REQUIRED_HUMAN_GATE_PATHS:
                if required not in paths:
                    errors.append(
                        f"policy.json: human_gate.paths must include {required!r} — "
                        "that path is the non-negotiable floor"
                    )
        labels = gate.get("labels")
        if not isinstance(labels, list) or not labels or not all(
            isinstance(l, str) and l for l in labels
        ):
            errors.append("policy.json: human_gate.labels must be a non-empty list of strings")
    return errors


def validate_risk_rules(agent_dir: Path, repo_root: Path) -> list[str]:
    errors: list[str] = []
    data = load_json(agent_dir / "risk-rules.json", errors)
    if data is None:
        return errors

    if data.get("version") != 1:
        errors.append("risk-rules.json: version must be 1")
    if data.get("default_risk") not in RISK_LEVELS:
        errors.append(f"risk-rules.json: default_risk must be one of {RISK_LEVELS}")
    if data.get("raise_only") is not True:
        errors.append(
            "risk-rules.json: raise_only must be true — an agent may never lower "
            "a risk a human wrote on the ticket"
        )
    rules = data.get("rules")
    if not isinstance(rules, list) or not rules:
        errors.append("risk-rules.json: rules must be a non-empty list")
        return errors
    for i, rule in enumerate(rules):
        where = f"risk-rules.json rules[{i}]"
        if not isinstance(rule, dict):
            errors.append(f"{where}: must be an object")
            continue
        if rule.get("risk") not in RISK_LEVELS:
            errors.append(f"{where}: risk must be one of {RISK_LEVELS}")
        if not isinstance(rule.get("reason"), str) or not rule.get("reason"):
            errors.append(f"{where}: reason must be a non-empty string")
        paths = rule.get("paths", [])
        labels = rule.get("labels", [])
        if not paths and not labels:
            errors.append(f"{where}: must name at least one of paths/labels")
        for p in paths:
            check_path_pattern(p, repo_root, where, errors)
    return errors


def validate_context_map(agent_dir: Path, repo_root: Path) -> list[str]:
    errors: list[str] = []
    data = load_json(agent_dir / "context-map.json", errors)
    if data is None:
        return errors

    if data.get("version") != 1:
        errors.append("context-map.json: version must be 1")
    vocab = data.get("gate_vocabulary")
    if not isinstance(vocab, list) or not vocab or not all(
        isinstance(g, str) and g for g in vocab
    ):
        errors.append("context-map.json: gate_vocabulary must be a non-empty list of strings")
        vocab = []

    # Trap ids must exist in the archive that holds them, or the context builder
    # hands an agent a pointer to nothing and the trap goes unread.
    tasks = repo_root / "docs" / "TASKS.md"
    tasks_text = tasks.read_text() if tasks.exists() else ""
    if not tasks_text:
        errors.append("context-map.json: docs/TASKS.md is missing — trap ids cannot be resolved")

    entries = data.get("entries")
    if not isinstance(entries, list) or not entries:
        errors.append("context-map.json: entries must be a non-empty list")
        return errors
    for i, entry in enumerate(entries):
        where = f"context-map.json entries[{i}]"
        if not isinstance(entry, dict):
            errors.append(f"{where}: must be an object")
            continue
        paths = entry.get("paths")
        if not isinstance(paths, list) or not paths:
            errors.append(f"{where}: paths must be a non-empty list")
            paths = []
        for p in paths:
            check_path_pattern(p, repo_root, where, errors)
        for doc in entry.get("docs", []):
            # A doc path must be its own clean, repo-relative spelling.
            # `./CLAUDE.md` and `a/../b` pass an exact-string forbidden-list
            # and an `is_file()` check while naming something else — review
            # walked three such aliases through the engine's guard, so both
            # halves now refuse unclean paths rather than normalizing them.
            if posixpath.normpath(doc) != doc or doc.startswith(("/", "../")):
                errors.append(f"{where}: doc {doc!r} is not a clean repo-relative path")
                continue
            if not (repo_root / doc).is_file():
                errors.append(f"{where}: doc {doc!r} does not exist")
        for trap in entry.get("traps", []):
            if not re.fullmatch(r"T\d+", str(trap)):
                errors.append(f"{where}: trap {trap!r} is not a T<n> id")
            elif tasks_text and f"**{trap}**" not in tasks_text:
                errors.append(f"{where}: trap {trap!r} not found in docs/TASKS.md")
        for gate in entry.get("gates", []):
            if gate not in vocab:
                errors.append(f"{where}: gate {gate!r} is not in gate_vocabulary")
    return errors


def validate_ticket_schema(agent_dir: Path, repo_root: Path) -> list[str]:
    errors: list[str] = []
    path = agent_dir / "ticket-schema.md"
    if not path.is_file():
        return ["ticket-schema.md: missing"]
    text = path.read_text()
    for heading in REQUIRED_HEADINGS:
        if heading not in text:
            errors.append(f"ticket-schema.md: required heading {heading!r} is missing")
    if "NEEDS HUMAN EVIDENCE" not in text:
        errors.append(
            "ticket-schema.md: must document the NEEDS HUMAN EVIDENCE marker — "
            "it is what the evidence latch and the engine's terminal states key on"
        )
    return errors


def validate(repo_root: Path) -> list[str]:
    agent_dir = repo_root / AGENT_DIR
    if not agent_dir.is_dir():
        return [f"{AGENT_DIR}/: missing"]
    errors: list[str] = []
    errors += validate_policy(agent_dir, repo_root)
    errors += validate_risk_rules(agent_dir, repo_root)
    errors += validate_context_map(agent_dir, repo_root)
    errors += validate_ticket_schema(agent_dir, repo_root)
    return errors


def mutate_json(path: Path, fn) -> None:
    data = json.loads(path.read_text())
    fn(data)
    path.write_text(json.dumps(data))


def self_test() -> list[str]:
    """Mutate copies of the REAL files and assert each mutation is caught.

    Mutating copies of the live files rather than fixtures means the self-test
    cannot drift from what it protects: a fixture stays valid forever, a copy
    of the real thing is re-cut on every run.
    """
    failures: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp_root = Path(tmp)
        shutil.copytree(ROOT / AGENT_DIR, tmp_root / AGENT_DIR)
        # The context map resolves traps against docs/TASKS.md and docs against
        # the repo — point the mutated root's docs at the real ones by copying
        # only what the validator reads.
        (tmp_root / "docs").mkdir()
        shutil.copy(ROOT / "docs" / "TASKS.md", tmp_root / "docs" / "TASKS.md")
        for rel in ("docs/architecture", "docs/testing"):
            shutil.copytree(ROOT / rel, tmp_root / rel)
        for rel in (
            "backend/internal/platform/auth",
            "backend/migrations",
            "backend/internal/modules/profile",
            "backend/internal/modules/exercise",
            "backend/internal/modules/session",
            "backend/internal/modules/workout",
            "backend/internal/modules/bjj",
            "railway",
            ".github/workflows",
            "apps/mobile/lib",
            "apps/mobile/app",
            "apps/web",
            "apps/admin",
            "contracts",
            "scripts",
        ):
            (tmp_root / rel).mkdir(parents=True, exist_ok=True)
        (tmp_root / "apps/mobile/eas.json").write_text("{}")
        (tmp_root / "apps/mobile/app.json").write_text("{}")
        (tmp_root / "apps/mobile/package.json").write_text("{}")
        for rel in (
            "apps/mobile/lib/db.ts",
            "apps/mobile/lib/sessionStore.ts",
            "apps/mobile/lib/plan.ts",
            "apps/mobile/lib/activities.ts",
        ):
            (tmp_root / rel).write_text("")

        baseline = validate(tmp_root)
        if baseline:
            return [f"self-test baseline should validate clean, got: {baseline[:3]}"]

        agent = tmp_root / AGENT_DIR
        mutations = [
            ("policy.json loses max_ci_fix_attempts",
             lambda: mutate_json(agent / "policy.json", lambda d: d.pop("max_ci_fix_attempts"))),
            ("policy.json enables auto_merge",
             lambda: mutate_json(agent / "policy.json",
                                 lambda d: d["auto_merge"].__setitem__("enabled", True))),
            ("policy.json drops the migrations human gate",
             lambda: mutate_json(agent / "policy.json",
                                 lambda d: d["human_gate"]["paths"].remove("backend/migrations/**"))),
            ("policy.json gates a path that does not exist",
             lambda: mutate_json(agent / "policy.json",
                                 lambda d: d["human_gate"]["paths"].append("backend/no-such-dir/**"))),
            ("policy.json uses a glob form the engine cannot read",
             lambda: mutate_json(agent / "policy.json",
                                 lambda d: d["human_gate"]["paths"].append("backend/migrations/0000*.sql"))),
            ("risk-rules.json flips raise_only",
             lambda: mutate_json(agent / "risk-rules.json",
                                 lambda d: d.__setitem__("raise_only", False))),
            ("risk-rules.json invents a risk level",
             lambda: mutate_json(agent / "risk-rules.json",
                                 lambda d: d["rules"][0].__setitem__("risk", "extreme"))),
            ("context-map.json references a doc that does not exist",
             lambda: mutate_json(agent / "context-map.json",
                                 lambda d: d["entries"][0]["docs"].append("docs/no-such.md"))),
            ("context-map.json aliases a doc path (./ prefix)",
             lambda: mutate_json(agent / "context-map.json",
                                 lambda d: d["entries"][0]["docs"].append("./docs/architecture/api-conventions.md"))),
            ("context-map.json references a trap TASKS.md does not hold",
             lambda: mutate_json(agent / "context-map.json",
                                 lambda d: d["entries"][0]["traps"].append("T9999"))),
            ("context-map.json uses a gate outside the vocabulary",
             lambda: mutate_json(agent / "context-map.json",
                                 lambda d: d["entries"][0]["gates"].append("no-such-gate"))),
            ("ticket-schema.md loses the Acceptance criteria heading",
             lambda: (agent / "ticket-schema.md").write_text(
                 (agent / "ticket-schema.md").read_text().replace(
                     "## Acceptance criteria", "## Criteria"))),
            ("policy.json is not JSON at all",
             lambda: (agent / "policy.json").write_text("{not json")),
        ]
        pristine = {p.name: p.read_text() for p in agent.iterdir()}
        for name, apply in mutations:
            apply()
            if not validate(tmp_root):
                failures.append(f"mutation NOT caught: {name}")
            for fname, text in pristine.items():
                (agent / fname).write_text(text)
        if validate(tmp_root):
            failures.append("restore after mutations left the copies invalid — harness bug")
    return failures


def main() -> int:
    # Self-test first, every run: a validator that cannot go red proves nothing.
    failures = self_test()
    if failures:
        print("check-agent-policy SELF-TEST failed:\n", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1

    errors = validate(ROOT)
    if errors:
        print(f"{AGENT_DIR}/ is invalid:\n", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1

    print("agent policy ok — 4 files valid, self-test caught all 13 mutations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
