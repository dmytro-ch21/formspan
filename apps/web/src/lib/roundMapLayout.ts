import type { RoundMapBand, RoundMapNode } from "@/lib/api";

/**
 * Where the round map's boxes go.
 *
 * Extracted from the view because the one property that matters here is
 * arithmetic and a browser cannot be asked about it in CI: **tier is ORDERING,
 * NOT ARITHMETIC.** The server's own comment says so — the gap between two
 * tiers means nothing and several nodes share one — so rows are laid out by
 * their RANK among the distinct tiers present. Spacing proportionally would put
 * four empty rows between mount (4) and standing (0) and imply a distance that
 * does not exist.
 */

export const NODE_W = 168;
export const NODE_H = 76;
export const GAP_X = 22;
export const ROW_H = 132;
export const PAD_X = 28;
export const PAD_TOP = 16;

export type Placed = RoundMapNode & { x: number; y: number };

export type Layout = { placed: Placed[]; width: number; height: number };

export function layout(nodes: RoundMapNode[]): Layout {
  if (nodes.length === 0) return { placed: [], width: 0, height: 0 };

  const tiers = [...new Set(nodes.map((n) => n.tier))].sort((a, b) => b - a);
  const rows = tiers.map((t) => nodes.filter((n) => n.tier === t));
  const widest = Math.max(...rows.map((r) => r.length));
  const width = widest * NODE_W + (widest - 1) * GAP_X + PAD_X * 2;

  const placed: Placed[] = [];
  rows.forEach((row, r) => {
    const rowW = row.length * NODE_W + (row.length - 1) * GAP_X;
    const left = (width - rowW) / 2;
    row.forEach((n, i) => {
      placed.push({ ...n, x: left + i * (NODE_W + GAP_X), y: PAD_TOP + r * ROW_H });
    });
  });
  return { placed, width, height: PAD_TOP + rows.length * ROW_H };
}

/**
 * Which band a node belongs to: the FIRST one whose `min_tier` it clears.
 *
 * Bands arrive ordered top down and are exhaustive downward, so this is a
 * find, not a range check — comparing against an upper bound as well would
 * reintroduce the gap the server's shape exists to prevent.
 */
export function bandOf(
  bands: RoundMapBand[],
  tier: number,
): RoundMapBand | null {
  return bands.find((b) => tier >= b.min_tier) ?? null;
}

/**
 * A cubic bezier between two boxes, leaving and entering on the side facing the
 * other box.
 *
 * Same-row edges bow sideways instead, and that is not cosmetic: a straight
 * line between two boxes on one row passes THROUGH whatever sits between them,
 * and on this map something always does — side control sits between north–south
 * and knee on belly.
 */
export function edgePath(a: Placed, b: Placed): string {
  const ax = a.x + NODE_W / 2;
  const bx = b.x + NODE_W / 2;

  if (a.y === b.y) {
    // Bow upward except on the top row, where there is no room above.
    const above = a.y > ROW_H;
    const edgeY = above ? a.y : a.y + NODE_H;
    const peak = above ? edgeY - 46 : edgeY + 46;
    return `M ${ax} ${edgeY} C ${ax} ${peak}, ${bx} ${peak}, ${bx} ${edgeY}`;
  }

  const down = b.y > a.y;
  const ay = down ? a.y + NODE_H : a.y;
  const by = down ? b.y : b.y + NODE_H;
  const lift = Math.min(60, Math.abs(by - ay) / 2);
  return `M ${ax} ${ay} C ${ax} ${ay + (down ? lift : -lift)}, ${bx} ${by - (down ? lift : -lift)}, ${bx} ${by}`;
}
