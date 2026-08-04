import "server-only";

import { currentUser } from "@clerk/nextjs/server";

/**
 * The admin allowlist, shared by every gate in this app.
 *
 * Matches the backend's ADMIN_USER_IDS (auth.RequireAdmin) — one admin-identity
 * convention across the stack, keyed by Clerk user ID rather than email so both
 * sides check the same thing.
 *
 * Extracted here because a SERVER ACTION needs it too, and that is not obvious:
 * `content/layout.tsx` gates what renders, but a server action is a POST
 * endpoint the router exposes on its own. Nothing about being defined in a
 * gated route segment protects it — an unauthorized caller who never loads the
 * page can still invoke it. The backend's RequireAdmin is the real boundary and
 * would reject them, but a write path that depends on the layout it happens to
 * sit under is a gate by coincidence.
 */
export function isAllowedAdmin(userId: string | undefined): boolean {
  if (!userId) return false;
  const allowlist = (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return allowlist.includes(userId);
}

/**
 * Throws unless the caller is on the allowlist. For server actions, which have
 * no layout above them to refuse first.
 */
export async function assertAdmin(): Promise<void> {
  const user = await currentUser();
  if (!isAllowedAdmin(user?.id)) {
    throw new Error("Not authorized.");
  }
}
