"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { GhostButton } from "@/components/GhostButton";
import { StatusPill, type PillTone } from "@/components/StatusPill";
import { lookupRows, TOTAL_ACCOUNTS, type LookupStatus } from "@/lib/mock-users";

const FILTERS = ["All", "Active", "Trial", "Sync errors", "Cancelled"] as const;
type Filter = (typeof FILTERS)[number];

const statusTone: Record<LookupStatus, PillTone> = {
  ok: "success",
  sync_error: "danger",
  dunning: "danger",
  read_only: "neutral",
};

function matchesFilter(status: LookupStatus, filter: Filter): boolean {
  switch (filter) {
    case "All":
      return true;
    case "Active":
      return status === "ok";
    case "Trial":
      return status === "ok"; // no distinct "trial" status field in the mock data yet
    case "Sync errors":
      return status === "sync_error";
    case "Cancelled":
      return status === "read_only";
  }
}

export default function UserLookupPage() {
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lookupRows
      .filter((row) => matchesFilter(row.status, filter))
      .filter((row) => !q || row.email.toLowerCase().includes(q));
  }, [filter, query]);

  return (
    <div className="min-h-screen w-full">
      <header className="flex w-full items-center justify-between border-b border-border bg-card px-10 py-5">
        <div className="flex items-center gap-4">
          <h1 className="font-barlow-condensed text-[17px] font-bold tracking-[0.1em] uppercase">
            User Lookup
          </h1>
          <span className="text-[13px] text-text-secondary">
            {TOTAL_ACCOUNTS.toLocaleString()} accounts
          </span>
        </div>
        <GhostButton>Saved Views</GhostButton>
      </header>

      <main className="px-10 py-8">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search email, user id, receipt, device id…"
          className="w-full rounded-[10px] border border-border-strong bg-card px-4 py-3 text-sm text-text placeholder:text-text-muted focus:outline-none"
        />

        <div className="flex gap-2 pt-4 pb-6">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-full px-3.5 py-2 text-[11.5px] font-semibold ${
                f === filter
                  ? "bg-accent-dark text-accent-lime"
                  : "border border-border-strong bg-card text-button-text"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-[2fr_1fr_1fr_1fr] px-3 pb-2 font-barlow-condensed text-[9px] font-bold tracking-[0.16em] text-text-muted uppercase">
          <span>Email</span>
          <span>Plan</span>
          <span>Platform</span>
          <span className="justify-self-end">Status</span>
        </div>

        <div className="flex flex-col">
          {rows.map((row, i) => (
            <Link
              key={row.id}
              href={`/users/${row.id}`}
              className={`grid grid-cols-[2fr_1fr_1fr_1fr] items-center rounded-lg px-3 py-4 text-[13.5px] ${
                i % 2 === 0 ? "bg-card" : ""
              }`}
            >
              <span className="font-semibold">{row.email}</span>
              <span className="text-text-secondary">{row.plan}</span>
              <span className="text-text-secondary">{row.platform}</span>
              <span className="justify-self-end">
                <StatusPill tone={statusTone[row.status]}>{row.statusLabel}</StatusPill>
              </span>
            </Link>
          ))}
          {rows.length === 0 && (
            <p className="px-3 py-6 text-sm text-text-secondary">No accounts match this search.</p>
          )}
        </div>

        <div className="flex items-center justify-between px-3 pt-4 text-xs text-text-muted">
          <span>
            {rows.length} of {TOTAL_ACCOUNTS.toLocaleString()}
          </span>
          <div className="flex gap-2">
            <GhostButton>Prev</GhostButton>
            <GhostButton>Next</GhostButton>
          </div>
        </div>
      </main>
    </div>
  );
}
