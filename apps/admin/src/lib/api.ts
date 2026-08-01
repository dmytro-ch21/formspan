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
  ) {
    super(`API responded ${status} for ${path}`);
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
async function adminFetch<T>(path: string): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) {
    // Without this, the header becomes the literal "Bearer null" and the
    // backend's 401 looks like a server fault rather than a missing session.
    throw new ApiError(401, path);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Correlates this admin read with the API's structured logs, same as
      // apps/web and apps/mobile already do for their own calls.
      traceparent: traceparent(newTraceId()),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new ApiError(res.status, path);
  }
  return res.json() as Promise<T>;
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
