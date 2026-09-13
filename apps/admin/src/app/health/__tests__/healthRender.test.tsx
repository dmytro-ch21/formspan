/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HealthEvent, HealthReport } from "@/lib/api";

vi.mock("@/lib/api", () => ({ fetchHealth: vi.fn() }));
vi.mock("../../AdminMasthead", () => ({ AdminMasthead: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import { fetchHealth } from "@/lib/api";
import HealthPage from "../page";

/**
 * F66 (#1200): what the operator reads on the Health screen once N565's daily
 * stuck-row reports stop counting as give-ups.
 *
 * The server's split is pinned by `health/postgres_test.go`. This pins the
 * other half: that the screen reads the split fields, and that a report in the
 * event list is not badged as a device that gave up.
 */

afterEach(cleanup);

function event(id: number, kind: HealthEvent["kind"], details: HealthEvent["details"]): HealthEvent {
  return {
    id,
    occurred_at: "2026-09-13T08:00:00Z",
    source: "client",
    kind,
    user_id: `user_${id}`,
    method: null,
    path: null,
    status: null,
    duration_ms: null,
    error_code: "error",
    message: `event ${id}`,
    request_id: `req${id}`,
    trace_id: "",
    details,
  };
}

function report(overrides: Partial<HealthReport["summary"]> = {}, events: HealthEvent[] = []): HealthReport {
  return {
    summary: {
      since: "2026-09-12T08:00:00Z",
      total: 10,
      by_kind: { sync_blocked: 1, server_error: 0 },
      affected_users: 3,
      slowest_paths_ms: {},
      stuck_row_reports: 9,
      stuck_row_athletes: 2,
      stuck_rows: [
        { entity: "food_entry", state: "refused", code: "invalid_input", athletes: 2, rows: 4 },
        { entity: "session", state: "blocked", code: "unknown", athletes: 1, rows: 1 },
      ],
      ...overrides,
    },
    events,
  };
}

/** The number in the stat card whose label is `label`. */
function statValue(label: string): string | null {
  const card = screen.getAllByText(label).find((el) => el.parentElement?.firstElementChild !== el);
  return card?.parentElement?.firstElementChild?.textContent ?? null;
}

describe("Health screen — stuck-row reports are not give-ups", () => {
  it("shows Sync blocked from by_kind alone, not from the reports", async () => {
    vi.mocked(fetchHealth).mockResolvedValue(report());
    render(await HealthPage());

    expect(statValue("Sync blocked")).toBe("1");
  });

  it("lists stuck rows by domain, state and code, with athletes and rows", async () => {
    vi.mocked(fetchHealth).mockResolvedValue(report());
    render(await HealthPage());

    expect(screen.getByRole("heading", { name: "Stuck rows" })).toBeTruthy();
    expect(screen.getByText(/^2 athletes reported rows their phone could not sync\./)).toBeTruthy();

    const food = screen.getByText("food_entry").closest("div");
    expect(food).not.toBeNull();
    expect(within(food as HTMLElement).getByText("refused")).toBeTruthy();
    expect(within(food as HTMLElement).getByText("invalid_input")).toBeTruthy();
    expect(within(food as HTMLElement).getByText("2 athletes · 4 rows")).toBeTruthy();

    const session = screen.getByText("session").closest("div");
    expect(within(session as HTMLElement).getByText("1 athlete · 1 row")).toBeTruthy();
  });

  it("leaves the section out when no athlete reported stuck rows", async () => {
    vi.mocked(fetchHealth).mockResolvedValue(
      report({ stuck_row_reports: 0, stuck_row_athletes: 0, stuck_rows: [] }),
    );
    render(await HealthPage());

    expect(screen.queryByRole("heading", { name: "Stuck rows" })).toBeNull();
  });

  it("badges a report as Stuck rows and a give-up as Sync blocked", async () => {
    vi.mocked(fetchHealth).mockResolvedValue(
      report({}, [
        event(1, "sync_blocked", { session_id: "abc" }),
        event(2, "sync_blocked", { reason: "stuck_refused", entity: "food_entry", code: "invalid_input", rows: 1 }),
      ]),
    );
    render(await HealthPage());

    const giveUp = screen.getByText("event 1").parentElement as HTMLElement;
    const stuck = screen.getByText("event 2").parentElement as HTMLElement;
    expect(within(giveUp).getByText("Sync blocked")).toBeTruthy();
    expect(within(stuck).getByText("Stuck rows")).toBeTruthy();
    expect(within(stuck).queryByText("Sync blocked")).toBeNull();
  });
});
