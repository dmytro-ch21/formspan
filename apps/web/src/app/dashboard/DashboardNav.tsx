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
  // Between Today and Workouts on purpose: the calendar is what you open
  // *after* seeing today and *before* editing a template — planning the week
  // is the step between the two, and burying it under Workouts would make it
  // look like a property of templates rather than the surface that uses them.
  //
  // Ungated. Planning needs a discipline to plan, but every athlete has at
  // least the registry's defaults, and unlike Records there is no discipline
  // for which a calendar is structurally empty.
  { href: "/dashboard/calendar", label: "Calendar" },
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
  {
    href: "/dashboard/proficiency",
    label: "Technique funnel",
    // A capability, not a sport name — same reasoning as Records above. The
    // funnel names techniques, so it needs a discipline whose catalog IS
    // techniques; a barbell athlete has nothing for it to list.
    //
    // Mild over-inclusion accepted and worth knowing: the evidence stream is
    // `bjj_session_tags`, so a future discipline with a technique catalog
    // (judo, wrestling) would surface this link and find it empty. That is the
    // right failure — an empty analytical screen with an honest empty state —
    // and better than gating on `key === "bjj"`, which is the check this
    // codebase has deliberately avoided everywhere else.
    needs: (m) =>
      m.some((x) => x.enabled && x.capabilities.catalog === "techniques"),
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
