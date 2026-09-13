import { describe, expect, it } from "vitest";

import { isStuckRowReport, plural } from "@/lib/health";

/**
 * F66 (#1200): a daily stuck-row report shares the `sync_blocked` kind with a
 * give-up, and the Health screen must not badge it as one.
 */
describe("isStuckRowReport", () => {
  it("recognises both stuck-row reasons on a sync_blocked event", () => {
    expect(isStuckRowReport({ kind: "sync_blocked", details: { reason: "stuck_blocked" } })).toBe(true);
    expect(isStuckRowReport({ kind: "sync_blocked", details: { reason: "stuck_refused" } })).toBe(true);
  });

  it("leaves a give-up as a give-up", () => {
    expect(isStuckRowReport({ kind: "sync_blocked", details: { session_id: "abc" } })).toBe(false);
    expect(isStuckRowReport({ kind: "sync_blocked", details: null })).toBe(false);
    expect(isStuckRowReport({ kind: "sync_blocked", details: { reason: "stuck" } })).toBe(false);
  });

  it("only applies to the sync_blocked kind", () => {
    expect(isStuckRowReport({ kind: "client_error", details: { reason: "stuck_refused" } })).toBe(false);
  });
});

describe("plural", () => {
  it("adds an s except for one", () => {
    expect(plural(1, "athlete")).toBe("1 athlete");
    expect(plural(0, "row")).toBe("0 rows");
    expect(plural(3, "athlete")).toBe("3 athletes");
  });
});
