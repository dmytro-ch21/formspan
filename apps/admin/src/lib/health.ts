import type { HealthEvent } from "@/lib/api";

/**
 * N565's daily stuck-row reports, told apart from give-ups (F66, #1200).
 *
 * The reports reuse the `sync_blocked` kind and carry `details.reason`. The
 * server already leaves them out of `by_kind.sync_blocked` and summarises them
 * as `stuck_rows`; this is the same test for one event, so a report in the
 * event list is not badged as a device that gave up. Keep the reasons in step
 * with `stuckRowReport` in `backend/internal/modules/health/postgres.go`.
 */
export const STUCK_ROW_REASONS: readonly string[] = ["stuck_blocked", "stuck_refused"];

export function isStuckRowReport(event: Pick<HealthEvent, "kind" | "details">): boolean {
  if (event.kind !== "sync_blocked") return false;
  const reason = event.details?.reason;
  return typeof reason === "string" && STUCK_ROW_REASONS.includes(reason);
}

/** "1 athlete", "3 athletes". Regular English plurals only. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
