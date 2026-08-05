import type { Proficiency } from './proficiency';

/**
 * The first suggestion tier: a technique drilled repeatedly and never taken
 * into a live round.
 *
 * ## Why this one first
 *
 * "Where do you concede most?" needs ~18 position-tagged concede events before
 * one family can be told from noise across nine — see
 * `docs/decisions/curriculum-and-gameplan-design.md`, which prices every tier.
 * This one is an **absence**, not a rate, and absences are cheap: if you would
 * normally take a drilled technique live 30% of the time, nine drills with zero
 * attempts is already p<0.05 on its own.
 *
 * It is also the better instruction. "Try the thing you have been drilling" is
 * something you can do on Wednesday; "work on half guard" is a topic.
 *
 * ## The rule
 *
 * Four gates, and each one is here because dropping it produces a suggestion
 * that is wrong rather than merely weak:
 *
 * 1. **`drilled >= MIN_DRILLED`.** Below this it is not a pattern, it is a
 *    Tuesday.
 * 2. **`attempted + scored === 0`** — not `attempted === 0`. The two are
 *    DISJOINT in this schema: `attempted` is "went for it and it did not
 *    land". A technique drilled nine times and *landed* twice has plainly been
 *    tried, and testing `attempted` alone would tell that athlete to go and try
 *    something they are already hitting.
 * 3. **`sessions >= MIN_SESSIONS`.** Nine reps in one class is one class, not a
 *    habit — and a technique the coach taught once is not something the athlete
 *    is avoiding. `Proficiency.sessions` exists as exactly this honesty check.
 * 4. **Seen recently.** A gap from two years ago is archaeology; nobody is
 *    served by being told to try a technique they have forgotten.
 *
 * Nothing here is stored. The suggestion is recomputed from the evidence every
 * time it is read, so deleting the sessions behind it withdraws it — the same
 * argument `lib/adherence.ts` makes about plans.
 */
export type Suggestion = {
  techniqueId: string;
  /** The technique's name, or its id when the library no longer has it. */
  name: string;
  position: string;
  /** The evidence, so the card can show its own reasoning rather than assert. */
  drilled: number;
  sessions: number;
};

/**
 * Six, not nine.
 *
 * Nine drills with no attempt is the point where the *statistics* stand on
 * their own. Six is where the **observation** is worth making, and the card
 * shows its evidence ("drilled 6 times across 3 sessions, never live") so the
 * athlete judges it rather than taking a verdict. Waiting for nine costs three
 * more weeks of the loop not being demonstrated to a new user, and the cost of
 * being early here is a suggestion someone shrugs at.
 *
 * **Raised as the most likely thing to be wrong here, and upheld.** It is a
 * product call rather than a statistical one — the statistics say nine — so
 * changing it is a decision about how eager the app should be, not a bug fix.
 * Anyone tempted to "correct" it to nine is re-opening a settled question and
 * should have a reason beyond the arithmetic.
 */
const MIN_DRILLED = 6;

/** Two classes, so one keen Tuesday is not mistaken for a pattern. */
const MIN_SESSIONS = 2;

/**
 * Beyond this the gap is history rather than an opportunity.
 *
 * 60 days is roughly a training block. Long enough that a holiday or an injury
 * does not erase a real gap, short enough that the app is not reminding anyone
 * about a technique from a seminar last spring.
 */
const MAX_AGE_DAYS = 60;

/**
 * The single best funnel gap, or null.
 *
 * One, not a list. Three suggestions is a report; one is an instruction, and
 * the point is to change what happens at the next session.
 */
export function funnelGap(rows: Proficiency[], now: Date): Suggestion | null {
  const cutoff = now.getTime() - MAX_AGE_DAYS * 86_400_000;

  const candidates = rows.filter((r) => {
    if (r.drilled < MIN_DRILLED) return false;
    // Disjoint events — see the rule above. This is the line that decides
    // whether the suggestion is true.
    if (r.attempted + r.scored > 0) return false;
    if (r.sessions < MIN_SESSIONS) return false;
    const seen = new Date(r.last_seen).getTime();
    return Number.isFinite(seen) && seen >= cutoff;
  });

  if (candidates.length === 0) return null;

  // Most-drilled first: the strongest evidence makes the most defensible
  // suggestion. Ties break on sessions (spread over more classes is better
  // evidence than the same count in fewer), then on id so the answer is
  // TOTAL — an unstable order would move the suggestion between two equal
  // techniques on every refresh.
  const best = candidates.reduce((a, b) => {
    if (b.drilled !== a.drilled) return b.drilled > a.drilled ? b : a;
    if (b.sessions !== a.sessions) return b.sessions > a.sessions ? b : a;
    return b.technique_id < a.technique_id ? b : a;
  });

  return {
    techniqueId: best.technique_id,
    name: best.name || best.technique_id,
    position: best.position,
    drilled: best.drilled,
    sessions: best.sessions,
  };
}

/**
 * Whether to tell a new athlete that detail is what unlocks suggestions.
 *
 * Tier 0 of the design, and the only tier that *creates* the evidence the rest
 * consume. It fires when BJJ sessions are being logged but nothing is coming
 * out of them, which is the fast path being used exactly as intended — so the
 * copy has to read as an offer and never as a correction.
 *
 * `taggedTechniques` is the length of the proficiency list, which is what the
 * caller actually has — the endpoint returns one row per technique with any
 * evidence at all, so zero rows means no technique-level detail has ever been
 * recorded. It is not a count of sessions, and is deliberately not named as
 * one.
 *
 * **Bounded on both sides.** Not before the second such session, because one is
 * not a habit and the first log should be uncomplicated. Not after the fourth,
 * because by then the athlete has heard it and is choosing — and a prompt that
 * repeats forever is the shame the recorded UX direction rules out, however
 * politely it is worded.
 */
export function shouldOfferDetail(bjjSessions: number, taggedTechniques: number): boolean {
  return taggedTechniques === 0 && bjjSessions >= 2 && bjjSessions <= 4;
}
