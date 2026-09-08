import type { ZoneNumber } from './hrZones';

/**
 * The run types an athlete can train — what each one develops, and how hard.
 *
 * ## Why running needed a catalog at all
 *
 * Running was the one sport in VOLA with nothing behind it. The registry gave
 * it `catalog: "exercises"` and `facets: []`, which meant it borrowed a single
 * row — `RUN_EXERCISE_ID`, the seeded `run` exercise — out of the STRENGTH
 * catalog purely so distance and duration PRs had somewhere to live. Open the
 * Library as a runner and there was nothing about running in it. An athlete
 * who wanted to *train* rather than *record a jog* had no way to learn that a
 * tempo run and an interval session are different tools for different jobs.
 *
 * ## Why this is a local constant and not a backend module
 *
 * A deliberate, reversible call, recorded so nobody re-derives it. Every other
 * catalog in this app is server-owned (`techniques`, `exercises`) and
 * console-editable, so the default expectation would be a `runtype` module, a
 * migration, a seed file and a `/v1` route. This is eleven rows of stable
 * domain knowledge — what a fartlek is has not changed since Gösta Holmér —
 * with no per-user state and nothing an admin needs to edit per deployment.
 * Against that, a local constant buys the thing the server-owned catalogs
 * measurably do NOT have: it is present on a cold start in a basement gym with
 * no signal. `history.md` still carries "the technique library is not cached in
 * SQLite, so the reflection wizard's drilled step is empty on a cold launch
 * with no signal" as an open gap — this simply does not have that failure mode.
 *
 * Promoting it later is mechanical: the shape below is already row-shaped, so
 * it becomes a seed file and a fetch, and the screens do not change. Do that
 * when somebody actually needs to author a run type without shipping a build,
 * not before.
 *
 * ## Zones are a BAND, and the feel is not decoration
 *
 * Every entry carries both `zones` (which of `lib/hrZones.ts`'s five Edwards
 * bands this run lives in) and `effort` (what it should feel like). Two
 * reasons, and the second is the load-bearing one:
 *
 *  1. A band rather than one number, because real prescriptions are bands — a
 *     tempo run is the top of 3 into 4, and flattening that to "zone 4" would
 *     assert a precision running coaching does not have.
 *  2. **`effort` is what makes this catalog useful TODAY.** The zone
 *     derivation (N535) does not exist yet, and even once it does, an athlete
 *     with no strap and no watch has no bpm to compare against. Running
 *     coaching described intensity by breath and conversation for a century
 *     before heart-rate monitors, and it is still the more robust signal on a
 *     hot day or a bad night's sleep. The zone is the machine-readable half;
 *     the feel is the half that always works.
 *
 * ## `hrUnreliable` is a warning to the future trainer, not a display flag
 *
 * Some of these runs cannot be coached by heart rate AT ALL, and a live
 * trainer (N538) that does not know which would give confidently wrong
 * instructions. Heart rate lags effort by roughly 30 seconds at the start of a
 * hard bout: a 15-second stride is over before the heart has responded, so a
 * trainer watching bpm would see zone 2 during an all-out sprint and tell the
 * athlete to speed up. The flag is set on the entries where that is true and
 * exists so N538 can refuse to zone-coach them rather than discovering this on
 * somebody's track session.
 */

/**
 * What a run develops. One word, because it is a badge on a list row — the
 * detail screen carries the sentence.
 */
export type RunTrains =
  | 'Aerobic base'
  | 'Threshold'
  | 'VO2max'
  | 'Speed'
  | 'Recovery'
  | 'Mixed';

/**
 * The training goals a run type can serve.
 *
 * **Ids only — N536 owns the selection surface and the weekly prescription.**
 * They are declared here rather than there because the catalog below has to
 * reference them to be authored at all, and a catalog whose `goals` were
 * free-form strings would drift the moment N536 named them properly. When N536
 * builds the picker, it imports these; it does not redeclare them.
 */
export const RUN_GOALS = {
  marathon: 'Marathon / long distance',
  endurance: 'Build endurance',
  stamina: 'Stamina and cardio',
  weight: 'Weight loss',
  base: 'General fitness',
} as const;

export type RunGoalId = keyof typeof RUN_GOALS;

export type RunType = {
  /** Stable id — the route param, and what a goal's prescription references. */
  id: string;
  name: string;
  /** What it develops, for the row badge. */
  trains: RunTrains;
  /** The Edwards band this run lives in, inclusive both ends. See `lib/hrZones.ts`. */
  zones: readonly [ZoneNumber, ZoneNumber];
  /** How it should FEEL — the signal that works with no watch. */
  effort: string;
  /** The shape of the session. */
  structure: string;
  /** Typical duration in minutes, inclusive both ends. */
  minutes: readonly [number, number];
  /** Which goals this run serves. */
  goals: readonly RunGoalId[];
  /** The thing a coach would actually say about it. */
  note: string;
  /**
   * True when heart rate is a poor guide for this run — the effort is over
   * before the heart responds. A live trainer must not zone-coach these; see
   * this file's own doc comment.
   */
  hrUnreliable?: boolean;
};

export const RUN_TYPES: readonly RunType[] = [
  {
    id: 'recovery',
    name: 'Recovery run',
    trains: 'Recovery',
    zones: [1, 1],
    effort: 'Easy enough to hold a conversation without noticing you are running.',
    structure: 'Steady and flat, short.',
    minutes: [20, 40],
    goals: ['base', 'marathon', 'endurance'],
    note: 'If it feels like training, it is not a recovery run. The point is blood flow on tired legs, and going one notch harder converts a rest day into a mediocre easy day.',
  },
  {
    id: 'easy',
    name: 'Easy run',
    trains: 'Aerobic base',
    zones: [2, 2],
    effort: 'Full sentences, comfortably. You should finish feeling you could go again.',
    structure: 'Steady, conversational, most of your week.',
    minutes: [30, 60],
    goals: ['base', 'marathon', 'endurance', 'weight'],
    note: 'The most commonly ruined run there is. Most runners run their easy days slightly too hard, which adds fatigue without adding fitness and quietly blunts the hard days that were supposed to do the work.',
  },
  {
    id: 'long',
    name: 'Long run',
    trains: 'Aerobic base',
    zones: [2, 3],
    effort: 'Easy for most of it. Drifting harder late is normal and not a failure.',
    structure: 'One continuous run, longer than anything else in your week.',
    minutes: [60, 150],
    goals: ['marathon', 'endurance'],
    note: 'Build it by roughly ten percent a week, not in jumps. This is the run that develops the things that take months — capillaries, mitochondria, and the connective tissue that decides whether you get to keep training.',
  },
  {
    id: 'tempo',
    name: 'Tempo run',
    trains: 'Threshold',
    zones: [3, 4],
    effort: 'Comfortably hard. Short sentences only — you can talk, but you would rather not.',
    structure: '20-40 minutes continuous, or broken into two or three blocks with short float recoveries.',
    minutes: [30, 60],
    goals: ['marathon', 'stamina', 'endurance'],
    note: 'Threshold is the pace you could hold for about an hour if you had to — not a race. Run it too hard and it becomes a bad interval session that costs you the rest of the week.',
  },
  {
    id: 'intervals',
    name: 'VO2max intervals',
    trains: 'VO2max',
    zones: [4, 5],
    effort: 'Hard. A few words at a time, and you are counting down the rep.',
    structure: 'Warm up, then 4-6 × 3 minutes hard with 2-3 minutes easy jogging between, then cool down.',
    minutes: [40, 60],
    goals: ['stamina', 'endurance'],
    note: 'The recovery jog is part of the session, not a break from it — cutting it short lowers the quality of every rep after it, which is the opposite of what the session is for.',
  },
  {
    id: 'hills',
    name: 'Hill repeats',
    trains: 'VO2max',
    zones: [4, 5],
    effort: 'Hard on the climb, fully easy on the way back down.',
    structure: '6-10 × 45-90 seconds up a moderate hill, jogging down to recover.',
    minutes: [35, 55],
    goals: ['stamina', 'endurance'],
    note: 'Strength and running economy at a fraction of the impact of flat speed work, which makes it the kinder way in for anyone coming back from injury. Let the hill set the effort; do not also race the clock.',
  },
  {
    id: 'fartlek',
    name: 'Fartlek',
    trains: 'Mixed',
    zones: [2, 5],
    effort: 'Changes constantly, on purpose. Easy, then hard, then easy again.',
    structure: 'Unstructured surges inside an easy run — to the next lamppost, the top of the rise, the far bench.',
    minutes: [30, 50],
    goals: ['stamina', 'base', 'endurance'],
    note: 'Swedish for "speed play", and the play is the point. Surging to a landmark rather than a stopwatch is what makes it the least intimidating way to run fast, and the easiest hard session to do on holiday.',
  },
  {
    id: 'progression',
    name: 'Progression run',
    trains: 'Threshold',
    zones: [2, 4],
    effort: 'Starts easy, finishes strong. Each third a little quicker than the last.',
    structure: 'One run in three parts — easy, then steady, then hard for the final stretch.',
    minutes: [40, 70],
    goals: ['marathon', 'stamina'],
    note: 'Teaches the pacing discipline a race actually needs: finishing fast on tired legs. Most runners go out too quick and call the second half a fade — this is the same run with the halves the right way round.',
  },
  {
    id: 'strides',
    name: 'Strides',
    trains: 'Speed',
    zones: [5, 5],
    effort: 'Fast and relaxed, not a maximal sprint. Smooth, tall, quick feet.',
    structure: '6-10 × 15-20 seconds building to near-top speed, with a full walk or jog recovery between.',
    minutes: [10, 20],
    goals: ['base', 'stamina'],
    note: 'Bolted onto the end of an easy run, these cost almost nothing and keep your form and turnover from going stale on a diet of slow miles.',
    hrUnreliable: true,
  },
  {
    id: 'sprints',
    name: 'Sprints',
    trains: 'Speed',
    zones: [5, 5],
    effort: 'All out, from a standstill or a rolling start, with long recoveries.',
    structure: '6-10 × 60-100m at maximum effort, walking back to full recovery between each.',
    minutes: [20, 35],
    goals: ['stamina', 'base'],
    note: 'Recover far longer than feels necessary — three to four minutes. Sprinting again while still tired trains fatigue resistance, which is a different session, and is how a hamstring gets pulled.',
    hrUnreliable: true,
  },
  {
    id: 'walk-run',
    name: 'Walk-run',
    trains: 'Aerobic base',
    zones: [1, 2],
    effort: 'Easy throughout. The walk is planned, not a rescue.',
    structure: 'Alternate, e.g. 1 minute running and 2 minutes walking, repeated 8-10 times.',
    minutes: [20, 45],
    goals: ['weight', 'base'],
    note: 'The honest way in — and the honest way back after time off. Walking breaks are a method, not a failure: they let you accumulate aerobic minutes at a load your tendons can actually absorb.',
  },
  {
    id: 'time-trial',
    name: 'Time trial',
    trains: 'Threshold',
    zones: [4, 5],
    effort: 'Race effort for the distance you chose. Hard, and it should cost you.',
    structure: 'A measured distance run as fast as you can hold, with a real warm-up first.',
    minutes: [20, 60],
    goals: ['stamina', 'marathon', 'endurance'],
    note: 'This measures fitness rather than building it, and it spends recovery days to do so. Worth it every few weeks to see whether the training is working — not worth it weekly.',
  },
] as const;

/**
 * The three-letter code on a run's Library tile.
 *
 * Lives here rather than in `components/LibraryTile.tsx` beside
 * `categoryBadge`/`patternBadge`, because unlike those it is not a colour
 * decision — the tile's colour for a run comes from its zone, via
 * `lib/hrZones.ts`'s existing ramp, so that a glance down the list reads
 * intensity rather than taxonomy. Keeping the code with the catalog also means
 * a new `RunTrains` value fails the exhaustiveness check here rather than
 * rendering an empty tile.
 */
export function focusCode(trains: RunTrains): string {
  switch (trains) {
    case 'Aerobic base':
      return 'AER';
    case 'Threshold':
      return 'THR';
    case 'VO2max':
      return 'VO2';
    case 'Speed':
      return 'SPD';
    case 'Recovery':
      return 'REC';
    case 'Mixed':
      return 'MIX';
  }
}

/**
 * The Library's "Focus" filter options — DERIVED from the catalog, never
 * listed separately.
 *
 * Two things fall out of deriving it, both of which a hand-written list gets
 * wrong eventually. A focus with no runs behind it can never be offered, which
 * is the "state that cannot be constructed" rule `library.tsx` already applies
 * to its `showExtras` gate — a filter that yields an empty list is worse than
 * no filter. And a run type added under a focus nobody has used before shows
 * up in the control automatically, rather than being invisible until somebody
 * remembers there were two lists.
 *
 * Catalog order, not alphabetical, so the control reads easy-to-hard the same
 * way the catalog does.
 */
export function runFocusOptions(): { key: RunTrains; label: RunTrains }[] {
  const seen: RunTrains[] = [];
  for (const r of RUN_TYPES) if (!seen.includes(r.trains)) seen.push(r.trains);
  return seen.map((t) => ({ key: t, label: t }));
}

/** One run type by id, or `undefined` — the shape a route param needs. */
export function runTypeById(id: string): RunType | undefined {
  return RUN_TYPES.find((r) => r.id === id);
}

/**
 * The run types that serve a goal, in catalog order.
 *
 * Catalog order rather than sorted by anything — the array above reads
 * easy-to-hard on purpose, and a goal's list is more legible in that order
 * than alphabetically, where "Sprints" would land between "Recovery run" and
 * "Tempo run" and imply an ordering that means nothing.
 */
export function runTypesForGoal(goal: RunGoalId): RunType[] {
  return RUN_TYPES.filter((r) => r.goals.includes(goal));
}
