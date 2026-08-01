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
 * label making a promise the filter doesn't keep. Families cover 458 of 466.
 */
export const POSITIONS = [
  { key: "Guard", label: "Guard" },
  { key: "Half Guard", label: "Half guard" },
  { key: "Standing", label: "Standing" },
  { key: "Mount", label: "Mount" },
  { key: "Side Control", label: "Side control" },
  { key: "Back", label: "Back" },
  { key: "Turtle", label: "Turtle" },
] as const;

/**
 * "Half Guard" never collides with "Guard": `startsWith("Guard - ")` cannot
 * match "Half Guard - Bottom".
 */
export function inPositionFamily(position: string, family: string): boolean {
  return position === family || position.startsWith(`${family} - `);
}
