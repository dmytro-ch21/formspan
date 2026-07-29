import { auth } from "@clerk/nextjs/server";

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

  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`API responded ${res.status} for ${path}`);
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
