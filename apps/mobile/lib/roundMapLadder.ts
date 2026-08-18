import { bandOf, type RoundMap, type RoundMapBand, type RoundMapNode } from '@/lib/positions';

/**
 * The round map as a ladder: every position best-first, with a band heading on
 * the first node of each band.
 *
 * Extracted from the screen because two properties here are easy to get wrong
 * and invisible in a screenshot. **Sorted by tier descending** — the hierarchy
 * IS the teaching, so a stable-but-wrong order is a wrong map. And **a heading
 * opens a band exactly once**, so a phone column is not mostly headings.
 *
 * A node whose tier falls under no band still comes back, with `band: null`.
 * The server refuses to serve such a map, so this is the belt to that braces:
 * dropping the row would remove a position from the map with nothing reporting
 * it, which is the same silent-omission failure the backend validator exists
 * to prevent.
 */
export type LadderRow = { node: RoundMapNode; band: RoundMapBand | null };

export function ladderRows(map: RoundMap): LadderRow[] {
  const sorted = [...map.nodes].sort((a, b) => b.tier - a.tier);
  let last: string | null = null;
  return sorted.map((node) => {
    const band = bandOf(map.bands, node.tier);
    const opens = band !== null && band.label !== last;
    if (band !== null) last = band.label;
    return { node, band: opens ? band : null };
  });
}
