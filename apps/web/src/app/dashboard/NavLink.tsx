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
export function NavLink({ href, label }: { href: string; label: string }) {
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
    </Link>
  );
}
