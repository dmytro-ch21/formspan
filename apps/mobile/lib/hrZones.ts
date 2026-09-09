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

/**
 * Which zone a heart rate falls in, against a given HRmax. `0` means below
 * zone 1 — `trimp.go`'s `ZoneNone`, which is not a zone.
 *
 * **Moved here from `lib/hrMonitor/heartRateProfile.ts` by N535**, where it
 * was written as a hardcoded ladder of `if (pct >= 0.9) return 5` — a second
 * copy of the floors above it, in a file whose own doc comment said "kept
 * identical on purpose". Two copies kept identical on purpose is the same
 * thing as one copy, right up until somebody edits one of them; N535's ticket
 * counted three copies of these floors in the repo and asked for one. This is
 * that one, and it now derives from `ZONE_FLOORS` rather than restating it, so
 * there is no longer a version of the ladder that a change to the array can
 * leave behind.
 *
 * `null`/non-positive HRmax returns 0 rather than throwing: the live indicator
 * renders a bpm with no zone colour when the athlete's HRmax cannot be worked
 * out, which is the honest rendering of "we have the beats but not the scale".
 */
export function zoneForBPM(bpm: number, hrMaxBPM: number | null | undefined): number {
  if (hrMaxBPM == null || hrMaxBPM <= 0 || bpm <= 0) return 0;
  const pct = bpm / hrMaxBPM;
  for (let i = ZONE_FLOORS.length - 1; i >= 0; i -= 1) {
    if (pct >= ZONE_FLOORS[i]) return i + 1;
  }
  return 0;
}

/**
 * One zone expressed in actual beats, for a given HRmax. `to` is `null` for
 * zone 5 — there is no ceiling above the hardest zone there is, and printing
 * one (the HRmax itself, say) would claim a limit the classifier does not
 * enforce: `zoneForBPM(210, 200)` is zone 5, not out of range.
 */
export type ZoneBpmRange = {
  zone: ZoneNumber;
  /** Lowest whole bpm that classifies into this zone. */
  from: number;
  /** Highest whole bpm still in this zone, or null for zone 5. */
  to: number | null;
};

/**
 * The five zones in beats per minute — N535's whole point. A run library that
 * says "Zones 3-4" is telling an athlete nothing they can act on until it can
 * also say "152-176 bpm".
 *
 * **Rounded so that the printed range and `zoneForBPM` cannot disagree.** The
 * floor is `ceil(fraction × HRmax)`, which is by construction the smallest
 * whole bpm satisfying `bpm / HRmax >= fraction` — the exact test
 * `zoneForBPM` applies — and each ceiling is the next zone's floor minus one.
 * Rounding to nearest instead would put a bpm on screen inside zone 3 that the
 * classifier calls zone 2 whenever the fraction lands just above a half beat,
 * which is the app disagreeing with itself in the one place this ticket exists
 * to stop it. `zoneBpmRanges` is therefore not merely tested against
 * `zoneForBPM`; it is derived from the same inequality.
 */
export function zoneBpmRanges(hrMaxBPM: number): ZoneBpmRange[] {
  return ZONES.map((zone, i) => {
    const from = Math.ceil(ZONE_FLOORS[i] * hrMaxBPM);
    const nextFloor = ZONE_FLOORS[i + 1];
    return {
      zone,
      from,
      to: nextFloor === undefined ? null : Math.ceil(nextFloor * hrMaxBPM) - 1,
    };
  });
}

/** One zone's beats as a line — "152-175 bpm", or "180+ bpm" for zone 5. */
export function zoneBpmLabel(range: ZoneBpmRange): string {
  return range.to === null ? `${range.from}+ bpm` : `${range.from}-${range.to} bpm`;
}

/**
 * A zone BAND in beats — what a run type's `zones: [3, 4]` is worth against a
 * real HRmax. Spans from the low zone's floor to the high zone's ceiling, and
 * is open-ended whenever the band reaches zone 5.
 */
export function zoneBandBpmLabel(from: ZoneNumber, to: ZoneNumber, hrMaxBPM: number): string {
  const ranges = zoneBpmRanges(hrMaxBPM);
  const lo = ranges[from - 1];
  const hi = ranges[to - 1];
  return hi.to === null ? `${lo.from}+ bpm` : `${lo.from}-${hi.to} bpm`;
}
