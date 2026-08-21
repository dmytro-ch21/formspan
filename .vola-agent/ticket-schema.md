# Ticket contract for AI-executable work

Every ticket the dev engine is allowed to work autonomously must contain the
sections below. The engine's dispatcher refuses (moves the ticket to Blocked
with an explanation) rather than inventing its own definition of done — a
ticket with no objective acceptance criteria is not dispatchable, matching the
existing `ac-verifier` rule that NO CRITERIA is blocking.

`scripts/check-agent-policy.py` validates that this file keeps the required
headings; the dispatcher validates each ticket against them at claim time.

## Required sections

```markdown
## Athlete outcome
What observable user/developer outcome changes?

## Scope
Owned areas/paths and explicit non-goals.

## Acceptance criteria
- [ ] Observable criterion 1
- [ ] Observable criterion 2

## Non-regressions
- [ ] Existing invariant that must remain true

## Test plan
Automated checks expected.

## Human evidence
- [ ] **NEEDS HUMAN EVIDENCE** — exact device/live observation, if required

## Risk
low | medium | high
```

## Rules

- **Acceptance criteria** must be objective and observable. "Works well" is not
  a criterion; "the sign-up screen keeps its labels above the keyboard on a
  15 Pro" is.
- **Human evidence** is optional as a section, but when present, a
  `**NEEDS HUMAN EVIDENCE**` checkbox can never be ticked by the engine. It is
  released only by the existing evidence latch (`/evidence <observation>` from
  someone with write access). Merged-with-evidence-outstanding is the
  `Awaiting Evidence` state, not Done.
- **Risk** is the human's floor. Rules in `risk-rules.json` may raise it;
  nothing may lower it without a human decision.
- **Scope** bounds the diff: files outside the owned areas are a review finding
  ("unrelated-file touch"), and repeated violations are an engine defect.
