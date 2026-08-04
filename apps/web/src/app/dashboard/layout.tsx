import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";

// Imported from `@/lib/modules`, NOT `@/lib/api`. api.ts is a "use client"
// module, and re-exporting through it keeps these client references — a
// Server Component calling one throws at runtime. Verified by running it:
// importing the same names via api.ts still threw "Attempted to call
// listModules() from the server".
import { listModules, type Module } from "@/lib/modules";
import { ModulesProvider } from "@/lib/ModulesProvider";
import { DashboardNav } from "./DashboardNav";
import { ThemeToggle } from "../ThemeToggle";
import { VolaLockup } from "../Brand";

/**
 * The dark shell. A fixed rail rather than a top bar: the destinations are
 * few and stable, and a rail leaves the full viewport height for content —
 * which is the thing desktop is actually here for.
 */
export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Fetched ONCE, server-side, before anything renders.
  //
  // A client-side read would paint the full navigation for one frame and then
  // remove items — a visible flash of destinations the athlete doesn't have.
  // It would also repeat the `useUnits` mistake this codebase documents: a
  // per-call-site profile fetch that cost one request per session rendered.
  //
  // A failure here must not blank the shell. An empty list would hide Library
  // and Records and look like a product decision; falling back to "show
  // everything" degrades toward the pre-gating app, which is merely untidy.
  const { getToken } = await auth();
  let modules: Module[] = [];
  try {
    modules = await listModules(getToken);
  } catch {
    /* nav falls back to ungated below */
  }
  return (
    <ModulesProvider initial={modules}>
      <div className="flex min-h-screen bg-bg">
        <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-line-soft bg-surface">
          <Link
            href="/dashboard"
            className="flex justify-center px-5 py-6"
            aria-label="VOLA, dashboard"
          >
            {/* The wordmark takes `currentColor`, so it is white on the dark
                theme and near-black on the light one without this file knowing
                which is active. */}
            <VolaLockup width={92} />
          </Link>

          <DashboardNav />

          <div className="mt-auto flex flex-col gap-1 border-t border-line-soft p-3">
            <ThemeToggle />
          </div>

          <div className="flex items-center gap-3 border-t border-line-soft px-5 py-4">
            {/* Clerk's widget renders its own surface, so it needs telling
              about the dark ground or it drops a white popover onto it. */}
            <UserButton
              appearance={{ variables: { colorBackground: "#10151f" } }}
            />
            <span className="text-sm text-text-muted">Account</span>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-6xl px-8 py-10">{children}</div>
        </main>
      </div>
    </ModulesProvider>
  );
}
