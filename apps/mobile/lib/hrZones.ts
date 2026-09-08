import { vola } from '@/constants/Colors';

/**
 * The five heart-rate training zones, as one shared vocabulary.
 *
 * **Extracted from `lib/hrSessionReport.ts` by N534, and the extraction is the
 * point.** Those labels and that colour ramp were decided once, for the
 * post-session HR report, and lived as private constants inside it. The run
 * library (N534) needs to say which zone a tempo run lives in, and every
 * ticket after it needs the same vocabulary again — the zone derivation
 * (N535), the goal prescriptions (N536), the live trainer (N538). Four
 * surfaces each spelling "zone 4" their own way is the "two surfaces
 * answering one question, free to disagree" defect this repo files as a `W`,
 * so the answer moved somewhere all four can import it rather than being
 * copied a second time.
 *
 * ## The bands are the SERVER'S, and this file does not get a vote
 *
 * `backend/internal/modules/biometric/trimp.go` is the authority:
 *
 *     var zoneFloors = [5]float64{0.50, 0.60, 0.70, 0.80, 0.90}
 *
 * Edwards' standard five, as fractions of HRmax, with `ZoneForHR` classifying
 * against them and a `RuleVersion` constant whose own doc says to bump it
 * whenever those floors change. `ZONE_FLOORS` below MIRRORS that array so a
 * client screen can say "zone 3 starts at 70% of your max" without a round
 * trip — it does not define it.
 *
 * **If these two ever disagree, the app coaches an athlete in one zone and
 * then reports the very same run back to them in another.** That is not a
 * cosmetic drift: it is the app contradicting itself about the effort the
 * athlete just made. A change here is a change to `trimp.go`, its
 * `RuleVersion`, and this file together — never to one side alone.
 *
 * Deliberately NOT here: how an athlete's HRmax is derived, and therefore what
 * these fractions are in actual beats per minute. That is N535's job, and it
 * is a genuinely harder question (measured vs. age-estimated, and which age
 * formula) than the bands themselves, which are simply a published standard.
 */

/**
 * Each zone's lower bound as a fraction of HRmax — mirrors `trimp.go`'s
 * `zoneFloors`. Zone i covers `[ZONE_FLOORS[i - 1], ZONE_FLOORS[i])`, except
 * zone 5, which has no ceiling: there is nothing above the hardest zone there
 * is. Below `ZONE_FLOORS[0]` is not zone 1 — it is outside the scored zones
 * altogether, which `trimp.go` calls `ZoneNone`.
 */
export const ZONE_FLOORS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;

/** Every zone number that is a real zone, in order. Zone 0 (`ZoneNone`) is not one. */
export const ZONES = [1, 2, 3, 4, 5] as const;

export type ZoneNumber = (typeof ZONES)[number];

/**
 * Zone 1-5 labels. Kept short — this renders beside a number, not in place of
 * one.
 */
export const ZONE_LABELS: Record<number, string> = {
  1: 'Very light',
  2: 'Light',
  3: 'Moderate',
  4: 'Hard',
  5: 'Max effort',
};

/**
 * Zone colour — the design decision N488's ticket asked for explicitly:
 * "check whether zone colours need a design decision... don't invent one
 * without checking existing chart/zone color precedent first."
 *
 * **What was found**: no existing HR-zone palette anywhere in the repo (`grep
 * -ri "zone" assets/brand apps/mobile` before `hrSessionReport.ts` existed
 * turns up nothing but that ticket's own data types). What DOES already exist
 * is a four-step "how hard" ramp for exactly this kind of ordinal effort scale
 * — `rpeColour()` in `apps/mobile/app/bjj/log.tsx`, which colours the BJJ RPE
 * selector `vola.green` (1-4) → `vola.rpeModerate` (5-6) → `vola.warn` (7-8)
 * → `vola.danger` (9-10). An HR zone IS the same question — "how hard was
 * this" — answered from a sensor instead of a self-report, so reusing that
 * exact ramp rather than inventing a fifth categorical hue keeps "how hard"
 * reading as one idea across the app instead of two unrelated colour systems
 * that happen to sit near each other on a session screen.
 *
 * **The fifth step**: zone 1 (below 60% of HRmax) is resting/warm-up
 * territory, not the bottom of an effort scale — colouring it `vola.green`
 * would claim "light but real work" for heart rate that is often just
 * standing around between rounds. `vola.textDim` (the same neutral the report
 * already uses for "didn't register as an answer" elsewhere in the app) reads
 * as "not really trained" rather than as the first rung of a ladder.
 *
 * **Why this needs no new palette validation**: every value here is already an
 * established semantic token — `green`/`rpeModerate`/`warn`/`danger` are
 * already contrast-checked individually in `scripts/validate_palette.mjs`, and
 * reused together is exactly what `rpeColour()` already does with three of the
 * four. `textDim` is a base text token, not a status colour. Nothing here is a
 * new hex value, so there is nothing for `check:palette` to gain by asserting.
 */
export function zoneColor(zone: number): string {
  switch (zone) {
    case 1:
      return vola.textDim;
    case 2:
      return vola.green;
    case 3:
      return vola.rpeModerate;
    case 4:
      return vola.warn;
    case 5:
      return vola.danger;
    default:
      return vola.textDim;
  }
}

/**
 * How a zone BAND reads on one line — "Zone 2", or "Zones 3-4".
 *
 * A band rather than a single zone because most real training prescriptions
 * are one: a tempo run is not "zone 4", it is the upper-3-into-4 stretch, and
 * collapsing that to a single number would make the library assert a precision
 * running coaching does not have.
 */
export function zoneBandLabel(from: number, to: number): string {
  return from === to ? `Zone ${from}` : `Zones ${from}-${to}`;
}
