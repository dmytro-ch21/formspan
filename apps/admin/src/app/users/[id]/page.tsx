import Link from "next/link";
import { listUserActivities } from "@/lib/api";
import { formatUTC } from "@/lib/format";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-barlow-condensed text-[10px] font-bold tracking-[0.2em] text-text-muted uppercase">
      {children}
    </span>
  );
}

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const activities = await listUserActivities(id);

  return (
    <div className="min-h-screen w-full">
      <header className="flex w-full items-center justify-between border-b border-border bg-card px-10 py-5">
        <div className="flex items-center gap-4">
          <span className="font-barlow-condensed text-[17px] font-bold tracking-[0.1em] uppercase">
            User Detail
          </span>
          <span className="font-mono text-[12px] text-text-secondary">{id}</span>
        </div>
        <Link href="/users" className="text-[13px] text-text-secondary underline">
          Back to User Lookup
        </Link>
      </header>

      <main className="flex flex-col gap-4 px-10 py-8">
        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
          <div className="flex items-baseline justify-between">
            <SectionLabel>Activities</SectionLabel>
            <span className="text-xs text-text-secondary">
              {activities.length} total
            </span>
          </div>

          {activities.length === 0 ? (
            <p className="py-4 text-sm text-text-secondary">
              No activities for this user ID. Either they haven&apos;t logged any yet, or the ID
              doesn&apos;t exist — the API returns an empty list for both.
            </p>
          ) : (
            <div className="flex flex-col gap-[1px]">
              <div className="grid grid-cols-[1fr_1.2fr_2fr_1.4fr] px-1.5 pb-1 font-barlow-condensed text-[9px] font-bold tracking-[0.16em] text-text-muted uppercase">
                <span>Kind</span>
                <span>Occurred</span>
                <span>Notes</span>
                <span>Request / trace</span>
              </div>
              {activities.map((a, i) => (
                <div
                  key={a.id}
                  className={`grid grid-cols-[1fr_1.2fr_2fr_1.4fr] items-start rounded-md px-1.5 py-2.5 text-[13px] ${
                    i % 2 === 0 ? "bg-row-alt" : ""
                  }`}
                >
                  <span className="font-semibold">{a.kind}</span>
                  <span className="text-text-secondary">{formatUTC(a.occurred_at)}</span>
                  <span className="text-text-secondary">{a.notes ?? "—"}</span>
                  <span className="flex flex-col font-mono text-[11px] text-text-muted">
                    <span>req {a.request_id}</span>
                    <span>trace {a.trace_id}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="px-1 text-xs text-text-muted">
          To trace a sync request end-to-end, grep the API&apos;s structured log output for its
          request ID — e.g. <code className="font-mono">request_id=&quot;…&quot;</code>. There is no
          in-app log viewer yet.
        </p>
      </main>
    </div>
  );
}
