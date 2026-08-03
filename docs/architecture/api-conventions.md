# REST and OpenAPI conventions

These are the conventions every backend HTTP endpoint follows, starting with `/v1/healthz`, `/v1/me`, and `/v1/profile`. New endpoints should match this document rather than reinvent shape; if a new case doesn't fit, update this doc as part of that change.

## Versioning

Every route is prefixed with a version: `/v1/...`. Added now, while it's cheap (before mobile/admin clients exist) — retrofitting a prefix onto URLs already depended on by multiple clients is a much bigger job than doing it now. A breaking change to the contract gets a new prefix (`/v2`) rather than mutating `/v1` in place; `/v1` keeps working for clients that haven't migrated yet.

## Resource naming

- Endpoints for the authenticated caller's own singleton resource are a singular, unprefixed noun with no ID in the path — e.g. `/v1/me`, `/v1/profile`. There is exactly one per authenticated user, addressed implicitly via the bearer token, never via a URL parameter.
- Resources addressable by ID use plural nouns with an ID segment — e.g. a future admin lookup might be `/v1/admin/users/:id`. None exist yet.

## JSON conventions

- Request and response bodies are JSON, `snake_case` field names — matches the Postgres column names 1:1, so there's no translation layer to keep in sync.
- Timestamps are RFC3339 (Go's default `time.Time` JSON encoding — no custom formatting needed).
- Dates without a time component (e.g. `date_of_birth`) are plain `YYYY-MM-DD` strings.

## Auth

`Authorization: Bearer <token>` on every protected route, where `<token>` is a Clerk-issued session JWT verified against Clerk's JWKS (see `internal/platform/auth`). Missing, malformed, or expired tokens always produce a `401` with `code: "unauthorized"` — never a different status for different auth failure reasons, since that would let a client distinguish "no such user" from "wrong token" in ways that aren't useful and could leak information.

## HTTP status codes

| Status | Meaning |
|---|---|
| 200 | Success (read, or update returning the updated resource) |
| 201 | Created |
| 400 | Bad request — malformed JSON body, or a value that fails validation (e.g. a bad date format or an invalid enum value) |
| 401 | Missing, malformed, or expired auth |
| 404 | The resource doesn't exist for this caller |
| 409 | Conflict — e.g. attempting to create a resource that already exists |
| 499 | The caller disconnected before the response was written (nginx's convention). **The one response with no body** — nothing is listening, and a JSON error shape would be misleading if it somehow were. Not a failure: it is not logged at ERROR and should not count toward an error-rate alert. |
| 500 | Unexpected server error |

## Error response shape

Every error response, from every endpoint, shares one shape:

```json
{
  "error": {
    "code": "invalid_input",
    "message": "date_of_birth must be YYYY-MM-DD"
  }
}
```

`code` is a stable, machine-readable token — it's part of the API contract (mirrored in `contracts/public.openapi.yaml`'s `Error` schema `enum`), and renaming one is a breaking change requiring a version bump. `message` is for humans and may reword between releases; clients must not pattern-match on it.

Current codes: `invalid_input`, `unauthorized`, `not_found`, `already_exists`, `internal`.

**Never leak internal error details in a 500.** An unmapped/unexpected error is logged server-side with its real detail and returns only a generic `{"error": {"code": "internal", "message": "internal error"}}` to the client — raw database errors, stack traces, or other implementation details must never reach the response body. See `internal/platform/apihttp.WriteError` and how `profile.writeError` uses it.

## CORS

Allowed origins via the `WEB_ORIGIN` env var (comma-separated; only listed origins are echoed back, never a wildcard) (see `docs/architecture/deployment.md`) — revisit once staging/production domains exist and more than one origin needs to be trusted.

## Pagination

**Two shapes, chosen by what the list is for.** This section originally said
"cursor everywhere, never offsets"; that was written before any list endpoint
existed, and the first one to genuinely need paging wanted the other shape.

**Offset + total** (`?limit=&offset=`, responding with `{items, total, limit,
offset}`) for a bounded list the caller *browses* — the session history being
the case in hand. A person reading their own training back wants "137
sessions" and the ability to jump; a cursor can give neither, because it has
no idea how much is behind it. The list is bounded by one athlete's own
history, so the usual objection to `COUNT(*)` doesn't bite.

Two things are required of any offset endpoint:

- **A total order.** `ORDER BY started_at DESC, id`, never the timestamp
  alone. Without the tiebreak two rows with equal timestamps can swap between
  requests, so one appears on two pages and another on none.
- **Honesty about what it doesn't give you.** Offsets shift under concurrent
  writes: a session synced while someone pages pushes every later row down
  one. Deterministic within a snapshot is not stable across requests, and the
  contract must not claim otherwise.

**Cursor** (`?cursor=&limit=`) for anything a machine *drains* — mobile
incremental sync above all, where re-reading or skipping a row is a
correctness bug rather than a cosmetic one, and nobody needs a total.

## OpenAPI

`contracts/public.openapi.yaml` is the source of truth for the wire contract — hand-maintained alongside the Go handlers, not generated, since the backend deliberately stays on stdlib `net/http` rather than a framework with reflection-based spec generation (matches the project's general preference for stdlib over added dependencies). CI lints it for structural validity on every push (`pnpm run lint:openapi`); it does not currently check that the spec matches the implementation — that's a manual discipline for now, worth automating (e.g. contract testing) if drift becomes a real problem.

## Response compression

Responses over 1 KB are gzipped when the client sends `Accept-Encoding: gzip`
(`internal/platform/apihttp/compress.go`). Smaller ones are sent verbatim —
gzip's header alone is 18 bytes, so compressing an error body makes it bigger.

Every response carries `Vary: Accept-Encoding`, compressed or not. **Any
middleware that varies must `Add` rather than `Set`** — `Vary` is a list, and
`Set` silently drops whichever ran first, which is how a cache ends up serving
a gzipped body to a client that cannot read it.

Clients need no change: `fetch` and Go's `http.Client` both decompress
transparently.

## Conditional GET

`GET`/`HEAD` responses with status 200 carry a strong `ETag` (a hash of the
body). A client echoing it back in `If-None-Match` gets `304 Not Modified`
with no body — reference content changes only on deploy, so repeat fetches
cost a header exchange.

Only 200s. A 304 on an error would cache the failure, and a 304 on a write
would tell the client its write was a no-op.

`ConditionalGet` runs **inside** `Compress` so the ETag is computed over the
identity body — otherwise it would change with `Accept-Encoding` and every
gzip-capable client would be a permanent cache miss. Both are composed by
`apihttp.Stack()` rather than assembled at the call site, because the test
that asserts this property has to be able to reach the real order: the first
version built its own stack, so swapping the order in `main.go` left the
whole suite green.

**A handler that sets its own `ETag` wins, and is honoured** — the middleware
steps aside and answers `If-None-Match` against the handler's validator rather
than emitting it and ignoring it. This is the seam a per-repository
`max(updated_at)` validator drops into: it skips building the body as well,
where the middleware only skips sending it.

**Any such validator must be user-scoped.** `Vary` is `Accept-Encoding,
Origin` — not `Authorization` — and a browser cache keys on URL + `Vary`. A
bare `max(updated_at)` over a shared table is the obvious first draft and
would revalidate user B against user A's stored body. The body-hash default is
immune to this (different users, different bytes, different hash); a
handler-supplied validator is not, and nothing enforces it.

Every 200 carries **`Cache-Control: private, no-cache`** unless the handler set
its own. `no-cache` is not "don't cache" — it is "cache, but revalidate before
reuse", which is exactly the contract an ETag describes, and `private` keeps
shared caches out of per-user data. RFC 9111 §3.5 already forbids a shared
cache from storing an `Authorization`-carrying response, so this is defence in
depth rather than the only thing standing between a proxy and someone's
training log.

A handler setting **`Cache-Control: no-store` opts out of conditional GET
entirely** — no `ETag` is emitted and no `304` is returned, because a
validator for reusing a response that must not be stored is a contradiction.
`/v1/healthz` uses this: its body is a constant, so its validator would never
change, and a liveness probe sending `If-None-Match` would be answered `304`
for the life of the deployment while a checker asserting `200` reported an
outage that wasn't happening.

Browsers need two CORS headers for any of this: `If-None-Match` in
`Access-Control-Allow-Headers` (it isn't safelisted, so the preflight rejects
it otherwise) and `ETag` in `Access-Control-Expose-Headers` (JS cannot read a
header it isn't exposed). Native clients are unaffected, which is exactly how
this would go unnoticed.

Two costs, both real. It saves **bandwidth, not database work** — the query
still runs and the JSON is still marshalled, because the hash is of the
finished body. And it **buffers**: the identity body is held whole to hash it,
benchmarked at ~+344 KB per in-flight request on the largest response the API
serves. Peak memory is therefore bounded by the largest response that can be
produced — which is only a bound if every list has a ceiling, so the two that
had none now do (`activity.ListByUser`, `workout.List`; both 500, both with a
total `ORDER BY` so the cap's membership and the response hash are stable).
**A new list endpoint without a `LIMIT` silently unbounds this property.**
Note the +344 KB figure is anchored to `/v1/exercises` (~212 KB, the largest
*today*); `/v1/workouts` is capped at 500 workouts × up to 200 items, so the
ceiling is an order of magnitude above it. Still a ceiling — but the benchmark
is not the worst case.

A cap over a list that spans more than one owner needs one more thing:
**sort the caller's own rows first.** `workout.List` mixes your workouts with
every user's public ones, so ordering by name alone evicts alphabetically
across ownership — your own workout named "Z…" disappears once 500 public ones
sort ahead of it. Deterministic and correct are not the same property.

Not supported behind this stack, deliberately: `Flusher`, `Hijacker`,
`ReaderFrom`. Buffering to hash is incompatible with mid-response flushing,
and exposing one would let a handler emit the body twice. A streaming endpoint
has to be routed around the stack rather than accommodated inside it.
