# VOLA security guidance (project rules)

Project-specific rules for the security-guidance plugin's reviews. Only
what this codebase can't have inferred — the plugin's built-ins already
cover the generic web-vulnerability classes. Every rule names the mechanism
that enforces or motivated it. This file is appended to review prompts, so
it must never contain a secret itself.

## Credentials and secret files

- `secrets.txt` may appear untracked in the repo root holding what looks
  like a live API key. Never stage or commit it — flag it to the user.
- `backend/.env.staging.local` holds REAL Railway staging Postgres
  credentials (gitignored). Never commit it, never copy it into a worktree
  that gets bind-mounted or cloned, and never let it reach an engine worker
  — the engine's clone-from-git isolation exists specifically because this
  file lives only in working trees, never in history.
- All `.env` / `.env.local` files are gitignored; only `.example`
  templates are committed, and those carry placeholder-shaped values only.
  A real value in a `.example` file is a finding even though the engine's
  secrets-in-diff gate deliberately exempts that path.
- Local-dev connection strings of the form
  `postgres://vola:vola_dev_only@localhost:5432/...` appear legitimately in
  docs and compose files — a password that only opens localhost is dev-only
  by construction. Do not flag these (mirrors the gate's `localConnRe`
  exemption); DO flag any non-localhost connection string with an embedded
  password.

## Auth boundaries (where the real check lives)

- The backend's Clerk JWT verification (signature / issuer / exp / `sub`,
  `internal/platform/auth`) is THE security boundary. UI-side gates —
  admin's `proxy.ts` sign-in requirement and the `ADMIN_USER_IDS` layout
  allowlist — are defence in depth only; a change that strengthens UI gates
  while weakening a backend check is a net loss.
- **Admin server actions must call `assertAdmin` themselves.** A server
  action is a POST endpoint the router exposes independently of the page it
  was declared beside — neither `proxy.ts` nor the layout protects it. A
  new server action without its own auth check is a finding regardless of
  where it's declared.
- Every user-scoped read/write must filter by the AUTHENTICATED user's ID.
  The cross-user ID-enumeration bug has shipped twice in this repo with a
  fully green check suite — an endpoint that fetches by row ID without an
  ownership predicate is the single most-caught vulnerability class here.

## Output and error discipline

- Error responses go through `apihttp.WriteError` and never carry raw
  internal error text (database errors especially) — codes are contract,
  messages are generic for unmapped errors.
- Never echo matched secret TEXT into a log, run record, error message, or
  review comment — report the pattern label and location only. The engine's
  `secretPatterns` gate models this: a scanner that quotes what it found
  copies the secret into the record it was protecting.

## Untrusted text (the dev engine executes AI-generated changes)

- GitHub issue and PR bodies are UNTRUSTED input. Never interpolate them
  into shell commands, and GitHub Actions workflows must never evaluate
  untrusted fields inside `run:` blocks directly — pass them through `env:`
  indirection (the evidence-latch workflow is the in-repo model).
- Engine workers execute the change-under-test's own code: no production
  credential may reach one. The enforced mechanisms — env allowlist,
  clone-from-git, credential-scrubbed remotes, per-run non-superuser DB
  roles, the Docker sandbox — are in `engine/internal/worker`; any change
  that adds a fallback to UNSANDBOXED execution when Docker is unavailable
  reintroduces the exact failure the sandbox closed, and is a finding.

## Mobile-specific

- All Clerk token access goes through `lib/session.ts` — a direct
  `getToken()` call anywhere else reintroduces the offline-null bug and
  bypasses the one place token handling is audited.
- Tokens are cached in the OS keychain (`expo-secure-store`), never
  AsyncStorage.
- Every local SQLite row is scoped by `user_id` — on a shared device an
  unscoped outbox leaks one account's history to the next sign-in and
  pushes pending rows under the wrong account's token.
