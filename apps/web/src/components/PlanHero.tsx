/**
 * The artwork on a VOLA Workout card.
 *
 * **A SECOND COPY.** `apps/mobile/components/PlanHero.tsx` holds the same
 * palette and the same hash. The apps share no package, and this is the third
 * vocabulary duplicated across them — `swapParity.test.ts` guards the swap
 * ranking's copies for exactly this reason, and `planHero.test.ts` now compares
 * these two.
 *
 * The property that has to hold is narrow but real: **a given plan looks the
 * same on a phone and on a laptop.** These tiles are the first thing anyone
 * would screenshot, and two devices disagreeing about a plan's colour is the
 * kind of small wrongness nobody reports and everybody notices.
 *
 * Nothing is bundled or fetched — a gradient and two flat shapes, no image
 * assets at all. See the mobile copy for why stock photography was considered
 * and rejected twice.
 *
 * **One deliberate divergence:** mobile draws a brand glyph on the tile and
 * this does not. `apps/web` has no icon component, and adding one for a
 * decorative mark would be a larger change than the mark is worth. Recorded
 * rather than hidden, since a reader comparing the two will notice.
 */

const PALETTES: readonly (readonly [string, string])[] = [
  ["#14324a", "#0d1b2a"],
  ["#2b1f45", "#141024"],
  ["#123a33", "#0b1f1c"],
  ["#3a2418", "#1d120c"],
  ["#1c2f4d", "#0e1726"],
  ["#38203a", "#1b0f1c"],
];

function hash(id: string): number {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0;
  return n;
}

export function paletteFor(id: string): readonly [string, string] {
  return PALETTES[hash(id) % PALETTES.length];
}

/**
 * Kept identical to mobile's, so the same plan tilts the same way — including
 * the `>>>`, which is load-bearing rather than stylistic (see the mobile copy).
 */
export function bandAngleFor(id: string): number {
  return -44 + ((hash(id) >>> 3) % 9) * 11;
}

export function PlanHero({ id }: { id: string; goal?: string | null }) {
  const [from, to] = paletteFor(id);
  const angle = bandAngleFor(id);

  return (
    <div
      aria-hidden
      className="relative w-full overflow-hidden"
      style={{
        aspectRatio: "1 / 1",
        backgroundImage: `linear-gradient(135deg, ${from}, ${to})`,
      }}
    >
      {/* Rotated well past the tile's bounds, so its ends are always
          off-canvas — a band whose corners show reads as a stray rectangle
          rather than as a graphic. */}
      <div
        className="absolute bg-white/[0.05]"
        style={{
          left: "-55%",
          right: "-55%",
          top: "18%",
          height: "38%",
          transform: `rotate(${angle}deg)`,
        }}
      />
      {/* A corner bloom, so the flat fill does not read as a swatch. */}
      <div
        className="absolute rounded-full bg-white/[0.06]"
        style={{ top: "-30%", right: "-25%", width: "75%", aspectRatio: "1 / 1" }}
      />
    </div>
  );
}
