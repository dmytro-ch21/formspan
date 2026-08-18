import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * What the athlete has achieved in jiu-jitsu, read back from the server.
 *
 * The mirror of `lib/records.ts` for the mat. Everything here is DERIVED
 * server-side from evidence that already exists — competition entries and the
 * session tag stream — and stored nowhere, so correcting a session or a contest
 * retracts the award. See `backend/internal/modules/accomplishment`.
 *
 * ## Why the phone does not decide any of this
 *
 * Same rule the personal-record row follows, and for the same reason recorded
 * against it: re-deriving "is this a first?" here would be a second opinion
 * that can disagree with the server's, and the two disagreeing about whether
 * you achieved something is worse than never mentioning it. So this module
 * fetches and filters. It never judges.
 */

/**
 * The vocabulary, as an ARRAY with the type derived from it — the idiom
 * `lib/sounds.ts` uses, and here it is what makes the parity test possible: a
 * bare union cannot be enumerated at runtime, so nothing could compare it
 * against the Go constants it mirrors.
 */
export const ACCOMPLISHMENT_KINDS = [
  'first_scored',
  'first_drilled_scored',
  'first_competition',
  'first_match_won',
  'first_submission_win',
  'first_podium',
  'first_gold',
] as const;

export type AccomplishmentKind = (typeof ACCOMPLISHMENT_KINDS)[number];

/**
 * Whether the evidence behind an award is externally verifiable or self-logged.
 *
 * Mirrors `session/basis.go`, exactly as `apps/web`'s own `Basis` type does —
 * each side needs its own type for one wire format. Carried here because the
 * card must never present a self-reported first as though a referee saw it.
 */
export type AccomplishmentBasis = 'measured' | 'reported';

export type Accomplishment = {
  kind: AccomplishmentKind;
  basis: AccomplishmentBasis;
  /** `YYYY-MM-DD`, or null when the evidence carried no date. */
  achieved_on: string | null;
  contest_id: string | null;
  contest_name: string | null;
  placement: number | null;
  entrants: number | null;
  /** The session that earned it — null on every competition award. */
  session_id: string | null;
  technique_id: string | null;
  technique_name: string | null;
};

export async function fetchAccomplishments(
  getToken: TokenGetter,
  tz: string,
): Promise<Accomplishment[]> {
  const qs = new URLSearchParams({ tz });
  const body = await apiRequest<{ accomplishments: Accomplishment[] }>(
    getToken,
    `/bjj/accomplishments?${qs}`,
  );
  // `?? []` at the parse boundary, the convention `techniques.ts` and
  // `bjjFocus.ts` both document: a drifted server omitting the field hands
  // `undefined` to a `.filter` inside a render rather than degrading to empty.
  return body.accomplishments ?? [];
}

/**
 * Which of these awards THIS session earned.
 *
 * A filter on the authority, not a second implementation of the rules — the
 * exact shape `recordsFromSession` uses, and it works for the same reason: the
 * server stamps each award with the session that earned it.
 *
 * **Competition awards fall out automatically**, because they carry a
 * `contest_id` and no `session_id`. That is correct rather than incidental:
 * nobody finishes a tournament by tapping Finish in this app, so a gold medal
 * has no session to appear on and must never be attached to whichever mat
 * session happened to be logged next.
 */
export function accomplishmentsFromSession(
  all: Accomplishment[],
  sessionID: string,
): Accomplishment[] {
  // Parity with `recordsFromSession`, which guards the same way. Structurally
  // safe today — `session_id` is a string or null, never '' — so this is
  // about the two staying the same shape rather than a live hazard.
  if (!sessionID) return [];
  return all.filter((a) => a.session_id === sessionID);
}

/**
 * The badge copy, per kind.
 *
 * States what happened and nothing else. The house rule is no praise — "Great
 * work!" after four sets is not encouragement, it is the app not paying
 * attention — and the mirror of that applies to a first: naming it exactly is
 * the whole content.
 *
 * Only the two mat kinds can ever reach a session card, but every kind is
 * given copy so this is usable by whatever renders the full list later, and so
 * that adding a kind server-side surfaces as a missing label in one place
 * rather than as `undefined` on a card.
 */
const LABELS: Record<AccomplishmentKind, string> = {
  first_scored: 'First technique landed',
  first_drilled_scored: 'First drilled technique landed live',
  first_competition: 'First competition',
  first_match_won: 'First match won',
  first_submission_win: 'First submission win',
  first_podium: 'First podium',
  first_gold: 'First gold',
};

export function labelForAccomplishment(kind: AccomplishmentKind): string {
  // A kind this build does not know about is possible — the server's
  // vocabulary can grow ahead of an installed app, which updates on the App
  // Store's schedule rather than ours. "A first" is honest and says nothing
  // false; falling through to `undefined` would render an empty badge.
  return LABELS[kind] ?? 'A first';
}

/**
 * The badge for what a session earned, or nothing at all.
 *
 * Nothing at all is the common case and that is the design — the same argument
 * `badgeFor` makes for records. These fire once each in an athlete's life, so
 * on almost every session this returns null, which is exactly what stops a
 * badge becoming wallpaper.
 *
 * More than one is genuinely possible: an athlete whose first-ever score is of
 * something they drilled weeks ago earns both at once. Counting rather than
 * picking a winner, matching how multiple personal records are shown — choosing
 * between two firsts would need a ranking, and ranking achievements is what
 * this feature is careful not to do.
 */
export function accomplishmentBadge(earned: Accomplishment[]): { label: string } | null {
  if (earned.length === 0) return null;
  if (earned.length === 1) return { label: labelForAccomplishment(earned[0].kind) };
  return { label: `${earned.length} firsts` };
}
