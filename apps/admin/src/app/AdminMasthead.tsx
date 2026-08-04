import Link from "next/link";
import type { ReactNode } from "react";

import { VolaMark } from "./Brand";

/**
 * The console's masthead: the mark, the page's own name, and where else to go.
 *
 * **A component every page renders, not a shared layout — and that is forced
 * rather than preferred.** Every masthead's content arrives with the page's own
 * data: a technique's name, an athlete's display name and belt, "N known to the
 * API" counted from the very list the table underneath renders. A layout
 * renders *around* a page without seeing any of it, so a layout-owned masthead
 * would need the title pushed back up from the page — a client context, a title
 * that lands a frame after the header paints, and a `"use client"` boundary
 * around chrome that is otherwise entirely static.
 *
 * The decisive case is `content/[id]`, which renders **two different mastheads
 * on two branches of one page**: the seeded dead-end and the edit form. One
 * layout can only render one header. (A shared layout would also mean a
 * `(console)` route group swallowing all three sections, and the per-section
 * authorization gates live in exactly those layouts.)
 *
 * **The mark, not the lockup.** This bar is ~64px tall; `VolaLockup` is 0.66x
 * its own width in height, so at any width where the wordmark is legible it
 * roughly doubles the header. `Brand.tsx` records why there is no wide-and-short
 * arrangement to reach for either — the horizontal lockup's mark is 3.4x its
 * wordmark's height and only balances beside a tagline this product does not
 * ship. So dense chrome gets the mark alone, and the accessible name on its link
 * carries "VOLA Admin". The mark keeps its own three greens rather than taking
 * `currentColor`, so it needs nothing from this header's ground.
 */

const SECTIONS = [
  { key: "users", href: "/users", label: "Users" },
  { key: "content", href: "/content", label: "Techniques" },
  { key: "exercises", href: "/content/exercises", label: "Exercises" },
  { key: "health", href: "/health", label: "Health" },
] as const;

export type ConsoleSection = (typeof SECTIONS)[number]["key"];

/**
 * The mark's rendered height, and the aspect of its own content box — the same
 * 4645x4185 `viewBox` `Brand.tsx` documents.
 *
 * **Both dimensions have to be set.** An `<svg>` with neither defaults to
 * `width: 100%`, so a height alone lets the mark eat the flex line. The ratio
 * is written as the division rather than a rounded px so the intent is legible,
 * but note it is a *second* copy of that `viewBox` — `check:brand-copies` only
 * compares the two `Brand.tsx` files, so this one can drift silently. The
 * failure mode is mild (`preserveAspectRatio` defaults to `xMidYMid meet`, so a
 * wrong ratio letterboxes rather than distorts) and it goes away with the
 * generator that is meant to replace all of this.
 */
const MARK_HEIGHT = 24;
const MARK_ASPECT = 4645 / 4185;

type Props = {
  /** The page's own name. Rendered as its `h1`. */
  title: ReactNode;
  /** Secondary text beside the title — a count, an id, a window. */
  meta?: ReactNode;
  /** Anything else belonging in the title row that isn't plain text. */
  children?: ReactNode;
  /** A primary action, after the navigation. */
  action?: ReactNode;
} & (
  | {
      /** A top-level screen: all three destinations, this one marked current. */
      section: ConsoleSection;
      back?: never;
    }
  | {
      /** A detail screen: up-navigation in place of the cross-console nav. */
      back: { href: string; label: string };
      section?: never;
    }
);

export function AdminMasthead({ title, meta, children, action, section, back }: Props) {
  return (
    <header className="flex w-full items-center justify-between gap-6 border-b border-border bg-card px-10 py-5">
      <div className="flex items-center gap-4">
        {/* Home is `/users`, not `/` — signed in, `/` only redirects here, and
            a masthead logo should not cost a round trip to do it. The link
            carries the accessible name because both brand primitives are
            unconditionally `aria-hidden`. */}
        <Link
          href="/users"
          aria-label="VOLA Admin, user lookup"
          className="flex shrink-0 items-center"
        >
          <VolaMark style={{ height: MARK_HEIGHT, width: MARK_HEIGHT * MARK_ASPECT }} />
        </Link>
        {/* A rule, so the tick doesn't read as a bullet on the title. */}
        <span aria-hidden="true" className="h-6 w-px shrink-0 bg-border-strong" />
        <h1 className="font-barlow-condensed text-[17px] font-bold tracking-[0.1em] uppercase">
          {title}
        </h1>
        {meta && <span className="text-[13px] text-text-secondary">{meta}</span>}
        {children}
      </div>

      {/*
        The current destination is now shown and marked, not omitted. Each page
        used to hand-write the nav minus itself, so the set of links changed as
        you moved and nothing in it said where you were. `aria-current` carries
        that to a screen reader, which weight alone never does — the same
        reasoning as `NavLink` in apps/web. Collapsing the three copies also
        settles which was right: `health` styled its links `hover:underline`
        while the other two used `underline`.

        A detail screen replaces the nav with the up-link it already had rather
        than showing both — four items on the right of a header is a busier bar
        than the one destination anybody leaves a detail page for. It gets a
        plain `div`, not a `nav`: one link is not a navigation landmark, and
        labelling it "Console" would promise the cross-console destinations it
        deliberately doesn't have.
      */}
      {back ? (
        <div className="flex shrink-0 items-center gap-5 text-[13px] text-text-secondary">
          <Link href={back.href} className="underline">
            {back.label}
          </Link>
          {action}
        </div>
      ) : (
        <nav
          aria-label="Console"
          className="flex shrink-0 items-center gap-5 text-[13px] text-text-secondary"
        >
          {SECTIONS.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              aria-current={s.key === section ? "page" : undefined}
              className={s.key === section ? "font-semibold text-text" : "underline"}
            >
              {s.label}
            </Link>
          ))}
          {action}
        </nav>
      )}
    </header>
  );
}
