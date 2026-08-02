import Link from "next/link";
import { notFound } from "next/navigation";

import { ApiError, fetchHealth, getUserBjjStanding, getUserDetail } from "@/lib/api";
import type { BjjStanding, HealthEvent } from "@/lib/api";
import { formatUTC } from "@/lib/format";
import { BeltSwatch, describeBelt } from "./Belt";

/**
 * One athlete, as an operator needs to see them.
 *
 * This page used to render `activities` and nothing else — a table that has
 * had no writer since the in-app logging form was removed. So it was
 * permanently empty, and said so in copy that admitted it couldn't tell a
 * wrong id from an idle account: "Either they haven't logged any yet, or the
 * ID doesn't exist — the API returns an empty list for both." Meanwhile the
 * account's real training sat unread in `sessions`.
 *
 * **Two requests for the whole page**, run concurrently:
 *  - `/admin/users/{id}` — summary + recent sessions, itself one round trip
 *    (both queries batched server-side).
 *  - `/admin/health?user_id=…` — has this specific person been hitting errors.
 *
 * Nothing here needed a new write path. Every number is an aggregate over
 * rows that already existed.
 */

const HEALTH_WINDOW_HOURS = 24 * 7;

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [detail, health] = await Promise.all([
    getUserDetail(id).catch((err) => {
      // A 404 is a real answer now: this id exists nowhere. Anything else is
      // a fault and must keep bubbling to the error boundary rather than
      // being flattened into "no such user".
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }),
    // Health is supporting detail. If it fails, the page is still worth
    // rendering — losing the whole account view because the error log is
    // unavailable would be exactly backwards.
    fetchHealth({ hours: HEALTH_WINDOW_HOURS, userID: id }).catch(() => null),
  ]);

  if (!detail) notFound();

  const { user, recent_sessions: sessions } = detail;
  const problems = health?.events ?? [];

  // Only fetched for an athlete who actually trains BJJ — the `Trains`
  // section below already knows this from `user.modules`, and the endpoint
  // itself doesn't distinguish a real user with no rank from one it's never
  // heard of, so there's nothing to learn by asking for a non-BJJ account.
  const standing: BjjStanding | null = user.modules.includes("bjj")
    ? await getUserBjjStanding(id).catch(() => null)
    : null;

  return (
    <div className="min-h-screen w-full">
      <header className="flex w-full items-center justify-between border-b border-border bg-card px-10 py-5">
        <div className="flex items-center gap-4">
          <span className="font-barlow-condensed text-[17px] font-bold tracking-[0.1em] uppercase">
            {user.display_name ?? "User Detail"}
          </span>
          <span className="font-mono text-[12px] text-text-secondary">{id}</span>
          {/* Rank, beside the athlete rather than in a section further down —
              it's read as identity here, the same way a display name is. */}
          {standing?.current && (
            <div className="flex items-center gap-2">
              <BeltSwatch
                belt={standing.current.belt}
                stripes={standing.current.stripes}
                degree={standing.current.degree}
                width={64}
              />
              <span className="text-[12px] text-text-secondary">
                {describeBelt(standing.current.belt, standing.current.stripes, standing.current.degree)}
              </span>
            </div>
          )}
        </div>
        <Link href="/users" className="text-[13px] text-text-secondary underline">
          Back to User Lookup
        </Link>
      </header>

      <main className="flex flex-col gap-4 px-10 py-8">
        <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Sessions" value={String(user.session_count)} />
          <Stat label="Sets" value={String(user.set_count)} />
          <Stat
            label="Last session"
            value={user.last_session_at ? formatUTC(user.last_session_at) : "Never"}
            muted={!user.last_session_at}
          />
          <Stat
            label="Joined"
            value={user.created_at ? formatUTC(user.created_at) : "No profile"}
            muted={!user.created_at}
          />
        </section>

        <section className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
          <SectionLabel>Trains</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {user.modules.length > 0 ? (
              user.modules.map((m) => (
                <span
                  key={m}
                  className="rounded-full border border-border-strong px-3 py-1 text-[12px] text-text-secondary"
                >
                  {m}
                </span>
              ))
            ) : (
              <span className="text-sm text-text-secondary">
                Everything switched off.
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted">
            Disciplines this account has enabled. A discipline they never touched
            reads as its default, not as &quot;off&quot; — the app only stores a row once
            it&apos;s been changed.
          </p>
        </section>

        <section className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
          <div className="flex items-baseline justify-between">
            <SectionLabel>Recent sessions</SectionLabel>
            <span className="text-xs text-text-secondary">
              {sessions.length === user.session_count
                ? `${sessions.length} total`
                : `${sessions.length} most recent of ${user.session_count}`}
            </span>
          </div>

          {sessions.length === 0 ? (
            <p className="py-4 text-sm text-text-secondary">
              This account exists but has never logged a session.
            </p>
          ) : (
            <div className="flex flex-col gap-[1px]">
              <div className="grid grid-cols-[1fr_2fr_1.4fr_1fr_1fr] px-1.5 pb-1 font-barlow-condensed text-[9px] font-bold tracking-[0.16em] text-text-muted uppercase">
                <span>Sport</span>
                <span>Name</span>
                <span>Started</span>
                <span>Sets</span>
                <span>State</span>
              </div>
              {sessions.map((s, i) => (
                <div
                  key={s.id}
                  className={`grid grid-cols-[1fr_2fr_1.4fr_1fr_1fr] items-start rounded-md px-1.5 py-2.5 text-[13px] ${
                    i % 2 === 0 ? "bg-row-alt" : ""
                  }`}
                >
                  <span className="font-semibold">{s.sport}</span>
                  <span className="text-text-secondary">{s.name || "—"}</span>
                  <span className="text-text-secondary">{formatUTC(s.started_at)}</span>
                  <span className="text-text-secondary">{s.set_count}</span>
                  {/* An unfinished session is normal for an hour and a bug
                      report for a week — so it's shown, not hidden. */}
                  <span className={s.ended_at ? "text-text-secondary" : "font-semibold text-text"}>
                    {s.ended_at ? "Finished" : "In progress"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
          <div className="flex items-baseline justify-between">
            <SectionLabel>Problems, last 7 days</SectionLabel>
            <span className="text-xs text-text-secondary">
              {health === null ? "unavailable" : `${problems.length}`}
            </span>
          </div>

          {health === null ? (
            <p className="py-4 text-sm text-text-secondary">
              Couldn&apos;t load the health log. This says nothing about the account —
              the rest of this page is still accurate.
            </p>
          ) : problems.length === 0 ? (
            <p className="py-4 text-sm text-text-secondary">
              No errors, slow requests or blocked syncs recorded for this user.
            </p>
          ) : (
            <div className="flex flex-col gap-[1px]">
              {problems.map((e, i) => (
                <ProblemRow key={e.id} event={e} alt={i % 2 === 0} />
              ))}
            </div>
          )}
        </section>

        <p className="px-1 text-xs text-text-muted">
          Counts are all-time and come from logged training, not from opening the
          app — nothing records a read, so a daily browser who never logs looks
          identical to a churned account. To trace one request end-to-end, grep
          the API&apos;s structured logs for its request ID.
        </p>
      </main>
    </div>
  );
}

function ProblemRow({ event, alt }: { event: HealthEvent; alt: boolean }) {
  return (
    <div
      className={`grid grid-cols-[1fr_1.2fr_2fr_1.4fr] items-start rounded-md px-1.5 py-2.5 text-[13px] ${
        alt ? "bg-row-alt" : ""
      }`}
    >
      <span className="font-semibold">{event.kind}</span>
      <span className="text-text-secondary">{formatUTC(event.occurred_at)}</span>
      <span className="text-text-secondary">
        {event.method && event.path ? `${event.method} ${event.path}` : event.message}
        {event.status ? ` · ${event.status}` : ""}
        {event.duration_ms ? ` · ${event.duration_ms}ms` : ""}
      </span>
      <span className="flex flex-col font-mono text-[11px] text-text-muted">
        {/* `source` first: an operator has to know whether the server measured
            this or an app claimed it before deciding how much to trust it. */}
        <span>{event.source}</span>
        <span>req {event.request_id}</span>
      </span>
    </div>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
      <SectionLabel>{label}</SectionLabel>
      <span className={`text-[20px] font-semibold ${muted ? "text-text-muted" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-barlow-condensed text-[10px] font-bold tracking-[0.2em] text-text-muted uppercase">
      {children}
    </span>
  );
}
