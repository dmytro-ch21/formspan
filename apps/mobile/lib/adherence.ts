import { dayString } from './calendar';
import type { PlannedSession } from './plan';
import type { Session } from './sessions';

/**
 * Which plans an athlete has already met, computed from what they logged.
 *
 * ## Why this is a query and not a column
 *
 * `plans` deliberately has no `completed` flag, no `session_id`, and no link to
 * `sessions` — see `000033_create_plans.up.sql`, which states the reasoning at
 * length and is right about it. A plan is an intention. Writing "done" onto it
 * when a session lands rewrites the athlete's own record of what they meant to
 * do, and then keeps lying: delete the session and the plan still says done.
 *
 * That migration also anticipated this file — *"adherence is therefore a query
 * over both tables, computed when asked"* — and then nobody wrote the query, so
 * the two layers were only ever concatenated. A day that was planned and then
 * trained showed both, which reads as two sessions when there was one.
 *
 * So: nothing here writes. Every call recomputes from the two lists, which
 * means deleting a session correctly makes its plan pending again, and editing
 * a plan cannot contradict a stored status that no longer exists.
 *
 * ## The rule, which the migration says nobody can state
 *
 * **A plan is met by a logged session on the same day in the same sport.**
 * Matching is one-to-one and greedy.
 *
 * Each half earns its place against the cases the migration was protecting:
 *
 * - **Same day, same sport, nothing else.** A plan naming a specific template
 *   is still met by a different one — you planned Workout 1 and did Workout 2,
 *   but you did your strength session, and leaving "Workout 1 · Planned"
 *   sitting beside the workout you actually logged is exactly the duplication
 *   this exists to remove. The template is a starting point, not a contract.
 *
 *   **This one is a decision, not a preservation.** The migration listed
 *   "trained with something else entirely" among the cases it was protecting
 *   and named "same template?" as one of the questions it could not answer.
 *   This answers it: no. "Something else" now means a different *sport*, which
 *   is narrower than what that comment meant. That is a real narrowing and
 *   worth arguing with rather than assuming settled.
 * - **One-to-one.** Two planned BJJ sessions need two logged ones before both
 *   are met, so a two-a-day is not silently half-erased by a single class.
 *   The migration is explicit that `(user_id, day)` is not unique for this
 *   reason.
 * - **Greedy, in input order.** Which of two indistinguishable same-sport plans
 *   a session is credited to is arbitrary — they differ only by id, and both
 *   render identically — so any deterministic choice is as good as another.
 * - **A day trained twice, or trained with something else, still shows every
 *   session.** Sessions are never hidden by this; only a *met* plan stops being
 *   drawn as a second, pending row.
 */
export type PlanMatch = {
  /** Ids of plans a session has met. These stop rendering as pending. */
  met: Set<string>;
  /** Session id → the plan it met, so a logged row can show it was planned. */
  metBy: Map<string, string>;
};

/**
 * Match `planned` against `sessions`, both spanning any range of days.
 *
 * Grouping is internal so a caller cannot get it subtly wrong: a session's day
 * comes from `started_at` in local time via {@link dayString}, which is the same
 * conversion the calendar uses to place it — matching on the raw timestamp
 * would put a 9pm session on the next day for anyone east of Greenwich.
 */
export function matchPlans(sessions: Session[], planned: PlannedSession[]): PlanMatch {
  const met = new Set<string>();
  const metBy = new Map<string, string>();
  if (planned.length === 0 || sessions.length === 0) return { met, metBy };

  // Sessions keyed by the day and sport they could satisfy. A queue rather than
  // a count, because the matched session's id is needed to mark its row.
  //
  // Sorted here rather than trusted from the caller. `listLocalSessions` orders
  // `started_at DESC`, so taking the array as given credited the LAST session
  // of a day: plan a morning class, train morning and evening, and the badge
  // landed on the evening one. Which *plan* gets credited is genuinely
  // arbitrary — two same-sport plans differ only by id and render identically —
  // but which *session* is not, because sessions have names and times and are
  // sitting on screen next to each other. Earliest wins, and it is a property
  // of this function rather than of whichever list was passed in.
  const available = new Map<string, string[]>();
  const ordered = [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at));
  for (const s of ordered) {
    const key = `${dayString(new Date(s.started_at))} ${s.sport}`;
    const queue = available.get(key);
    if (queue) queue.push(s.id);
    else available.set(key, [s.id]);
  }

  for (const p of planned) {
    const queue = available.get(`${p.day} ${p.sport}`);
    const sessionId = queue?.shift();
    if (sessionId === undefined) continue;
    met.add(p.id);
    metBy.set(sessionId, p.id);
  }
  return { met, metBy };
}

/** The plans still owed on a day — what "upcoming" means. */
export function pendingPlans(planned: PlannedSession[], match: PlanMatch): PlannedSession[] {
  return planned.filter((p) => !match.met.has(p.id));
}

/**
 * The plans on one day that no session has met.
 *
 * A thin wrapper over {@link matchPlans}, and the thinness is the finding. The
 * caller's bug was matching a day's plans against a list that did not contain
 * them — Today filtered the viewed day against the current *week*'s plans, so
 * stepping outside that week left every plan unmatchable, and an unmet past
 * plan renders "Not logged" on a day the athlete had trained.
 *
 * The first fix passed both lists and matched the union. Mutation testing then
 * showed the wider list was **inert**: `matchPlans` groups by day, so plans on
 * other days can never compete for this day's sessions, and plans on the same
 * day are the same rows. A parameter that cannot change the answer is worse
 * than no parameter — it reads as a safeguard and is scenery. What was ever
 * needed is that the plans being judged are the plans being matched.
 */
export function owedOn<T extends PlannedSession>(sessions: Session[], dayPlans: T[]): T[] {
  if (dayPlans.length === 0) return dayPlans;
  const { met } = matchPlans(sessions, dayPlans);
  return dayPlans.filter((p) => !met.has(p.id));
}
