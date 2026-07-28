---
name: new-module
description: Scaffold a new backend domain module (internal/modules/<name>) following Formspan's established pattern — domain types, Postgres repository, HTTP handlers, migration, integration test, OpenAPI entry, wired under /v1. Use when the user asks to add a new backend domain/module (e.g. "add a goals module").
argument-hint: <module-name> [brief description of what it stores/does]
---

1. If the module name or its data model isn't already clear from the argument, ask the user directly rather than guessing — a wrong data model for something like health/body data is expensive to unwind later. Confirm: field names and types, and whether it's a per-user singleton resource (like `profile`) or something with multiple records per user (which changes the URL/repository shape).

2. Delegate the actual scaffolding to the `backend-module-scaffolder` subagent, giving it the confirmed module name and data model.

3. Once the agent reports back, follow the standard git/PR workflow from `CLAUDE.md`:
   - Check `git status` in the primary working directory first. If there are uncommitted changes that aren't related to this work, use an isolated `git worktree` branched from `origin/main` instead of touching them.
   - Branch, commit with a clear message, push, `gh pr create`.
   - Run the `pre-merge-checker` subagent (or just call `/pre-merge`) before pushing if you haven't already verified everything through the scaffolder agent's own checks.
   - Watch CI with `gh run watch <run-id> --exit-status`.
   - **Do not merge without the user's explicit go-ahead**, even if CI is green.

4. Append a dated entry to `docs/decisions/history.md` describing what module was added and why, per the standing rule in `CLAUDE.md`.

5. Add the new module's recommended functional test scenarios (happy path, edge cases & errors, auth/security) to `docs/testing/functional-scenarios.md`, per the standing rule in `CLAUDE.md`.
