"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The four things N28 is: read the history back, decide the target, author a
 * recipe, correct a past day.
 *
 * Sub-navigation rather than four entries on the main rail, because they are
 * one athlete-facing subject and the rail is already eleven items long. It is
 * also the boundary of the platform split in this app: everything reachable
 * from here is a desk activity. **Nothing here logs a meal you are eating
 * now** — that is the phone's, and the day screen behind "Correct a day" is
 * explicitly for going back and fixing what is already there.
 */
const SECTIONS = [
  { href: "/dashboard/nutrition", label: "Trend", exact: true },
  { href: "/dashboard/nutrition/targets", label: "Target" },
  { href: "/dashboard/nutrition/recipes", label: "Recipes" },
  { href: "/dashboard/nutrition/days", label: "Correct a day" },
];

export function NutritionNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Nutrition">
      {SECTIONS.map((s) => {
        const active = s.exact ? pathname === s.href : pathname.startsWith(s.href);
        return (
          <Link
            key={s.href}
            href={s.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              active
                ? // `text-lime-ink`, not `text-lime`: lime on a 10% wash of its
                  // own hue is below AA in light mode, and `--c-lime-ink`
                  // exists for exactly this pairing while resolving to the
                  // same neon on dark.
                  "border-lime bg-lime/10 text-lime-ink"
                : "border-line text-text-muted hover:text-text"
            }`}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
