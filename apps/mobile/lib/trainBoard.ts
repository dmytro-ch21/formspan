import { owedOn } from './adherence';
import { addDays, dayString } from './calendar';
import { logsAfterwards, type Module } from './modules';
import type { PlannedSession } from './plan';
import type { Session } from './sessions';
import type { Workout } from './workouts';

/**
 * What Train can offer right now — derived, not fetched.
 *
 * ## Why this is a pure function and not a screen
 *
 * Train answers one question — *what can I do now?* — from three local reads
 * the app already does elsewhere: the session list, the plan, and the workout
 * cache. Every one of those has a caller already (`lib/sessionStore.ts`,
 * `lib/plan.ts`), so nothing here starts a session, writes a plan, or talks to
 * the network. The ticket's hard line is that Train must not become a second
 * session engine, and a derivation with no I/O in it cannot become one.
 *
 * It is separate from the screen because the ordering below is the product
 * decision — Resume outranks everything — and a rule that lives inside a JSX
 * ladder can only be checked by rendering it.
 *
 * ## Three states per source, because "not answered yet" is a state
 *
 * {@link Source} is the thing this module exists to get right. Each read is
 * `unread`, `unavailable`, or `ready` — and an absent answer is never folded
 * into an empty one. That collapse has shipped on this codebase three times: a
 * trend card telling an athlete with two years of weigh-ins to start logging, a
 * tracker screen telling somebody with a month of history that they track
 * nothing, and a card rendering its empty state during a fetch that had not
 * returned. Every time, the missing kind was *not answered yet*.
 *
 * Today has the live instance of it. Its `viewPlans` and `weekPlan` both start
 * `[]` and `refreshPlan` swallows its own errors, so *unread*, *nothing
 * planned* and *the read failed* are one value there — and on first paint
 * Today asserts "Nothing planned" before it has looked. Train reads the same
 * table and must not inherit that; `lib/useTrainBoard.ts` is what keeps the
 * three apart on the way in, and this module is what keeps them apart on the
 * way out.
 *
 * ## The workout cache is deliberately NOT fatal
 *
 * A plan names a template id; the cache turns it into a name. If that read
 * fails, the plan is still known and still startable — it renders as the
 * discipline alone, which is Today's existing rule for a template the cache no
 * longer holds. So a failed workout read degrades a label and never turns a
 * known plan into an unknown one. That asymmetry is the point, and it has its
 * own test.
 */
export type Source<T> =
  | { state: 'unread' }
  | { state: 'unavailable' }
  | { state: 'ready'; value: T };

/** Past this, an open session reads as abandoned rather than in progress. */
export const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

/**
 * The unfinished session, and whether it still reads as running.
 *
 * The same 24-hour rule Today applies — literally the same constant now, since
 * `app/(tabs)/index.tsx` imports {@link STALE_SESSION_MS} from here rather than
 * keeping its own copy. The reason is unchanged: a Resume button reading
 * 506:24:12 is not information. A stale session is still offered, it just stops
 * claiming a clock is running.
 *
 * **It is not guaranteed to surface EVERY abandoned session**, and saying so
 * matters because an earlier draft of this comment claimed it was "the only
 * route to finishing or discarding it". The search runs over the 30 most recent
 * sessions the hook reads, so a heavy trainer's session abandoned 31 sessions
 * ago is invisible here — exactly the athlete whose forgotten session this is
 * for. Today has the same limit over the same list, so this is parity rather
 * than a regression, and fixing it means a dedicated `WHERE ended_at IS NULL`
 * read that neither screen has.
 */
export type ResumeOffer = {
  session: Session;
  stale: boolean;
};

/** A planned day, with everything the card needs to draw and act on it. */
export type PlannedOffer = PlannedSession & {
  /** The template's name, or null when the cache does not name it. */
  workoutName: string | null;
  /**
   * Whether this discipline is logged after the fact. The card's verb comes
   * from it — *Log* rather than *Start* — and it is asked through
   * `logsAfterwards` rather than stored, so the answer cannot drift from the
   * one `startSessionHref` routes on.
   */
  logsAfterwards: boolean;
};

export type TrainBoard = {
  /**
   * The session to resume. **Outranks every other action on the screen**, which
   * is the ticket's first behavioural rule — the screen reads this first and
   * renders nothing else in the primary slot while it is a `ready` non-null.
   */
  resume: Source<ResumeOffer | null>;
  /** Today's plans that nothing has met yet. */
  today: Source<PlannedOffer[]>;
  /** The soonest planned day strictly after today, within the window read. */
  later: Source<PlannedOffer | null>;
  /** The most recent session per discipline, newest first, resume excluded. */
  recent: Source<Session[]>;
};

/** How many disciplines' worth of history the Recent block will show. */
export const RECENT_LIMIT = 3;

/**
 * Combine two reads into one answer that still tells the three states apart.
 *
 * **Unavailable beats unread**, and the order is not arbitrary: if either read
 * has definitively failed, *"we could not look"* is the true sentence, and it
 * is a different one from *"we have not looked yet"* — which in turn is a
 * different one from *"there is nothing"*. Ranking unread first would let a
 * permanent failure sit forever behind a spinner.
 */
function both<A, B, T>(a: Source<A>, b: Source<B>, value: (a: A, b: B) => T): Source<T> {
  if (a.state === 'unavailable' || b.state === 'unavailable') return { state: 'unavailable' };
  if (a.state === 'unread' || b.state === 'unread') return { state: 'unread' };
  return { state: 'ready', value: value(a.value, b.value) };
}

/**
 * The newest unfinished session, from a list ordered newest-first.
 *
 * Older unfinished ones are deliberately left in `recent` rather than
 * disappearing — two open sessions is reachable (the Plan tab starts one with
 * no active-session guard, and so does web), and a second one that appears
 * nowhere at all is worse than one shown twice.
 */
function findResume(sessions: Session[], now: Date): ResumeOffer | null {
  const open = sessions.find((s) => !s.ended_at);
  if (!open) return null;
  return {
    session: open,
    stale: now.getTime() - new Date(open.started_at).getTime() > STALE_SESSION_MS,
  };
}

export function buildTrainBoard(input: {
  sessions: Source<Session[]>;
  /** Plans across a window that starts today. Anything before today is ignored. */
  plans: Source<PlannedSession[]>;
  /** Names only. A failure here degrades a label, never a plan's existence. */
  workouts: Source<Workout[]>;
  modules: Module[];
  now: Date;
}): TrainBoard {
  const { sessions, plans, workouts, modules, now } = input;
  const today = dayString(now);

  const nameOf = (workoutId: string | null): string | null => {
    if (!workoutId || workouts.state !== 'ready') return null;
    return workouts.value.find((w) => w.id === workoutId)?.name ?? null;
  };

  const offer = (p: PlannedSession): PlannedOffer => ({
    ...p,
    workoutName: nameOf(p.workoutId),
    logsAfterwards: logsAfterwards(p.sport, modules),
  });

  const resume: Source<ResumeOffer | null> =
    sessions.state === 'ready'
      ? { state: 'ready', value: findResume(sessions.value, now) }
      : sessions;

  // Today's plans need BOTH reads: `owedOn` subtracts the sessions that have
  // already met them, so an unknown session list makes an unmet plan unknown
  // rather than merely unstarted. Offering "Start BJJ" for a class already
  // logged is the duplicate this subtraction exists to prevent.
  const todayPlans = both(sessions, plans, (logged, planned) =>
    owedOn(
      logged,
      planned.filter((p) => p.day === today),
    ).map(offer),
  );

  // Later needs only the plan: nothing can have met a day that has not
  // happened, so the session list has no bearing on it.
  const later: Source<PlannedOffer | null> =
    plans.state === 'ready'
      ? {
          state: 'ready',
          value:
            plans.value
              .filter((p) => p.day > today)
              .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
              .map(offer)[0] ?? null,
        }
      : plans;

  const recent: Source<Session[]> =
    sessions.state === 'ready'
      ? {
          state: 'ready',
          value: mostRecentPerSport(
            sessions.value,
            resume.state === 'ready' ? (resume.value?.session.id ?? null) : null,
          ),
        }
      : sessions;

  return { resume, today: todayPlans, later, recent };
}

/**
 * One row per discipline — the newest each, newest first.
 *
 * **Not simply the newest N sessions.** Three strength days in a row would fill
 * the block with strength and hide that the athlete also rolls, which is the
 * one thing a multi-sport athlete opens this app to see. Capped at
 * {@link RECENT_LIMIT} so a long tail of disciplines cannot push Quick Start
 * off the screen.
 *
 * **Deliberately NOT filtered by enabled module.** Quick Start hides a
 * discipline that is switched off, because offering to start it would be
 * wrong. History is not an offer — hiding a session that happened because a
 * toggle moved afterwards is the N61 lie, where an athlete looked for features
 * that were there and reported them missing.
 */
function mostRecentPerSport(sessions: Session[], excludeId: string | null): Session[] {
  const seen = new Set<string>();
  const out: Session[] = [];
  for (const s of sessions) {
    if (s.id === excludeId || seen.has(s.sport)) continue;
    seen.add(s.sport);
    out.push(s);
    if (out.length === RECENT_LIMIT) break;
  }
  return out;
}

/**
 * How far ahead the plan window reaches, in days.
 *
 * Two weeks: far enough that "Later" almost always has something for an athlete
 * who plans at all, near enough that an empty answer is a real signal rather
 * than an artefact of a short window.
 */
export const PLAN_WINDOW_DAYS = 14;

/** The `[from, to]` the plan read covers — today through {@link PLAN_WINDOW_DAYS}. */
export function planWindow(now: Date): { from: string; to: string } {
  return { from: dayString(now), to: dayString(addDays(now, PLAN_WINDOW_DAYS)) };
}
