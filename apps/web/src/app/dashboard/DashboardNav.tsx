"use client";

import { useModules } from "@/lib/ModulesProvider";
import type { Module } from "@/lib/modules";
import { NavLink } from "./NavLink";

/**
 * The rail's destinations, gated by what the athlete trains.
 *
 * **A Client Component, and that is the whole point.** This list used to be
 * computed in `layout.tsx` and rendered as static RSC children. Layouts
 * persist across client navigation, so toggling a discipline in Settings
 * updated the provider — and the sidebar didn't move until a hard reload. The
 * headline interaction of this feature ("turn BJJ off, Library disappears")
 * could not work as architected.
 *
 * The no-flash property is kept by the server still doing the *fetch*: the
 * layout awaits `/v1/modules` and seeds the provider, so this renders the
 * right set on the very first paint rather than correcting itself a frame
 * later.
 *
 * `needs` is a predicate over enabled modules rather than a list of keys,
 * because the interesting questions aren't "is BJJ on":
 *
 *  - **Library** needs some enabled discipline to actually have a catalog.
 *  - **Records** needs some enabled discipline to have record kinds — NOT
 *    "strength is on". Its kinds are heaviest weight, estimated 1RM, most
 *    reps, longest time, furthest distance: two lift-shaped, two run-shaped,
 *    and BJJ has none. A BJJ-only athlete's Records screen can never
 *    populate, and its empty state is written in a vocabulary they don't use.
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

export function DashboardNav() {
  const { modules, known } = useModules();

  // Fail OPEN, not closed. `known` is false only when we could not get an
  // answer at all — and "we couldn't ask" is not "you train nothing". An
  // empty list would hide Library and Records and read as a product decision;
  // showing everything degrades toward the pre-gating app, which is merely
  // untidy. Settings must stay reachable either way, or the toggles that fix
  // it are behind the thing that's broken.
  const visible = navItems.filter((i) => !known || !i.needs || i.needs(modules));

  return (
    <nav className="flex flex-col gap-0.5 px-3" aria-label="Main">
      {visible.map((item) => (
        <NavLink key={item.href} href={item.href} label={item.label} />
      ))}
    </nav>
  );
}
