import type { BjjBelt } from "@/lib/api";

/**
 * A jiu-jitsu belt, drawn rather than illustrated — the CSS twin of
 * `apps/mobile/components/Belt.tsx`. Same three rectangles (strap, rank bar,
 * stripes), same construction rules, so the desk and the phone agree on what
 * a rank looks like. No shared package between the two apps, so this is a
 * deliberate second copy rather than an import — see the note at the top of
 * the mobile version for why an asset pipeline wasn't worth it there either.
 *
 * Belt colours are fixed brand facts, not theme tokens: a blue belt is the
 * same blue in light and dark mode, so these are literal hex values rather
 * than `--c-*` references.
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
  width = 160,
  label,
}: {
  belt: BjjBelt;
  /** 0–4 on any belt. Clamped rather than trusted — see below. */
  stripes?: number;
  /** Black-belt degrees, 0–6. Rendered in the rank bar exactly like stripes. */
  degree?: number;
  width?: number;
  /** Accessible name. Callers pass the same text they show beside it. */
  label?: string;
}) {
  const height = Math.round(width * 0.17);
  const barWidth = Math.round(width * 0.3);

  // Clamped here, not trusted from the caller — a row rendered from an older
  // build should degrade to a sensible belt rather than draw seven stripes
  // off the end of the strap.
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
        // Only the white belt needs an edge — every other strap is legible
        // on its own against either theme's ground.
        border: belt === "white" ? "1px solid var(--c-line)" : "none",
        display: "flex",
        alignItems: "center",
        // The rank bar sits near one end of a real belt, not in the middle.
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
