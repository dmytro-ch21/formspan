import Link from "next/link";

import { fetchHealth, type HealthEvent, type HealthEventKind } from "@/lib/api";

/**
 * Health — is anything wrong, and for whom.
 *
 * The structured logs already carry every request, but they go to stdout and
 * are read through Railway's viewer: not queryable from here, expiring, and —
 * until this change — carrying no user id at all, which made "is this athlete
 * having problems?" impossible rather than merely awkward. So notable events
 * are persisted, and this reads them back.
 *
 * The page opens on a summary because the first question is never "show me
 * every row", it is "is anything on fire". The rows are underneath for when the
 * answer is yes.
 */
export const dynamic = "force-dynamic";

const WINDOW_HOURS = 24;

/**
 * How each kind reads at a glance. `sync_blocked` is the one that matters most
 * and the one no server-side metric can see: a client has given up pushing, so
 * the training exists only on that device while every API dashboard stays
 * green.
 */
const KIND_LABEL: Record<HealthEventKind, string> = {
  server_error: "Server error",
  slow_request: "Slow",
  client_error: "Client error",
  sync_blocked: "Sync blocked",
};

/**
 * Two tones, not four. The design system has one danger pair and one neutral
 * pair, and inventing a third for "slow" would mean adding tokens to express a
 * distinction the badge text already makes.
 */
const KIND_TONE: Record<HealthEventKind, string> = {
  server_error: "bg-danger-bg text-danger-text",
  sync_blocked: "bg-danger-bg text-danger-text",
  slow_request: "bg-neutral-bg text-text-secondary",
  client_error: "bg-neutral-bg text-text-secondary",
};

export default async function HealthPage() {
  const { summary, events } = await fetchHealth({ hours: WINDOW_HOURS });
  const quiet = summary.total === 0;

  return (
    <div className="min-h-screen w-full">
      <header className="flex w-full items-center justify-between border-b border-border bg-card px-10 py-5">
        <div className="flex items-center gap-4">
          <h1 className="font-barlow-condensed text-[17px] font-bold tracking-[0.1em] uppercase">
            Health
          </h1>
          <span className="text-[13px] text-text-secondary">last {WINDOW_HOURS} hours</span>
        </div>
        <nav className="flex items-center gap-5 text-[13px] text-text-secondary">
          <Link href="/users" className="hover:underline">
            Users
          </Link>
          <Link href="/content" className="hover:underline">
            Content
          </Link>
        </nav>
      </header>

      <main className="flex flex-col gap-8 px-10 py-8">
        <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Events" value={String(summary.total)} />
          {/*
            People, not events. Twenty rows from one athlete on a bad
            connection is a very different morning from twenty athletes hitting
            one broken endpoint, and the total cannot tell them apart.
          */}
          <Stat label="Athletes affected" value={String(summary.affected_users)} />
          <Stat label="Server errors" value={String(summary.by_kind.server_error ?? 0)} />
          <Stat label="Sync blocked" value={String(summary.by_kind.sync_blocked ?? 0)} />
        </section>

        {Object.keys(summary.slowest_paths_ms).length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="font-barlow-condensed text-[13px] font-bold tracking-[0.1em] text-text-secondary uppercase">
              Slowest routes
            </h2>
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
              {Object.entries(summary.slowest_paths_ms)
                .sort((a, b) => b[1] - a[1])
                .map(([path, ms]) => (
                  <div key={path} className="flex items-center justify-between px-4 py-3">
                    <code className="text-[13px]">{path}</code>
                    <span className="text-[13px] tabular-nums text-text-secondary">
                      {(ms / 1000).toFixed(1)}s
                    </span>
                  </div>
                ))}
            </div>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="font-barlow-condensed text-[13px] font-bold tracking-[0.1em] text-text-secondary uppercase">
            Recent events
          </h2>

          {/*
            An empty health page is the good outcome, and it should read that
            way rather than as a screen that failed to load. A fetch failure
            surfaces through error.tsx instead, so reaching here means the
            answer really is "nothing".
          */}
          {quiet ? (
            <p className="rounded-lg border border-border bg-card px-4 py-6 text-[13px] text-text-secondary">
              Nothing recorded in the last {WINDOW_HOURS} hours. Only server errors, slow requests
              and problems reported by a client are stored — a quiet page means none of those
              happened.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
              {events.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3">
      <span className="text-[22px] font-bold tabular-nums">{value}</span>
      <span className="text-[12px] text-text-secondary">{label}</span>
    </div>
  );
}

function EventRow({ event: e }: { event: HealthEvent }) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase ${KIND_TONE[e.kind]}`}
        >
          {KIND_LABEL[e.kind]}
        </span>
        {/*
          Measured vs claimed. The server saw an `api` event happen; a `client`
          event is an app's account of something the server has no way to
          verify. Worth stating before anyone acts on it.
        */}
        {e.source === "client" && (
          <span className="rounded bg-neutral-bg px-2 py-0.5 text-[11px] text-text-secondary">
            reported by client
          </span>
        )}
        {e.path && (
          <code className="text-[13px]">
            {e.method} {e.path}
          </code>
        )}
        {e.status != null && <span className="text-[13px] tabular-nums">{e.status}</span>}
        {e.duration_ms != null && (
          <span className="text-[13px] tabular-nums text-text-secondary">
            {(e.duration_ms / 1000).toFixed(1)}s
          </span>
        )}
        <span className="ml-auto text-[12px] text-text-secondary">
          {new Date(e.occurred_at).toLocaleString()}
        </span>
      </div>

      {e.message && <p className="text-[13px] text-text-secondary">{e.message}</p>}

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-text-secondary">
        {e.user_id ? (
          <Link href={`/users/${encodeURIComponent(e.user_id)}`} className="hover:underline">
            {e.user_id}
          </Link>
        ) : (
          <span>no user (unauthenticated)</span>
        )}
        {/*
          The pivot the whole table exists to enable: this row says *that*
          something went wrong, the log line for this request id says what it
          was doing at the time.
        */}
        {e.request_id && <code>req {e.request_id}</code>}
        {e.error_code && <code>{e.error_code}</code>}
      </div>
    </div>
  );
}
