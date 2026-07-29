import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

import { NavLink } from "./NavLink";

const navItems = [
  { href: "/dashboard", label: "Today" },
  { href: "/dashboard/workouts", label: "Workouts" },
  { href: "/dashboard/library", label: "Library" },
];

/**
 * The dark shell. A fixed rail rather than a top bar: the destinations are
 * few and stable, and a rail leaves the full viewport height for content —
 * which is the thing desktop is actually here for.
 */
export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-screen bg-bg">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-line-soft bg-surface">
        <Link href="/dashboard" className="flex items-center gap-2.5 px-5 py-6">
          <Mark />
          <span className="font-display text-xl font-bold tracking-wide">VOLA</span>
        </Link>

        <nav className="flex flex-col gap-0.5 px-3" aria-label="Main">
          {navItems.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} />
          ))}
        </nav>

        <div className="mt-auto flex items-center gap-3 border-t border-line-soft px-5 py-4">
          {/* Clerk's widget renders its own surface, so it needs telling
              about the dark ground or it drops a white popover onto it. */}
          <UserButton appearance={{ variables: { colorBackground: "#10151f" } }} />
          <span className="text-sm text-text-muted">Account</span>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-8 py-10">{children}</div>
      </main>
    </div>
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
