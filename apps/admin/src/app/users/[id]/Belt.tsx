import type { BjjBelt } from "@/lib/api";

/**
 * A jiu-jitsu belt, drawn rather than illustrated — admin's copy of
 * `apps/mobile/components/Belt.tsx` and `apps/web`'s `dashboard/settings/Belt.tsx`.
 * Same three rectangles (strap, rank bar, stripes), same construction rules.
 * No shared package between the three apps, so this is a deliberate third
 * copy rather than an import.
 *
 * Admin only ever reads a rank, never edits one, so this file carries just
 * the swatch — no belt picker, no stripe stepper.
 */

const STRAP: Record<BjjBelt, string> = {
  white: "#EDEAE3",
  blue: "#1B4CC4",
  purple: "#6A2D9B",
  brown: "#5C3A21",
  black: "#1A1A1A",
};

/** Red on a black belt, black on everything else — the actual construction. */
const RANK_BAR: Record<BjjBelt, string> = {
  white: "#1A1A1A",
  blue: "#1A1A1A",
  purple: "#1A1A1A",
  brown: "#1A1A1A",
  black: "#B01B2E",
};

const STRIPE = "#EDEAE3";

export function describeBelt(belt: BjjBelt, stripes = 0, degree = 0): string {
  const name = belt.charAt(0).toUpperCase() + belt.slice(1);
  if (belt === "black" && degree > 0) {
    return `${name} belt, ${degree}${ordinal(degree)} degree`;
  }
  if (stripes > 0) {
    return `${name} belt, ${stripes} ${stripes === 1 ? "stripe" : "stripes"}`;
  }
  return `${name} belt`;
}

function ordinal(n: number): string {
  return n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
}

export function BeltSwatch({
  belt,
  stripes = 0,
  degree = 0,
  width = 96,
  label,
}: {
  belt: BjjBelt;
  stripes?: number;
  degree?: number;
  width?: number;
  label?: string;
}) {
  const height = Math.round(width * 0.17);
  const barWidth = Math.round(width * 0.3);
  // Clamped rather than trusted — a row from an older build degrades to a
  // sensible belt instead of drawing stripes off the end of the strap.
  const count = Math.max(0, Math.min(belt === "black" ? degree : stripes, 6));
  const strap = STRAP[belt] ?? STRAP.white;
  const bar = RANK_BAR[belt] ?? RANK_BAR.white;
  const gap = Math.max(2, Math.round(barWidth * 0.08));
  const barPadding = Math.max(3, Math.round(barWidth * 0.1));

  return (
    <div
      role="img"
      aria-label={label ?? describeBelt(belt, stripes, degree)}
      style={{
        width,
        height,
        backgroundColor: strap,
        borderRadius: 3,
        border: belt === "white" ? "1px solid var(--color-border)" : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        paddingRight: "10%",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          height: "100%",
          width: barWidth,
          backgroundColor: bar,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap,
          paddingLeft: barPadding,
          paddingRight: barPadding,
        }}
      >
        {Array.from({ length: count }, (_, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              maxWidth: 6,
              height: "62%",
              backgroundColor: STRIPE,
              borderRadius: 1,
            }}
          />
        ))}
      </div>
    </div>
  );
}
