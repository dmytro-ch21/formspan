"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AdminUserSummary } from "@/lib/api";
import { formatUTC } from "@/lib/format";

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
      <label htmlFor="user-search" className="sr-only">
        Search users by ID or display name
      </label>
      <input
        id="user-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search user id or display name…"
        className="w-full rounded-[10px] border border-border-strong bg-card px-4 py-3 text-sm text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark"
      />

      <div className="grid grid-cols-[1.6fr_1.2fr_0.6fr_0.6fr_1.3fr_1.2fr] px-3 pt-6 pb-2 font-barlow-condensed text-[9px] font-bold tracking-[0.16em] text-text-muted uppercase">
        <span>User ID</span>
        <span>Display name</span>
        <span>Sessions</span>
        <span>Sets</span>
        <span>Trains</span>
        <span className="justify-self-end">Last session</span>
      </div>

      <div className="flex flex-col">
        {rows.map((u, i) => (
          <Link
            key={u.user_id}
            href={`/users/${u.user_id}`}
            className={`grid grid-cols-[1.6fr_1.2fr_0.6fr_0.6fr_1.3fr_1.2fr] items-center rounded-lg px-3 py-4 text-[13.5px] ${
              i % 2 === 0 ? "bg-card" : ""
            }`}
          >
            <span className="font-mono text-[12px] font-semibold">{u.user_id}</span>
            <span className="text-text-secondary">{u.display_name ?? "—"}</span>
            <span className="text-text-secondary">{u.session_count}</span>
            <span className="text-text-secondary">{u.set_count}</span>
            <span className="truncate text-text-secondary" title={u.modules.join(", ")}>
              {u.modules.length > 0 ? u.modules.join(", ") : "—"}
            </span>
            <span className="justify-self-end text-text-secondary">
              {formatUTC(u.last_session_at)}
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
