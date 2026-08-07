"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * A rail item that knows whether it's current.
 *
 * The active state is a lime rule down the left edge rather than a filled
 * pill — the accent means "you are here", and a fill would make the whole
 * rail shout. `aria-current` carries the same fact to screen readers, which
 * a colour alone never does.
 */
/** The server caps every count here — see friend.maxBadgeCount. At the cap the
 *  value means "this many or more", so the badge says so rather than
 *  presenting a capped number as exact. */
const BADGE_CAP = 100;

export function NavLink({
  href,
  label,
  count = 0,
}: {
  href: string;
  label: string;
  /** How many things are waiting behind this destination. 0 renders nothing —
   *  a badge showing "0" is noise pretending to be information. */
  count?: number;
}) {
  const pathname = usePathname();
  // Exact match for the index so /dashboard doesn't light up on every child.
  const active = href === "/dashboard" ? pathname === href : pathname.startsWith(href);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
        active ? "bg-surface-raised text-text" : "text-text-muted hover:bg-surface-hover hover:text-text"
      }`}
    >
      {active && (
        <span
          aria-hidden="true"
          className="accent-rule absolute top-2 bottom-2 left-0 w-[3px] rounded-full"
        />
      )}
      {label}
      {count > 0 && (
        // The number is inside the link's accessible name rather than beside
        // it as a bare numeral: a screen reader reading "Sharing 3" says
        // nothing useful, and "Sharing, 3 waiting" is the whole point.
        // `bg-accent-fill`/`text-accent-on-fill`, NOT `bg-accent` — which is
        // not a token in this app, so Tailwind v4 generates nothing for it and
        // the build stays green while the pill renders with no background at
        // all. In the default light theme that is white-on-white: invisible to
        // sighted users while the sr-only text below still announces a count.
        // Review caught it by grepping the compiled CSS, which is the only
        // place the absence is visible. The pair here is the house one (see
        // the NEW chip on the records screen) and inverts correctly between
        // themes: navy pill / lime text in light, the reverse in dark.
        <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-accent-fill px-1.5 py-0.5 text-xs font-semibold text-accent-on-fill tabular-nums">
          {/* ">= cap" rather than "> cap": at the cap the number stops being
              exact, so presenting it as one would be a small lie. */}
          <span aria-hidden="true">{count >= BADGE_CAP ? `${BADGE_CAP - 1}+` : count}</span>
          <span className="sr-only">
            , {count >= BADGE_CAP ? `over ${BADGE_CAP - 1}` : count} waiting
          </span>
        </span>
      )}
    </Link>
  );
}
