// Static placeholder data transcribed from the shared design (mocks 2t/2u).
// No backend admin API exists yet — subscriptions, device/platform tracking,
// integration sync, and support tickets aren't real systems yet. This module
// is the explicit, temporary stand-in until that data model exists.

export type LookupStatus = "sync_error" | "ok" | "dunning" | "read_only";

export type LookupRow = {
  id: string;
  email: string;
  plan: string;
  platform: string;
  status: LookupStatus;
  statusLabel: string;
};

export const TOTAL_ACCOUNTS = 1284;

export const lookupRows: LookupRow[] = [
  { id: "48192", email: "ivan.k@example.com", plan: "Annual", platform: "iOS 26.1", status: "sync_error", statusLabel: "⚠ sync error" },
  { id: "51004", email: "m.ferreira@example.com", plan: "Trial · d4", platform: "Android 16", status: "ok", statusLabel: "OK" },
  { id: "40217", email: "coach@alliancebjj.example", plan: "Coach seat", platform: "Web", status: "ok", statusLabel: "OK" },
  { id: "49881", email: "t.nguyen@example.com", plan: "Monthly", platform: "iOS 25.4", status: "dunning", statusLabel: "Dunning" },
  { id: "47733", email: "a.silva@example.com", plan: "Annual", platform: "iOS 26.1", status: "ok", statusLabel: "OK" },
  { id: "38602", email: "j.becker@example.com", plan: "Cancelled", platform: "Android 15", status: "read_only", statusLabel: "Read-only" },
];

export type IntegrationStatus = "ok" | "error" | "none";

export type UserDetail = {
  id: string;
  email: string;
  createdAt: string;
  account: {
    state: string;
    platform: string;
    lastActive: string;
    region: string;
    auth: string;
  };
  subscription: {
    plan: string;
    renews: string;
    billing: string;
    dunning: string;
    refunds: string;
  };
  modules: {
    active: string[];
    inactive: string[];
    activated: string;
    coachAccess: string;
  };
  integrations: {
    lastPoll: string;
    items: { name: string; detail: string; status: IntegrationStatus; statusLabel: string }[];
  };
  supportEvents: { date: string; status: string; label: string }[];
};

// Only one full detail record exists in the design — the rest of
// lookupRows deliberately has no seeded detail (see users/[id]/page.tsx).
export const userDetails: Record<string, UserDetail> = {
  "48192": {
    id: "48192",
    email: "ivan.k@example.com",
    createdAt: "2026-03-02",
    account: {
      state: "Active · email verified",
      platform: "iOS 26.1 · app 1.4.2",
      lastActive: "2026-07-24 08:14",
      region: "US · imperial units",
      auth: "Apple ID",
    },
    subscription: {
      plan: "Annual · $89",
      renews: "2027-03-02",
      billing: "App Store",
      dunning: "none",
      refunds: "none",
    },
    modules: {
      active: ["Strength", "BJJ", "Nutrition"],
      inactive: ["Running off"],
      activated: "Mar 2 · Mar 2 · Mar 4",
      coachAccess: "1 · Prof. Lima (read)",
    },
    integrations: {
      lastPoll: "08:14",
      items: [
        { name: "Apple HealthKit", detail: "sleep, HR, workouts", status: "ok", statusLabel: "OK · synced 08:12" },
        { name: "Android Health Connect", detail: "—", status: "error", statusLabel: "ERROR · token expired" },
        { name: "Bluetooth HR strap", detail: "live sessions", status: "ok", statusLabel: "OK · paired" },
        { name: "Garmin", detail: "not connected", status: "none", statusLabel: "—" },
      ],
    },
    supportEvents: [
      { date: "2026-07-22", status: "open", label: "Ticket #2210 — “plan didn’t update after I moved a lift”" },
      { date: "2026-07-10", status: "completed", label: "Data export requested" },
      { date: "2026-05-18", status: "completed", label: "Password reset" },
      { date: "2026-03-02", status: "—", label: "Signed up · annual" },
    ],
  },
};
