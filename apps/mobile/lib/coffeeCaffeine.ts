/**
 * Coffee-to-caffeine, N432.
 *
 * Water and coffee stay ordinary "count" trackers — no reshape of
 * `daily_trackers`/`tracker_entries`, see `presets.go`'s own note on why. What
 * changes is additive: a coffee tap ALSO posts an entry to the athlete's
 * caffeine tracker (N431), carrying a real mg figure for whichever drink was
 * actually tapped rather than one blanket assumption.
 *
 * This is the one file that says "coffee" and "mg" in the same breath —
 * deliberately kept out of `trackerModel.ts` (which knows nothing about any
 * one preset, by design — see its own header) and out of `trackers.ts` (which
 * owns SQLite and the outbox, not what a drink is worth). `logCoffeeTap` in
 * `trackers.ts` imports the numbers from here; it does not know where they
 * came from.
 */

/** A small, fixed set — chips, not a metric picker. */
export type CoffeeDrinkKey = 'espresso' | 'drip' | 'tea' | 'other';

export type CoffeeDrinkOption = {
  key: CoffeeDrinkKey;
  /** Chip text — short, for a one-handed tap standing at a machine. */
  label: string;
  /**
   * mg posted to the caffeine tracker for ONE tap of this type. `null` means
   * nothing is posted — see the note on `other` below. Never invented: every
   * non-null figure here is a cited reference amount, the same discipline
   * `tracker/presets.go` uses for caffeine's own 400 mg limit.
   */
  caffeineMg: number | null;
};

/**
 * Reference figures for one serving, not a measurement of any particular cup
 * — a DEFAULT the athlete can always correct by editing or removing the
 * entry it caused (see `removeCoffeeTap` in `trackers.ts`), the same framing
 * `presets.go` gives caffeine's own 400 mg ceiling and 80 mg increment.
 *
 * Source: Mayo Clinic, "Caffeine content for coffee, tea, soda and more"
 * (mayoclinic.org/healthy-lifestyle/nutrition-and-healthy-eating/in-depth/
 * caffeine/art-20049372), which states:
 *
 * - Coffee, brewed (drip), 8 fl oz  — 95 mg
 * - Coffee, espresso, 1 fl oz (one shot) — 63 mg
 * - Tea, black, brewed, 8 fl oz — 47 mg
 *
 * **`other` carries no figure, deliberately.** An athlete who does not know
 * what they drank — or drank something none of the three chips describe — is
 * not handed a number this app invented for them. The coffee cup still logs
 * normally (this tap is unaffected outside of what it posts to caffeine); if
 * the athlete wants that cup counted toward their caffeine total, the
 * caffeine card's own `+` is right there for a manual entry at its usual 80
 * mg default, which they can then also edit.
 */
export const COFFEE_DRINK_OPTIONS: CoffeeDrinkOption[] = [
  { key: 'espresso', label: 'Espresso', caffeineMg: 63 },
  { key: 'drip', label: 'Drip', caffeineMg: 95 },
  { key: 'tea', label: 'Tea', caffeineMg: 47 },
  { key: 'other', label: 'Other', caffeineMg: null },
];

/** The mg figure for one tap of `key`, or `null` for `other`/an unknown key. */
export function caffeineMgFor(key: string): number | null {
  return COFFEE_DRINK_OPTIONS.find((o) => o.key === key)?.caffeineMg ?? null;
}

/** What VoiceOver says for one chip — the figure it carries, or its absence. */
export function coffeeDrinkAccessibilityLabel(o: CoffeeDrinkOption): string {
  return o.caffeineMg == null
    ? `${o.label} — no caffeine estimate logged`
    : `${o.label} — about ${o.caffeineMg} mg caffeine`;
}

/**
 * The chip row `TrackerCard` renders for a coffee tap — `TrackerCard`'s own
 * `addChoices` prop is generic (it does not know what coffee is; see its
 * header), so this is where coffee's own picker is actually assembled.
 */
export const COFFEE_ADD_CHOICES: { key: CoffeeDrinkKey; label: string; accessibilityLabel: string }[] =
  COFFEE_DRINK_OPTIONS.map((o) => ({
    key: o.key,
    label: o.label,
    accessibilityLabel: coffeeDrinkAccessibilityLabel(o),
  }));

/**
 * The caffeine-tracker entry id ONE coffee tap causes, derived from the
 * coffee entry's own id rather than stored on a new column.
 *
 * **Why derived, not stored.** Pairing the two rows needs no schema change
 * and no server-side link to keep in sync: any device that knows the coffee
 * entry's id can recompute the caffeine one — including a device that only
 * pulled the coffee entry down later. The alternative, a `caused_by`
 * column on `tracker_entries`, is a migration and a wire-shape change for a
 * fact this function already derives for free.
 *
 * A plain suffix rather than a hash, because there is nothing to hide: a
 * tracker entry id is not a secret (every read here is scoped by user id —
 * same reasoning `presets.go`'s `PresetID` gives), and a fixed 4-character
 * suffix keeps the derived id comfortably under the backend's 64-character
 * entry-id limit (`NewEntry.Validate` in `tracker.go`) for any
 * `randomUUID()`-length coffee id.
 */
export function pairedCaffeineEntryId(coffeeEntryId: string): string {
  return `${coffeeEntryId}-caf`;
}
