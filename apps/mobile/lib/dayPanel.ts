import { hasFoodLog, type Module } from './modules';
import { dayTotals, type Entry, type Macros, type Target, type TargetView } from './nutrition';
import type { PlannedSession } from './plan';
import type { Session } from './sessions';
import type { TodayBoard } from './todayBoard';
import { byTracker, type TrackerView } from './trackers';
import { loggedCount, targetCount, type Tracker, type TrackerEntry } from './trackerModel';
import type { PlannedOffer, Source } from './trainBoard';

/**
 * The day, assembled — N541 tranche 1 (#972). **Deterministic, local, and no
 * LLM anywhere.**
 *
 * ## What this is for
 *
 * The athlete asked for one entry point that says what today is: *"our planned
 * workouts and sessions, remind our goals and remind any things to target"*.
 * The ticket's first hard constraint is that the panel's FACTS come from real
 * rows assembled by code that already exists, and that a later AI layer only
 * ever narrates facts that are already true. This module is that factual layer
 * and nothing else. Tranche 2's narration attaches at `lib/dayNarration.ts`
 * and is not allowed to add a fact — {@link panelFacts} is the complete list of
 * what it may talk about.
 *
 * ## It re-derives nothing
 *
 * Every decision in here belongs to a function that already had it:
 *
 * | Question | Owner |
 * |---|---|
 * | is a session open, and is it stale | `buildTrainBoard` via `buildTodayBoard` (`STALE_SESSION_MS`) |
 * | which of today's plans are owed, done, or is it a rest day | `buildTodayBoard`'s `lead` (`owedOn` → `matchPlans`) |
 * | what did today log | `buildTodayBoard`'s `logged` (`loggedOn`) |
 * | what is next | `buildTodayBoard`'s `later` |
 * | a plan's display name and verb | `toPlannedOffer` |
 * | how many taps make a tracker's target | `targetCount` / `loggedCount` |
 * | the day's eaten totals | `dayTotals` |
 * | which target is in force on a day | `localTargetView`'s query (the same rule as `targetOn`) |
 * | whether a food log exists at all | `hasFoodLog` |
 *
 * What this module adds is **provenance**: every positive claim carries the
 * rows that back it ({@link RowRef}), so "nothing user-facing is asserted that
 * is not backed by a real row" is a property a test can check against SQLite
 * rather than a promise in a comment.
 *
 * ## Two kinds of sentence, kept apart in the type
 *
 * - A **fact** ({@link DayFact}) describes rows: *"Push day, planned 6:00 PM"*.
 *   It always has at least one {@link RowRef}.
 * - An **absence** describes a read that answered with nothing: *"Nothing
 *   planned today"*. It has no row to point at, so it is not a fact and does not
 *   appear in {@link panelFacts}. It is only reachable from a `ready` source —
 *   an unread or failed read can never produce one. That is the
 *   empty-versus-unknown collapse this codebase has shipped four times
 *   (see `lib/trainBoard.ts`'s `Source`), and here it would be worse than
 *   usual: a narrator handed "nothing planned" from a failed read would
 *   confidently tell the athlete to rest.
 *
 * ## Where the panel is honest about what it cannot say
 *
 * Three things the athlete named have **no local row**, so they are not here:
 *
 * - **Steps.** No table on this device stores a step count, and no read of one
 *   exists anywhere in `apps/mobile`. A "do your steps" line would be the first
 *   fabricated fact, not a missing feature.
 * - **Check-ins and the phase goal (target weight).** `lib/body.ts` is
 *   online-only by recorded decision. The panel's second hard constraint is
 *   that it renders fully offline, so a reminder that exists with signal and
 *   silently vanishes in a gym basement is left out rather than shipped
 *   half-true. Whether to cache them is a product call; see the N541 history
 *   entry.
 * - **Trackers without a target.** A count with no ceiling is not a target, so
 *   it is not something outstanding. Today still draws them.
 */

/** A row on this device that a fact is drawn from. */
export type RowRef =
  | { table: 'local_sessions'; id: string }
  | { table: 'planned_sessions'; id: string }
  | { table: 'daily_trackers'; id: string }
  | { table: 'tracker_entries'; id: string }
  | { table: 'food_entries'; id: string }
  /** `nutrition_targets` is keyed by `(user_id, effective_on)`, not an id. */
  | { table: 'nutrition_targets'; effectiveOn: string };

/**
 * One positive claim the panel makes, with the rows behind it.
 *
 * `key` is stable for a given row set and unique within a panel. It is what
 * the screen renders as `day-fact-${key}`, and what a narration layer would
 * have to cite — a narrated sentence naming a key that is not in
 * {@link panelFacts} is, by definition, a fabricated fact.
 */
export type DayFact = { key: string; refs: RowRef[] } & (
  | { kind: 'session-open'; session: Session; stale: boolean }
  | { kind: 'planned'; plan: PlannedOffer }
  /** Everything planned for the day has been met. `planned` is how many. */
  | { kind: 'plan-done'; planned: number }
  | { kind: 'logged'; session: Session }
  | { kind: 'next-planned'; plan: PlannedOffer }
  | {
      kind: 'tracker';
      tracker: Tracker;
      /** The day's entries for this tracker — the rows `refs` names. */
      entries: TrackerEntry[];
      logged: number;
      target: number;
    }
  | { kind: 'food-eaten'; totals: Macros; entries: number }
  | { kind: 'nutrition-target'; target: Target }
);

/**
 * What today's plan says. `rest` carries no fact: it is an absence.
 *
 * Mirrors {@link TodayLead}'s four kinds one-to-one, because it IS that lead
 * with provenance attached — a fifth kind here would be the panel deciding
 * something Today does not.
 */
export type PlanStatus =
  | { kind: 'resume'; fact: DayFact }
  | { kind: 'owed'; facts: DayFact[] }
  | { kind: 'done'; fact: DayFact }
  | { kind: 'rest' };

/**
 * A section that can also be switched off, which is not the same as empty.
 * A deployment with no food log must not be told it has no target.
 */
export type Section<T> = Source<T> | { state: 'off' };

/** A read tagged with the day it was made for. See {@link current}. */
export type Dated<T> = { on: string; value: T };

export type DayPanel = {
  /** The local calendar day this panel describes, `YYYY-MM-DD`. */
  day: string;
  plan: Source<PlanStatus>;
  /** What today logged, newest first. The open session is excluded — `plan` draws it. */
  logged: Source<DayFact[]>;
  /** The soonest planned day after today, or null when nothing is ahead. */
  next: Source<DayFact | null>;
  /** Trackers that HAVE a target, met or not. Trackers without one are not targets. */
  trackers: Source<DayFact[]>;
  /** What was eaten today, or null when nothing has been logged. */
  food: Section<DayFact | null>;
  /** The nutrition target in force today, or null when none is set. */
  target: Section<DayFact | null>;
};

/**
 * A dated read, as an answer about `day` — or `unread` when it answers for a
 * different day.
 *
 * **The guard that stops yesterday's numbers standing under today's date.** The
 * panel re-reads when the day changes, and SQLite answers in milliseconds, but
 * between the day changing and the read landing the previous `ready` value is
 * still in state. Without this, a phone left on the panel across midnight shows
 * last night's eight glasses as today's — a real row, the wrong day, and
 * therefore a false fact. Same shape as `entriesForLoadedDay` in
 * `lib/useTrackerDay.ts` (W16/#704), which is where this repo learnt it.
 */
export function current<T>(source: Source<Dated<T>>, day: string): Source<T> {
  if (source.state !== 'ready') return source;
  if (source.value.on !== day) return { state: 'unread' };
  return { state: 'ready', value: source.value.value };
}

function map<A, B>(source: Source<A>, f: (a: A) => B): Source<B> {
  return source.state === 'ready' ? { state: 'ready', value: f(source.value) } : source;
}

function sessionRef(s: Session): RowRef {
  return { table: 'local_sessions', id: s.id };
}

function planRef(p: PlannedSession): RowRef {
  return { table: 'planned_sessions', id: p.id };
}

export function assembleDay(input: {
  day: string;
  /**
   * Today's board, from `useTodayBoard` with `viewDay` left at `now`. Taken
   * whole rather than rebuilt: Today and the panel must never disagree about
   * whether a plan is owed.
   */
  board: TodayBoard;
  /**
   * The same plan read the board was built from — used ONLY to name the rows
   * behind a `done` lead, whose count `buildTodayBoard` returns without ids.
   * The count itself is the board's; see `plan-done` below.
   */
  plans: Source<PlannedSession[]>;
  trackers: Source<TrackerView>;
  trackerEntries: Source<Dated<TrackerEntry[]>>;
  foodEntries: Source<Dated<Entry[]>>;
  target: Source<Dated<TargetView>>;
  modules: Module[];
}): DayPanel {
  const { day, board, plans, modules } = input;

  const plan = map(board.lead, (lead): PlanStatus => {
    switch (lead.kind) {
      case 'resume':
        return {
          kind: 'resume',
          fact: {
            key: `session-open:${lead.offer.session.id}`,
            kind: 'session-open',
            session: lead.offer.session,
            stale: lead.offer.stale,
            refs: [sessionRef(lead.offer.session)],
          },
        };
      case 'owed':
        return {
          kind: 'owed',
          facts: lead.plans.map((p) => ({
            key: `planned:${p.id}`,
            kind: 'planned',
            plan: p,
            refs: [planRef(p)],
          })),
        };
      case 'done':
        return {
          kind: 'done',
          fact: {
            key: `plan-done:${day}`,
            kind: 'plan-done',
            planned: lead.planned,
            // `done` is only reachable from a ready plan read, so this is never
            // the empty fallback in practice. If it ever were, the fact would
            // have no rows behind it — and `unbackedFacts` in the tests is what
            // reports that, rather than a silent `[]` passing for provenance.
            refs:
              plans.state === 'ready'
                ? plans.value.filter((p) => p.day === day).map(planRef)
                : [],
          },
        };
      case 'rest':
        return { kind: 'rest' };
    }
  });

  const logged = map(board.logged, (sessions) =>
    sessions.map(
      (s): DayFact => ({ key: `logged:${s.id}`, kind: 'logged', session: s, refs: [sessionRef(s)] }),
    ),
  );

  const next = map(board.later, (p): DayFact | null =>
    p ? { key: `next:${p.id}`, kind: 'next-planned', plan: p, refs: [planRef(p)] } : null,
  );

  const trackers = trackerFacts(input.trackers, current(input.trackerEntries, day));

  const foodOn = hasFoodLog(modules);

  const food: Section<DayFact | null> = !foodOn
    ? { state: 'off' }
    : map(current(input.foodEntries, day), (rows): DayFact | null =>
        rows.length === 0
          ? null
          : {
              key: `food-eaten:${day}`,
              kind: 'food-eaten',
              totals: dayTotals(rows),
              entries: rows.length,
              refs: rows.map((r) => ({ table: 'food_entries', id: r.id })),
            },
      );

  const target: Section<DayFact | null> = !foodOn
    ? { state: 'off' }
    : targetFact(current(input.target, day));

  return { day, plan, logged, next, trackers, food, target };
}

/**
 * The target section. `unknown` becomes `unavailable`, never `null`.
 *
 * `localTargetView` returns `unknown` when this device has never asked the
 * server — and `null` here renders *"No nutrition target set"*, which would tell
 * an athlete who set one on the web to go and set it again. That is precisely
 * the sentence `TargetView` exists to prevent, so the distinction is carried
 * through rather than flattened at the last step.
 */
function targetFact(view: Source<TargetView>): Source<DayFact | null> {
  if (view.state !== 'ready') return view;
  switch (view.value.state) {
    case 'set': {
      const t = view.value.target;
      return {
        state: 'ready',
        value: {
          key: `nutrition-target:${t.effective_on}`,
          kind: 'nutrition-target',
          target: t,
          refs: [{ table: 'nutrition_targets', effectiveOn: t.effective_on }],
        },
      };
    }
    case 'none':
      return { state: 'ready', value: null };
    case 'unknown':
      return { state: 'unavailable' };
    case 'checking':
      return { state: 'unread' };
  }
}

/**
 * Trackers with a target, each with the day's entries behind it.
 *
 * `unknown` trackers become `unavailable` for the same reason as the target
 * above: `localTrackers` returns it when the device has never been told, and an
 * empty list there would claim the athlete tracks nothing.
 */
function trackerFacts(
  view: Source<TrackerView>,
  entries: Source<TrackerEntry[]>,
): Source<DayFact[]> {
  if (view.state !== 'ready') return view;
  if (view.value.state === 'unknown') return { state: 'unavailable' };
  const list = view.value.trackers;
  if (entries.state !== 'ready') return entries;
  const grouped = byTracker(entries.value);
  const out: DayFact[] = [];
  for (const t of list) {
    const target = targetCount(t);
    if (target == null) continue;
    const own = grouped.get(t.id) ?? [];
    out.push({
      key: `tracker:${t.id}`,
      kind: 'tracker',
      tracker: t,
      entries: own,
      logged: loggedCount(own),
      target,
      refs: [
        { table: 'daily_trackers', id: t.id },
        ...own.map((e): RowRef => ({ table: 'tracker_entries', id: e.id })),
      ],
    });
  }
  return { state: 'ready', value: out };
}

/**
 * Every fact the panel currently asserts, in the order the screen draws them.
 *
 * **This is the whole of what a narration layer may talk about.** Tranche 2's
 * fabricated-fact guard extends this rather than inventing its own list: a
 * narrated sentence that cites a key not in here, or describes a row not named
 * by one of these refs, is the failure mode that ends the feature.
 *
 * Absences are deliberately not in it — see the module doc.
 */
export function panelFacts(panel: DayPanel): DayFact[] {
  const out: DayFact[] = [];
  if (panel.plan.state === 'ready') {
    const p = panel.plan.value;
    if (p.kind === 'owed') out.push(...p.facts);
    else if (p.kind === 'resume' || p.kind === 'done') out.push(p.fact);
  }
  if (panel.logged.state === 'ready') out.push(...panel.logged.value);
  if (panel.next.state === 'ready' && panel.next.value) out.push(panel.next.value);
  if (panel.trackers.state === 'ready') out.push(...panel.trackers.value);
  if (panel.food.state === 'ready' && panel.food.value) out.push(panel.food.value);
  if (panel.target.state === 'ready' && panel.target.value) out.push(panel.target.value);
  return out;
}
