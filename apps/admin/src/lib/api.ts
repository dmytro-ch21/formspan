import "server-only";

import { auth } from "@clerk/nextjs/server";
import { newTraceId, traceparent } from "./trace";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

export type AdminUserSummary = {
  user_id: string;
  display_name: string | null;
  activity_count: number;
  last_activity_at: string | null;
};

export type Activity = {
  id: string;
  user_id: string;
  kind: string;
  occurred_at: string;
  notes: string | null;
  details?: Record<string, unknown> | null;
  request_id: string;
  trace_id: string;
  created_at: string;
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

export async function listUserActivities(userID: string): Promise<Activity[]> {
  const data = await adminFetch<{ activities: Activity[] }>(
    `/admin/users/${encodeURIComponent(userID)}/activities`,
  );
  return data.activities;
}
