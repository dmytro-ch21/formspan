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
        <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 py-0.5 text-xs font-semibold text-white tabular-nums">
          <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
          <span className="sr-only">, {count} waiting</span>
        </span>
      )}
    </Link>
  );
}
