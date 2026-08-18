import type { ExerciseRecords, PersonalRecord } from './records';

/**
 * What a finished session gets to say about itself.
 *
 * Pure, and deliberately a plain data object rather than something read off the
 * session screen's state: the card that renders this is meant to become a
 * shareable image later, and a component that reaches into a screen for its
 * numbers cannot be rendered anywhere else. Everything the card shows arrives
 * through `SessionSummary` and nothing else does.
 *
 * ## Objective and subjective are separated here, not in the view
 *
 * `stats` is what the session measurably WAS — time, sets, reps, tonnage.
 * `felt` is one number somebody typed about themselves, and it is nullable
 * because effort tracking is a setting the athlete can turn off, so RPE is
 * legitimately absent for whole stretches of history. Mixing them into one row
 * of tiles would present a self-rating as a measurement and would render a
 * confident "0" for an athlete who simply never opted in.
 */

export type CelebrationSport = 'strength' | 'bjj';

export type SessionSummary = {
  title: string;
  sport: CelebrationSport;
  /** Wall-clock seconds from start to finish. */
  durationSeconds: number;
  exercises: number;
  sets: number;
  reps: number;
  /** Kilograms. Structurally zero for BJJ — see `statsFor`. */
  tonnageKg: number;
  /** BJJ only. */
  rounds?: number;
  matMinutes?: number;
  /**
   * The hardest effort recorded, or null when effort tracking is off.
   *
   * Null and zero are different states and must stay that way: null means "not
   * collected", zero would mean "recorded as nothing".
   */
  hardestRpe: number | null;
  /** Personal records this session set. Empty offline — see `recordsFromSession`. */
  records: SessionRecord[];
  /**
   * The exercises to ask the records endpoint about.
   *
   * Scoped to what this session actually contained rather than fetching the
   * athlete's whole record history to find a handful of rows — on an account
   * with years of training that is the difference between a small request and
   * a large one, at the exact moment somebody wants to put their phone down.
   */
  recordExerciseIDs: string[];
};

export type SessionRecord = { exerciseID: string; record: PersonalRecord };

/**
 * Which of the athlete's records were set by THIS session.
 *
 * The server is the authority on what counts as a record, and every record it
 * returns carries the `session_id` that set it — so this is a filter, not a
 * second implementation of the rules. Re-deriving "is this a best?" on the
 * phone would be a second opinion that can disagree with the records screen,
 * and the two disagreeing about whether you set a PR is worse than not
 * mentioning it.
 *
 * **Empty is the correct answer offline.** Records need the network; a session
 * finished in a basement gym shows no PR section rather than a guessed one.
 * Silence is not a claim, a wrong medal is.
 */
export function recordsFromSession(all: ExerciseRecords[], sessionID: string): SessionRecord[] {
  if (!sessionID) return [];
  return all.flatMap((e) =>
    e.records
      .filter((r) => r.session_id === sessionID)
      .map((record) => ({ exerciseID: e.exercise_id, record })),
  );
}

// `accomplishment` is the mat's half: a BJJ first, derived and stamped by the
// server exactly as a personal record is. See `lib/accomplishments.ts`. One
// slot either way — a session is one sport, so the two never co-occur.
export type Badge = { key: 'record' | 'accomplishment'; label: string };

/**
 * The badge, or nothing at all.
 *
 * **Nothing at all is the common case, and that is the design.** A badge that
 * appears on every session is wallpaper: it stops being read within a week and
 * takes the real ones down with it. So there is exactly one thing worth a badge
 * from the data available the moment a session ends — a personal record, which
 * the server has already decided is genuine.
 *
 * Deliberately NOT badges: long sessions, many exercises, high tonnage. Each
 * would fire constantly for whoever trains that way and never for anyone else,
 * which makes them a description of a training style rather than an
 * achievement. And none of them can be judged without history the phone does
 * not have at this moment.
 *
 * BJJ therefore gets no badge yet, honestly — it has no record equivalent at
 * all. That gap is its own piece of work, and inventing a "you showed up"
 * badge to fill it in the meantime is the exact wallpaper this avoids.
 */
export function badgeFor(
  summary: Pick<SessionSummary, 'records'>,
  /**
   * The mat's half, already resolved by the caller — a BJJ first, from
   * `lib/accomplishments.ts`. Second argument rather than a field on the
   * summary because it arrives from a network call the card does not make.
   *
   * Taking it here rather than falling back at the call site is what makes the
   * precedence testable: "records win, then an accomplishment, then nothing" is
   * a rule, and a rule living in JSX is one nothing can pin.
   */
  accomplishment?: { label: string } | null,
): Badge | null {
  const n = summary.records.length;
  if (n > 0) {
    return { key: 'record', label: n === 1 ? 'Personal record' : `${n} personal records` };
  }
  // Records first, and it is not a real contest: a session is one sport, so a
  // strength session never has an accomplishment and a BJJ session never has
  // records. The order is stated so that if that ever stops being true, the
  // measured thing wins rather than whichever happened to be checked first.
  if (accomplishment) return { key: 'accomplishment', label: accomplishment.label };
  return null;
}

/**
 * Was this session worth showing a card for at all?
 *
 * An empty session — opened, nothing logged, finished — has nothing to
 * celebrate, and congratulating someone for it is the kind of hollow praise
 * that teaches people to ignore the app. They get the ordinary finished screen.
 */
/**
 * Should the streak chime play?
 *
 * One celebratory sound per session, and the personal record outranks the
 * streak: a PR is rare and a streak recurs every week, so hearing the smaller
 * one instead would be the wrong trade every time they coincide.
 *
 * `recordsSettled` is what makes that precedence real rather than a race. The
 * two lookups are independent, and without the gate a fast history would chime
 * the streak and latch the PR out. An EMPTY records result is an answer;
 * a pending one is not, which is why this cannot be inferred from the array.
 *
 * Extracted from the card so the rule is testable without rendering anything —
 * the precedence is the part worth pinning, not the JSX around it.
 */
export function celebratesStreak(opts: {
  recordsSettled: boolean;
  hasRecords: boolean;
  carried: boolean;
}): boolean {
  return opts.recordsSettled && !opts.hasRecords && opts.carried;
}

export function worthCelebrating(summary: Pick<SessionSummary, 'sets' | 'rounds'>): boolean {
  return summary.sets > 0 || (summary.rounds ?? 0) > 0;
}

export type Stat = { label: string; value: string };

/** `1h 04m`, or `24m` under the hour. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/**
 * The objective tiles — what the session measurably was.
 *
 * Sport-shaped, because a shared vocabulary would print the wrong thing for
 * one of them. **Tonnage is omitted for BJJ rather than shown as zero**: a BJJ
 * session genuinely has no tonnage, and a "0 kg" tile on a card meant to mark
 * an achievement reads as a failure to record something. The same reasoning
 * omits it from a strength session that was all bodyweight.
 */
export function statsFor(
  summary: SessionSummary,
  formatTonnage: (kg: number) => string,
): Stat[] {
  const stats: Stat[] = [{ label: 'Time', value: formatDuration(summary.durationSeconds) }];

  if (summary.sport === 'bjj') {
    if (summary.rounds) stats.push({ label: 'Rounds', value: String(summary.rounds) });
    // "Rolling", not "Mat time": the screen underneath uses "on the mat" for
    // wall-clock duration, which this card already shows as Time. Two names
    // for one quantity and one name for two is how a summary stops being
    // trusted.
    if (summary.matMinutes) stats.push({ label: 'Rolling', value: `${summary.matMinutes}m` });
    return stats;
  }

  stats.push({ label: 'Sets', value: String(summary.sets) });
  if (summary.reps > 0) stats.push({ label: 'Reps', value: String(summary.reps) });
  if (summary.tonnageKg > 0) {
    stats.push({ label: 'Volume', value: formatTonnage(summary.tonnageKg) });
  }
  return stats;
}

/**
 * The one subjective number, kept apart from the measurements.
 *
 * Null when effort tracking is off, which is a real and common state rather
 * than an edge case — the switch exists and people use it. Returning a zero
 * here would put a confident number on the card for someone who never rated
 * anything, and it would sit in a row of measurements looking exactly like
 * one.
 */
export function feltFor(summary: Pick<SessionSummary, 'hardestRpe'>): Stat | null {
  if (summary.hardestRpe == null || summary.hardestRpe <= 0) return null;
  return { label: 'Hardest set', value: `RPE ${summary.hardestRpe}` };
}

/**
 * The line under the title.
 *
 * **No praise, and no judgement in either direction.** The house rule is no
 * shame-based messaging, and the mirror of that rule matters just as much: a
 * card that says "Great work!" after four sets is not encouragement, it is the
 * app not paying attention, and everyone can tell. So this states what
 * happened and lets the numbers speak.
 */
export function subtitleFor(summary: SessionSummary): string {
  if (summary.sport === 'bjj') {
    return summary.rounds ? `${summary.rounds} rounds logged` : 'Session logged';
  }
  const e = summary.exercises;
  return `${summary.sets} ${summary.sets === 1 ? 'set' : 'sets'} across ${e} ${
    e === 1 ? 'exercise' : 'exercises'
  }`;
}

/**
 * Builds the summary from a finished session.
 *
 * `effortTracked` is passed in rather than read from the sets, and that
 * distinction is the whole point: a session where every RPE is empty looks
 * identical to one where the athlete turned effort tracking off, and only the
 * setting knows which. Inferring it from the data would show "How it felt" as
 * absent for someone who simply had a light day, and would show nothing at all
 * for someone who opted out — the same output for two different facts.
 */
export function summariseSession(
  session: {
    name: string;
    sport: string;
    started_at: string;
    ended_at: string | null;
    sets: { exercise_id: string; completed: boolean; reps: number | null }[];
  },
  volume: { working_sets: number; total_reps: number; tonnage_kg: number; hardest_rpe: number },
  effortTracked: boolean,
): SessionSummary {
  const started = new Date(session.started_at).getTime();
  const ended = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
  const logged = session.sets.filter((x) => x.completed);
  const exerciseIDs = [...new Set(logged.map((x) => x.exercise_id))];
  /*
    `working_sets`, not the count of logged rows.

    The screen behind this card takes its Sets figure from `volume`, which
    excludes warmups — so counting rows here made the card say 12 while the
    header underneath said 9, about the same session, a tap apart. Which
    definition is right for a celebration is arguable; the two surfaces
    disagreeing is not.
  */
  return {
    title: session.name,
    sport: session.sport === 'bjj' ? 'bjj' : 'strength',
    durationSeconds: Math.max(0, (ended - started) / 1000),
    exercises: exerciseIDs.length,
    sets: volume.working_sets,
    reps: volume.total_reps,
    tonnageKg: volume.tonnage_kg,
    hardestRpe: effortTracked ? volume.hardest_rpe : null,
    records: [],
    recordExerciseIDs: exerciseIDs,
  };
}
