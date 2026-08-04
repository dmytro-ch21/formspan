/**
 * The visual anchor on every Library card — shared by exercises and techniques.
 *
 * Why it exists: only 4 of 524 exercises have artwork and techniques have none,
 * so a grid that draws an image *when there is one* is a grid of empty squares.
 * A tile is always drawn: the photo when there is one, otherwise a coloured
 * three-letter code for what the item is.
 *
 * **Colour never carries meaning alone** — the code is always present. That is
 * load-bearing rather than decorative: `validate_palette.js` puts this palette's
 * worst adjacent pair at ΔE 8.7 for a deuteranope in light mode, which is inside
 * the band that is legal *only* with secondary encoding. The code is that
 * encoding. It also means hue can be scoped per domain (red is "lower body" on
 * an exercise and "submission" on a technique) without ambiguity, since PSH is
 * never a technique and SUB is never an exercise.
 *
 * Classes are spelled out in full because Tailwind cannot see a constructed
 * class name; `bg-${x}/10` compiles to nothing.
 */
export type Accent = "attack" | "advance" | "defend" | "hold";

export const ACCENT_CLASS: Record<Accent, { tile: string; text: string }> = {
  // Fill and border carry the hue (validated for separation); the text uses a
  // darker ink step that carries only legibility. See globals.css — darkening
  // the hue itself to fix contrast costs the CVD separation the hue exists for.
  attack: { tile: "border-danger/40 bg-danger/10", text: "text-danger-ink" },
  advance: { tile: "border-lime/40 bg-lime/10", text: "text-lime-ink" },
  defend: { tile: "border-info/40 bg-info/10", text: "text-info-ink" },
  // NOT surface-raised: in light mode that token is #ffffff, identical to the
  // card it sits on, so the achromatic tile rendered as an empty outline — the
  // "nothing stands out" complaint, reappearing for the one bucket with no hue
  // to fall back on. surface-hover differs from the card in both modes.
  hold: { tile: "border-line bg-surface-hover", text: "text-text-muted" },
};

/** What a technique is *for*. Colour groups by this; the code stays specific. */
const CATEGORY: Record<string, readonly [string, Accent]> = {
  Submission: ["SUB", "attack"],
  Sweep: ["SWP", "advance"],
  Takedown: ["TKD", "advance"],
  Pass: ["PAS", "advance"],
  Transition: ["TRN", "advance"],
  Escape: ["ESC", "defend"],
  "Guard Retention": ["RET", "defend"],
  "Control/Pin": ["PIN", "hold"],
  Other: ["GEN", "hold"],
};

export function categoryBadge(category: string): readonly [string, Accent] {
  return CATEGORY[category] ?? ["GEN", "hold"];
}

/**
 * The same for exercises, keyed on movement pattern.
 *
 * A table rather than truncating the pattern to three letters: that gave
 * `horizontal_push` and `horizontal_pull` the same code (HOR, 78 exercises) and
 * both vertical variants VER (51), collapsing push against pull — the first
 * distinction a lifter scans for.
 */
const PATTERN: Record<string, readonly [string, Accent]> = {
  horizontal_push: ["PSH", "advance"],
  vertical_push: ["OHP", "advance"],
  horizontal_pull: ["ROW", "defend"],
  vertical_pull: ["PUL", "defend"],
  squat: ["SQT", "attack"],
  hinge: ["HNG", "attack"],
  lunge: ["LNG", "attack"],
  olympic: ["OLY", "attack"],
  jump: ["JMP", "attack"],
  isolation: ["ISO", "hold"],
  core: ["COR", "hold"],
  carry: ["CRY", "hold"],
  locomotion: ["LOC", "hold"],
  mobility: ["MOB", "hold"],
  rotation: ["ROT", "hold"],
};

export function patternBadge(pattern: string): readonly [string, Accent] {
  return PATTERN[pattern] ?? ["EX", "hold"];
}

/**
 * Position filters, keyed on the *family* rather than the exact position.
 *
 * Exact keys ("Mount - Top") reached 274 of 466 techniques and excluded every
 * bottom and escape position — half the library, and the half a white belt
 * needs most. A chip labelled "Mount" that returns only Mount-Top is also a
 * label making a promise the filter doesn't keep. Families cover 465 of 466.
 *
 * A family missing from this list is now worse than search-only: the glossary
 * row on the same screen advertises the position with a card, so the reader is
 * told it exists and given no way to filter to it. That has happened twice —
 * North-South, then Leg Entanglement — which is why
 * `positionVocabulary.test.ts` checks this array against `positions.json`
 * rather than trusting a diff to be read.
 */
export const POSITIONS = [
  { key: "Guard", label: "Guard" },
  { key: "Half Guard", label: "Half guard" },
  { key: "Standing", label: "Standing" },
  { key: "Mount", label: "Mount" },
  { key: "Side Control", label: "Side control" },
  { key: "Back", label: "Back" },
  { key: "Turtle", label: "Turtle" },
  { key: "North-South", label: "North-south" },
  { key: "Leg Entanglement", label: "Leg entanglement" },
] as const;

/**
 * "Half Guard" never collides with "Guard": `startsWith("Guard - ")` cannot
 * match "Half Guard - Bottom".
 */
export function inPositionFamily(position: string, family: string): boolean {
  return position === family || position.startsWith(`${family} - `);
}

/**
 * Glossary tiles, keyed on the position's own id — NOT on its family.
 *
 * All of them take the achromatic `hold`, deliberately: these are reference
 * reading rather than a thing you do, and a hue from this palette would imply
 * an intent (attacking, defending) that a position does not have. Every
 * position is both, depending on which end of it you are on.
 *
 * Which is exactly why the code must be per-position. With colour carrying
 * nothing here the three letters are the *only* differentiator, and keying on
 * family prints GRD twice (closed and open guard) and SDE twice (side control
 * and knee on belly) — two pairs of identical tiles side by side in one row.
 *
 * Kept byte-identical to mobile's table in `components/LibraryTile.tsx`, and
 * both are checked against `positions.json` by `positionVocabulary.test.ts`:
 * a twelfth position added to the glossary without a code here renders as
 * "POS", which looks deliberate rather than missing.
 */
const POSITION_CODE: Record<string, string> = {
  standing: "STD",
  "closed-guard": "CLG",
  "open-guard": "OPN",
  "half-guard": "HLF",
  "side-control": "SDE",
  "knee-on-belly": "KOB",
  mount: "MNT",
  "north-south": "N-S",
  "back-control": "BCK",
  turtle: "TRT",
  // 'ASH' for ashi garami rather than 'LEG': the row is scanned, and LEG
  // reads as a body part next to ten position names.
  "leg-entanglement": "ASH",
};

export function positionBadge(id: string): readonly [string, Accent] {
  return [POSITION_CODE[id] ?? "POS", "hold"];
}

/**
 * Belt filters, capped rather than exact-match.
 *
 * Picking "Blue" shows White and Blue material, not Blue alone — a curriculum
 * is cumulative, so a Blue-belt technique doesn't stop being relevant the day
 * you reach Brown. An exact-match filter would hide material a higher belt
 * still uses, which is the opposite of what "commonly taught from" means.
 *
 * Deliberately NOT the same axis as IBJJF legality (`gi_allowed_belts` /
 * `no_gi_allowed_belts` on the ruleset, rendered by `Legality` below) — see
 * the technique-library history entries on why "commonly taught from" and
 * "legal to compete with" are two different questions that must not collapse
 * into one filter.
 */
export const BELT_CAPS = [
  { key: "White", label: "White" },
  { key: "Blue", label: "Blue" },
  { key: "Purple", label: "Purple" },
  { key: "Brown", label: "Brown" },
  { key: "Black", label: "Black" },
] as const;

/** Matches the technique catalog's own capitalisation of `typical_belt`. */
const BELT_RANK: Record<string, number> = {
  White: 0,
  Blue: 1,
  Purple: 2,
  Brown: 3,
  Black: 4,
};

export function atOrBelowBelt(typicalBelt: string, cap: string): boolean {
  const capRank = BELT_RANK[cap];
  const rowRank = BELT_RANK[typicalBelt];
  // An unrecognised value on either side means "don't filter this out" —
  // hiding real content because its categorisation is unreadable is worse
  // than showing one extra row. Same reasoning as bjj.StandingFrom skipping
  // an unknown belt rather than sorting it as zero.
  if (capRank === undefined || rowRank === undefined) return true;
  return rowRank <= capRank;
}
