"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

import { getPendingCounts } from "@/lib/api";
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
  /** Which pending-count keys this destination can actually DO something
   *  about. A badge on a screen that cannot act on what it counts is a dead
   *  end, so this is deliberately not "every count the server returns".
   *
   *  `friend_requests` used to be excluded on exactly that ground — they were
   *  answered on the phone and web had no screen for them. `/dashboard/friends`
   *  is that screen, so the rule is now SATISFIED rather than waived, and the
   *  count is badged where it can be answered. */
  badges?: string[];
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
    href: "/dashboard/curricula",
    label: "Curricula",
    // Same capability predicate as the funnel below, and the same accepted
    // over-inclusion: a curriculum is an ordered set of TECHNIQUES, so it needs
    // a discipline whose catalog is techniques. Gating on `key === "bjj"` is
    // the check this codebase avoids everywhere else.
    needs: (m) =>
      m.some((x) => x.enabled && x.capabilities.catalog === "techniques"),
  },
  {
    href: "/dashboard/sequences",
    label: "Sequences",
    // Directly after Curricula, because the two are neighbours in kind: both
    // are ordered sets of techniques the athlete owns. What differs is what the
    // order MEANS — pedagogical there, causal here — and putting them side by
    // side is what makes that difference legible rather than filing one under
    // Library as though it were reference content.
    //
    // Same capability predicate as Curricula, and the same accepted
    // over-inclusion: a sequence is a chain of TECHNIQUES, so it needs a
    // discipline whose catalog is techniques. Gating on `key === "bjj"` is the
    // check this codebase avoids everywhere else.
    needs: (m) =>
      m.some((x) => x.enabled && x.capabilities.catalog === "techniques"),
  },
  {
    href: "/dashboard/classplans",
    label: "Class plans",
    // Directly after Sequences, the third member of the same family: all
    // three are ordered technique-catalog lists an athlete owns, and what
    // differs each time is what the order MEANS — pedagogical for a
    // curriculum, causal for a sequence, a SCHEDULE here (ten minutes of
    // this, then fifteen of that). Same capability predicate as its two
    // neighbours, and the same accepted over-inclusion: a class plan's
    // technique_drill blocks point at TECHNIQUES, so it needs a discipline
    // whose catalog is techniques, not `key === "bjj"` specifically.
    needs: (m) =>
      m.some((x) => x.enabled && x.capabilities.catalog === "techniques"),
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
  {
    href: "/dashboard/nutrition",
    label: "Nutrition",
    // UNGATED, unlike the four above it, and the reason is that nutrition is
    // not a discipline. The registry gates destinations on what an athlete
    // TRAINS — a catalog to browse, record kinds that can populate — and
    // eating is orthogonal to all of it: a BJJ-only athlete and a
    // powerlifter have exactly the same nutrition screen.
    //
    // Placed after History and the discipline surfaces rather than beside
    // Today, because everything behind it is review and authoring. Logging a
    // meal is the phone's.
  },
  {
    href: "/dashboard/friends",
    label: "Friends",
    // Requests waiting on YOU, which this screen accepts and declines from —
    // the count is incoming-only server-side, so it never badges something you
    // sent and cannot answer.
    //
    // UNGATED for the same reason Sharing is: who asks to be your friend is
    // decided by other people, not by which disciplines you have enabled.
    badges: ["friend_requests"],
  },
  {
    href: "/dashboard/shared",
    label: "Sharing",
    // The share inbox, which this screen accepts and declines from. NOT
    // `friend_requests` — those are badged on Friends, one row up, which is
    // where they can be answered.
    badges: ["shares"],
    // UNGATED, unlike everything above it, and deliberately: what lands here
    // is decided by other people. Gating it on the recipient's own enabled
    // disciplines would hide a real thing a real friend sent — a chain from a
    // partner is exactly how somebody discovers a discipline they have not
    // turned on yet. The screen is generic over resource_type for the same
    // reason, so nothing but this one line changes when plans join it.
  },
  { href: "/dashboard/settings", label: "Settings" },
];

export function DashboardNav() {
  const { modules, known } = useModules();
  const { getToken } = useAuth();
  const pathname = usePathname();
  const [counts, setCounts] = useState<Record<string, number>>({});

  // POLLED ON NAVIGATION, not live and not on a timer.
  //
  // No websocket and no interval: the number's job is to stop a share sitting
  // unnoticed for days, not to update within seconds, and a timer in the
  // persistent layout would run for every athlete on every open tab forever.
  // Refetching when the route changes covers the case that matters — you
  // accept something, move on, and the badge is right when you next look —
  // and the layout persists across client navigation, so this component is
  // not remounting each time.
  const inflight = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    inflight.current?.abort();
    const c = new AbortController();
    inflight.current = c;
    getPendingCounts(getToken, c.signal)
      .then((next) => {
        if (!c.signal.aborted) setCounts(next);
      })
      .catch(() => {
        // Silent, and it keeps the LAST known counts rather than zeroing them.
        // A badge is not worth an error banner in a sidebar — but zeroing on
        // failure would actively assert "nothing is waiting", which is the one
        // thing this must never say. See the backend: a failed counter fails
        // the whole request for the same reason.
      });
  }, [getToken]);

  useEffect(() => {
    load();
    return () => inflight.current?.abort();
  }, [load, pathname]);

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
        <NavLink
          key={item.href}
          href={item.href}
          label={item.label}
          count={(item.badges ?? []).reduce((n, key) => n + (counts[key] ?? 0), 0)}
        />
      ))}
    </nav>
  );
}
