import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";

import { listModules, type Module } from "@/lib/api";
import { ModulesProvider } from "@/lib/ModulesProvider";
import { NavLink } from "./NavLink";
import { ThemeToggle } from "../ThemeToggle";

/**
 * Destinations, and what each needs to be worth showing.
 *
 * `needs` is a predicate over the athlete's enabled modules rather than a list
 * of discipline keys, because the interesting cases aren't "is BJJ on":
 *
 *  - **Library** needs some enabled discipline to actually have a catalog.
 *  - **Records** needs some enabled discipline to have record kinds — NOT
 *    "strength is on". Its five kinds are heaviest weight, estimated 1RM, most
 *    reps, longest time, furthest distance: two are lift-shaped, two are
 *    run-shaped, and BJJ has none. A BJJ-only athlete's Records screen can
 *    never populate, and its empty state ("log a few working sets") is written
 *    in a vocabulary they don't use.
 *
 * Everything else is universal: sessions, days and duration mean the same
 * thing whatever you train.
 */
const navItems: {
  href: string;
  label: string;
  needs?: (m: Module[]) => boolean;
}[] = [
  { href: "/dashboard", label: "Today" },
  { href: "/dashboard/workouts", label: "Workouts" },
  { href: "/dashboard/sessions", label: "History" },
  {
    href: "/dashboard/records",
    label: "Records",
    needs: (m) =>
      m.some((x) => x.enabled && x.capabilities.record_kinds.length > 0),
  },
  {
    href: "/dashboard/library",
    label: "Library",
    needs: (m) => m.some((x) => x.enabled && x.capabilities.catalog !== ""),
  },
  { href: "/dashboard/settings", label: "Settings" },
];

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
  const known = modules.length > 0;
  const visible = navItems.filter(
    (i) => !known || !i.needs || i.needs(modules),
  );

  return (
    <ModulesProvider initial={modules}>
      <div className="flex min-h-screen bg-bg">
        <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-line-soft bg-surface">
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 px-5 py-6"
          >
            <Mark />
            <span className="font-display text-xl font-bold tracking-wide">
              VOLA
            </span>
          </Link>

          <nav className="flex flex-col gap-0.5 px-3" aria-label="Main">
            {visible.map((item) => (
              <NavLink key={item.href} href={item.href} label={item.label} />
            ))}
          </nav>

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

/** The VOLA check, inlined so the rail renders without a network request. */
function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 1024 1024" aria-hidden="true">
      <defs>
        <linearGradient
          id="vola-rail-mark"
          x1="120"
          y1="360"
          x2="410"
          y2="100"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#42F58D" />
          <stop offset="1" stopColor="#B8FF2C" />
        </linearGradient>
      </defs>
      <g transform="translate(190 180) scale(1.25)">
        <path
          d="M120 270 L220 365 L405 135"
          stroke="url(#vola-rail-mark)"
          strokeWidth="58"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </g>
    </svg>
  );
}
