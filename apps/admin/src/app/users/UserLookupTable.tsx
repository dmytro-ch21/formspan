"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AdminUserSummary } from "@/lib/api";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function UserLookupTable({ users }: { users: AdminUserSummary[] }) {
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.user_id.toLowerCase().includes(q) ||
        (u.display_name ?? "").toLowerCase().includes(q),
    );
  }, [users, query]);

  return (
    <>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search user id or display name…"
        className="w-full rounded-[10px] border border-border-strong bg-card px-4 py-3 text-sm text-text placeholder:text-text-muted focus:outline-none"
      />

      <div className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr] px-3 pt-6 pb-2 font-barlow-condensed text-[9px] font-bold tracking-[0.16em] text-text-muted uppercase">
        <span>User ID</span>
        <span>Display name</span>
        <span>Activities</span>
        <span className="justify-self-end">Last activity</span>
      </div>

      <div className="flex flex-col">
        {rows.map((u, i) => (
          <Link
            key={u.user_id}
            href={`/users/${u.user_id}`}
            className={`grid grid-cols-[2fr_1.5fr_1fr_1.5fr] items-center rounded-lg px-3 py-4 text-[13.5px] ${
              i % 2 === 0 ? "bg-card" : ""
            }`}
          >
            <span className="font-mono text-[12px] font-semibold">{u.user_id}</span>
            <span className="text-text-secondary">{u.display_name ?? "—"}</span>
            <span className="text-text-secondary">{u.activity_count}</span>
            <span className="justify-self-end text-text-secondary">
              {formatDate(u.last_activity_at)}
            </span>
          </Link>
        ))}
        {rows.length === 0 && (
          <p className="px-3 py-6 text-sm text-text-secondary">
            {users.length === 0
              ? "No users yet — a user appears here once they have a profile."
              : "No users match this search."}
          </p>
        )}
      </div>

      <div className="px-3 pt-4 text-xs text-text-muted">
        {rows.length} of {users.length}
      </div>
    </>
  );
}
