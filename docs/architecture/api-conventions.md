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

Single allowed origin via the `WEB_ORIGIN` env var (see `docs/architecture/deployment.md`) — revisit once staging/production domains exist and more than one origin needs to be trusted.

## Pagination (forward-looking — no list endpoints exist yet)

When a list endpoint is eventually needed, use cursor-based pagination (`?cursor=&limit=`), not page numbers — consistent with the cursor-based incremental sync already planned for mobile offline sync (same underlying concept: a stable position marker rather than an offset that shifts under concurrent writes).

## OpenAPI

`contracts/public.openapi.yaml` is the source of truth for the wire contract — hand-maintained alongside the Go handlers, not generated, since the backend deliberately stays on stdlib `net/http` rather than a framework with reflection-based spec generation (matches the project's general preference for stdlib over added dependencies). CI lints it for structural validity on every push (`pnpm run lint:openapi`); it does not currently check that the spec matches the implementation — that's a manual discipline for now, worth automating (e.g. contract testing) if drift becomes a real problem.
