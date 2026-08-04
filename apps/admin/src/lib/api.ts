import "server-only";

import { auth } from "@clerk/nextjs/server";
import { newTraceId, traceparent } from "./trace";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

export type AdminUserSummary = {
  user_id: string;
  display_name: string | null;
  /** Sessions logged, all time. Was `activity_count`, from a table nothing writes. */
  session_count: number;
  /** Most recent session start — the best liveness signal that exists. */
  last_session_at: string | null;
  /** Sets logged. Separates "started two sessions" from "trained twice". */
  set_count: number;
  /** Enabled disciplines, resolved server-side through the registry. */
  modules: string[];
  created_at: string | null;
};

/** Carries the HTTP status so the error boundary can tell 403 from 5xx. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    path: string,
    /** The backend's error code — the part of the shape that is contractual. */
    public readonly code = "",
    /** The backend's own message, when it sent one worth showing. */
    public readonly detail = "",
  ) {
    super(detail || `API responded ${status} for ${path}`);
    this.name = "ApiError";
  }
}

/**
 * Server-side fetch against the admin-only backend endpoints. The backend
 * independently enforces the ADMIN_USER_IDS allowlist (auth.RequireAdmin) —
 * this app's own gate in users/layout.tsx is defence in depth for the UI,
 * not the security boundary.
 *
 * `cache: "no-store"` because admin views must show current state, never a
 * stale render of someone's account.
 */
async function adminFetch<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) {
    // Without this, the header becomes the literal "Bearer null" and the
    // backend's 401 looks like a server fault rather than a missing session.
    throw new ApiError(401, path);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      // Correlates this admin read with the API's structured logs, same as
      // apps/web and apps/mobile already do for their own calls.
      traceparent: traceparent(newTraceId()),
      ...(init ? { "Content-Type": "application/json" } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  if (!res.ok) {
    throw await apiErrorFrom(res, path);
  }
  return res.json() as Promise<T>;
}

/**
 * Reads the backend's `{error:{code,message}}` body so a write can show the
 * operator what was actually wrong.
 *
 * The messages here are worth surfacing verbatim rather than replacing with a
 * generic one: content authoring has eighteen fields, and the API deliberately
 * names the offending value and the legal set ("position %q is not one the
 * library uses — pick one of: …"). Swallowing that means opening the source to
 * find out which field was rejected.
 *
 * Branch on `code`, never on `message` — the codes are the contract, the
 * messages are not.
 */
async function apiErrorFrom(res: Response, path: string): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.message) {
      return new ApiError(res.status, path, body.error.code ?? "", body.error.message);
    }
  } catch {
    // A non-JSON body (a proxy's HTML 502, say) is not worth failing over —
    // fall through to the status-only error.
  }
  return new ApiError(res.status, path);
}

export async function listUsers(): Promise<AdminUserSummary[]> {
  const data = await adminFetch<{ users: AdminUserSummary[] }>("/admin/users");
  return data.users;
}

export type AdminSessionSummary = {
  id: string;
  sport: string;
  name: string;
  started_at: string;
  /** Null means still in progress — at a week old, that is itself a finding. */
  ended_at: string | null;
  set_count: number;
};

export type AdminUserDetail = {
  user: AdminUserSummary;
  recent_sessions: AdminSessionSummary[];
};

/**
 * One athlete: the summary row plus the sessions behind it.
 *
 * A single request — the summary and the session list are batched into one
 * round trip server-side rather than fetched as two calls from here.
 *
 * Throws ApiError(404) for an id nobody has ever used, which the page turns
 * into a real not-found. The old activities-only page could not tell a wrong
 * id from an empty account and said so in its own copy.
 */
export async function getUserDetail(userID: string): Promise<AdminUserDetail> {
  return adminFetch<AdminUserDetail>(`/admin/users/${encodeURIComponent(userID)}`);
}

/**
 * BJJ rank, admin's read-only half of `internal/modules/bjj`.
 *
 * `current` is DERIVED server-side from `promotions`, not stored — see the
 * backend's `StandingFrom`. Admin never edits a rank; it only shows one
 * beside the athlete, so there's no input type here, only the read shape.
 */
export type BjjBelt = "white" | "blue" | "purple" | "brown" | "black";

export type BjjRank = {
  belt: BjjBelt;
  stripes: number;
  /** Black-belt degrees. 0 on every other belt. */
  degree: number;
};

export type BjjStanding = {
  /** Null means no rank recorded — a real state, not a loading placeholder. */
  current: BjjRank | null;
  time_at_current_days: number | null;
};

/**
 * A user with no promotions answers 200 with `current: null` — the same as a
 * real account that has never recorded one. This endpoint doesn't distinguish
 * "no such user" from "no rank yet", so callers only fetch it for a user
 * `getUserDetail` has already confirmed exists.
 */
export async function getUserBjjStanding(userID: string): Promise<BjjStanding> {
  return adminFetch<BjjStanding>(`/admin/users/${encodeURIComponent(userID)}/bjj/standing`);
}

// `listUserActivities` and the `Activity` type lived here. Both are gone:
// nothing rendered them once the detail page moved to sessions, and the table
// they read has had no writer since the in-app logging form was removed. The
// backend route survives as the only read path for the rows that predate that.

export type HealthEventKind = "server_error" | "slow_request" | "client_error" | "sync_blocked";

export type HealthEvent = {
  id: number;
  occurred_at: string;
  /**
   * `api` was measured by the server; `client` was claimed by an app. Kept
   * distinct on screen too — an operator needs to know which of the two they
   * are looking at before deciding how much to trust it.
   */
  source: "api" | "client";
  kind: HealthEventKind;
  user_id: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  duration_ms: number | null;
  error_code: string;
  message: string;
  /** Pivot from this row to the full request in the log stream. */
  request_id: string;
  trace_id: string;
  details: Record<string, unknown> | null;
};

export type HealthSummary = {
  since: string;
  total: number;
  by_kind: Record<string, number>;
  /** Distinct people, not events — see the API description for why. */
  affected_users: number;
  slowest_paths_ms: Record<string, number>;
};

export type HealthReport = { summary: HealthSummary; events: HealthEvent[] };

/**
 * Recent operational problems.
 *
 * `userID` narrows to one athlete — the question "is this specific person
 * having trouble?", which had no answer at all before this because the logs
 * carried no user id. The user-detail page is now that consumer.
 */
export async function fetchHealth(opts: { hours?: number; userID?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.hours) params.set("hours", String(opts.hours));
  if (opts.userID) params.set("user_id", opts.userID);
  const qs = params.toString();
  return adminFetch<HealthReport>(`/admin/health${qs ? `?${qs}` : ""}`);
}

/**
 * A technique as the catalog stores it.
 *
 * snake_case throughout, matching the wire and the Postgres columns 1:1 — see
 * docs/architecture/api-conventions.md. No camelCase mapping layer on purpose:
 * a second set of names is a second thing to keep in step with eighteen fields.
 */
export type Technique = {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  /** advance | reverse | escape | control | finish, or empty. */
  function?: string;
  position: string;
  position_detail: string;
  /** Where it LEAVES you. Empty means not recorded, never "goes nowhere". */
  to_position?: string;
  gi_no_gi: string;
  typical_belt: string;
  description: string;
  when_to_use: string;
  setup_from: string[];
  common_next_moves: string[];
  common_counters: string[];
  video_reference: string;
  source_notes: string;
  ibjjf_ruleset_id: string;
  /**
   * "admin" for everything the admin list returns.
   *
   * Only populated on `/admin/techniques` — the public `GET /techniques/{id}`
   * does not select it and the contract does not promise it there. Do not
   * derive ownership from this field on a technique read the public way: it
   * comes back undefined, which reads as "not admin" and marks everything
   * deploy-owned. Use membership of `listAuthoredTechniques()` instead.
   */
  source?: string;
  created_at?: string;
  updated_at?: string;
};

/**
 * The techniques the console owns.
 *
 * Not the whole catalog: PATCH refuses a seeded row, so the other 466 would be
 * rows that 409 when clicked. The screen says where those live instead.
 */
export async function listAuthoredTechniques(): Promise<Technique[]> {
  const data = await adminFetch<{ techniques: Technique[] }>("/admin/techniques");
  return data.techniques;
}

/**
 * The position vocabulary, DERIVED server-side from the catalog rather than
 * listed here.
 *
 * A hardcoded copy is how the editor's dropdown and the validator drift apart,
 * and the failure that follows is the quiet kind: a technique filed under a
 * position no filter matches renders fine and returns nothing forever.
 */
export async function listPositions(): Promise<string[]> {
  const data = await adminFetch<{ positions: string[] }>("/admin/techniques/positions");
  return data.positions;
}

/**
 * One technique, full detail, from the public read path.
 *
 * Note the shape difference, which is easy to get wrong and fails silently:
 * this endpoint returns the technique at the TOP LEVEL, while the admin write
 * endpoints wrap theirs in `{ "technique": … }`. Reading `.technique` here
 * yields undefined rather than an error, so the edit page rendered a 404 for
 * an id that plainly exists — caught in the browser, not by the typechecker,
 * because the assertion was the lie.
 */
export async function getTechnique(id: string): Promise<Technique> {
  return adminFetch<Technique>(`/techniques/${encodeURIComponent(id)}`);
}

/**
 * The admin-writable surface.
 *
 * `id` and `source` are absent deliberately, matching the backend's own
 * request type: the id is derived from the name at creation and immutable
 * after, because it is already a foreign key in athletes' training records.
 */
export type TechniqueWrite = Omit<
  Technique,
  "id" | "source" | "created_at" | "updated_at"
>;

export async function createTechnique(body: TechniqueWrite): Promise<Technique> {
  const data = await adminFetch<{ technique: Technique }>("/admin/techniques", {
    method: "POST",
    body,
  });
  return data.technique;
}

/**
 * PATCH is a partial update on the wire, but this console always sends the
 * whole form.
 *
 * That is deliberate and it is the safe direction: the form is populated from
 * the stored row, so every field it sends is either unchanged or edited on
 * purpose. Sending only the dirty fields would be smaller and would reintroduce
 * the failure the backend's pointer-typed request exists to survive — a form
 * that omits `description` erasing the prose.
 */
export async function updateTechnique(
  id: string,
  body: TechniqueWrite,
): Promise<Technique> {
  const data = await adminFetch<{ technique: Technique }>(
    `/admin/techniques/${encodeURIComponent(id)}`,
    { method: "PATCH", body },
  );
  return data.technique;
}
