import Link from "next/link";
import { GhostButton } from "@/components/GhostButton";
import { StatusPill, type PillTone } from "@/components/StatusPill";
import { userDetails, type IntegrationStatus } from "@/lib/mock-users";

const integrationTone: Record<IntegrationStatus, PillTone> = {
  ok: "success",
  error: "danger",
  none: "neutral",
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-barlow-condensed text-[10px] font-bold tracking-[0.2em] text-text-muted uppercase">
      {children}
    </span>
  );
}

function KeyValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-[13px]">
      <span className="text-text-muted">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = userDetails[id];

  if (!user) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="font-barlow-condensed text-xl font-bold tracking-[0.06em] uppercase">
          No mock detail record for this user yet
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          Only one full detail record exists in the shared design so far. Real per-user detail
          is future work once the admin backend exists.
        </p>
        <Link href="/users" className="mt-6 inline-block text-sm underline">
          Back to User Lookup
        </Link>
      </main>
    );
  }

  return (
    <div className="min-h-screen w-full">
      <header className="flex w-full items-center justify-between border-b border-border bg-card px-10 py-5">
        <div className="flex items-center gap-4">
          <span className="font-barlow-condensed text-[17px] font-bold tracking-[0.1em] uppercase">
            {user.email}
          </span>
          <span className="text-[13px] text-text-secondary">
            user #{user.id} · created {user.createdAt}
          </span>
        </div>
        <div className="flex gap-2.5">
          <GhostButton>Impersonate</GhostButton>
          <GhostButton>Resend Receipt</GhostButton>
          <GhostButton>Export Data</GhostButton>
          <GhostButton variant="danger">Suspend</GhostButton>
        </div>
      </header>

      <main className="px-10 py-8">
      <div className="grid grid-cols-3 gap-4 pb-5">
        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
          <SectionLabel>Account</SectionLabel>
          <div className="flex flex-col gap-2">
            <KeyValueRow label="State" value={user.account.state} />
            <KeyValueRow label="Platform" value={user.account.platform} />
            <KeyValueRow label="Last active" value={user.account.lastActive} />
            <KeyValueRow label="Region" value={user.account.region} />
            <KeyValueRow label="Auth" value={user.account.auth} />
          </div>
        </div>

        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
          <SectionLabel>Subscription</SectionLabel>
          <div className="flex flex-col gap-2">
            <KeyValueRow label="Plan" value={user.subscription.plan} />
            <KeyValueRow label="Renews" value={user.subscription.renews} />
            <KeyValueRow label="Billing" value={user.subscription.billing} />
            <KeyValueRow label="Dunning" value={user.subscription.dunning} />
            <KeyValueRow label="Refunds" value={user.subscription.refunds} />
          </div>
        </div>

        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
          <SectionLabel>Modules</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {user.modules.active.map((m) => (
              <span
                key={m}
                className="rounded-full bg-accent-dark px-2.5 py-1.5 text-[11px] font-semibold text-accent-lime"
              >
                {m}
              </span>
            ))}
            {user.modules.inactive.map((m) => (
              <span
                key={m}
                className="rounded-full border border-dashed border-dash-border px-2.5 py-1.5 text-[11px] font-semibold text-text-muted"
              >
                {m}
              </span>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <KeyValueRow label="Activated" value={user.modules.activated} />
            <KeyValueRow label="Coach access" value={user.modules.coachAccess} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[1.2fr_1fr] gap-4 pb-6">
        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
          <div className="flex items-baseline justify-between">
            <SectionLabel>Integrations</SectionLabel>
            <span className="text-xs text-text-secondary">last poll {user.integrations.lastPoll}</span>
          </div>
          <div className="flex flex-col gap-[1px]">
            {user.integrations.items.map((item, i) => (
              <div
                key={item.name}
                className={`grid grid-cols-[1.2fr_1fr_1fr] items-center rounded-md px-1.5 py-2.5 text-[13px] ${
                  i % 2 === 0 ? "bg-row-alt" : ""
                }`}
              >
                <span className="font-semibold">{item.name}</span>
                <span className="text-text-muted">{item.detail}</span>
                <span className="justify-self-end">
                  <StatusPill tone={integrationTone[item.status]}>{item.statusLabel}</StatusPill>
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <GhostButton>Force Re-Sync</GhostButton>
            <GhostButton>View Sync Log</GhostButton>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4">
          <SectionLabel>Recent Support Events</SectionLabel>
          <div className="flex flex-col gap-2.5 text-[13px]">
            {user.supportEvents.map((event) => (
              <div
                key={event.date + event.label}
                className="flex flex-col gap-0.5 border-b border-neutral-bg pb-2"
              >
                <div className="flex justify-between">
                  <span className="text-text-muted">{event.date}</span>
                  <span className={event.status === "open" ? "text-danger-text" : "text-text-muted"}>
                    {event.status}
                  </span>
                </div>
                <span>{event.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      </main>
    </div>
  );
}
