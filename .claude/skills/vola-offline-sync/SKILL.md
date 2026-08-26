---
name: vola-offline-sync
description: The offline-first invariants VOLA's mobile app is built on — local-first SQLite writes, the sync outbox, client-generated IDs, the single Clerk token broker, and what offline must never be mistaken for. Use when touching apps/mobile/lib/db.ts, activities.ts, sync.ts, session.ts, sessionStore.ts, or authResume.ts; when adding any feature that reads or writes athlete data on mobile; or when reviewing a refactor anywhere near sync or auth.
---

A gym is the primary environment this app runs in, and gyms have dead spots.
Every invariant below exists because its violation was shipped, measured, or
reported from a real device. **Never refactor sync or auth "for cleanliness"
without first proving these still hold** — several of them are invisible in
the code that depends on them.

## The invariants

1. **Local write first, always.** `apps/mobile/lib/db.ts` (expo-sqlite)
   writes before anything talks to the network. The device's copy is the
   authoritative record of what the athlete did; the server learns about it
   when connectivity allows.

2. **`synced` is a mutation-outbox flag, not a cache marker.** 0 = still
   owed to the server, 1 = confirmed accepted. Rows are KEPT after syncing,
   never deleted — the device retains its own history independent of the
   network.

3. **IDs are generated client-side, and that is what makes retries
   idempotent.** The backend's `ON CONFLICT DO NOTHING` only dedupes because
   a retry carries the same ID. Moving ID generation server-side would make
   every retry a duplicate row.

4. **Every local row is scoped by `user_id`.** On a shared device an
   unscoped outbox shows one account's history to the next sign-in AND
   pushes the previous account's pending rows under the new account's token
   — a mistake idempotency makes permanent.

5. **`lib/session.ts` is the ONLY module allowed to call Clerk.** Clerk
   returns `null` (not an error) when unreachable, and 30 call sites once
   read that null as "not signed in" — a dead spot told a signed-in athlete
   to sign in on every screen at once. The broker caches against the token's
   own `exp`, collapses concurrent refreshes, keeps serving a still-valid
   token when Clerk is unreachable, and throws `OfflineError` rather than
   ever claiming signed-out. Do not reintroduce a direct `getToken()` call;
   `useAuthToken()` returns `Promise<string>` precisely so the null reading
   cannot come back.

6. **Offline is never signed-out.** Signed-out is decided in one place
   (`app/_layout.tsx`'s guard, keyed on the `AUTH_ROUTES` array), and a
   transient `isSignedIn: false` immediately after a resume-from-lock is
   held for a grace window rather than acted on (`lib/authResume.ts`, N190)
   — a radio that just woke up is not a revoked session. Cold-start
   signed-out, explicit sign-out, and a revoke discovered while foregrounded
   all still confirm immediately.

7. **A feature that requires sync-to-have-happened silently disables itself
   in a dead spot.** When live data is needed, read the device's own SQLite
   (or send it in the request) rather than reading it back from the server's
   view — N191's in-session signal sends today's set weights in the request
   for exactly this reason. Ask of any new feature: what does this do in a
   dead spot, and does its failure blame the athlete?

8. **New auth screens must be added to `AUTH_ROUTES`** or they render for
   one frame and vanish — the signed-out guard replaces every non-listed
   path.

## Testing rules that go with these

- **SQL behavior belongs in a fixture test, never a regex over the query
  string** — `apps/mobile/lib/__tests__/support/sqlite.ts` runs the app's
  own `migrate()` against real SQLite (node:sqlite shim). A text assertion
  proves a clause is present, not that SQLite honours it.
- Races (token refresh collapse, resume grace, backoff) are tested by
  driving the real sequence with fake timers, not by asserting a static
  mock's value — a race cannot be caught by a fixed value.
- The suite runs under `TZ=America/Los_Angeles` at process launch; setting
  `process.env.TZ` inside a test silently does nothing.

## Not covered here, and where it lives

- The full offline-Clerk mechanics and their measurements: doc comments in
  `lib/session.ts` and `lib/authResume.ts` (they are essays, deliberately).
- Server-side idempotency and module patterns: CLAUDE.md "Backend module
  pattern".
- Sync scenarios worth E2E coverage: `docs/testing/functional-scenarios.md`.
