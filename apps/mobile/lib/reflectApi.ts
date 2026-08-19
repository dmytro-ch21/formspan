import { apiRequest } from './apiRequest';
import type { Category, Event, Kind, SessionDetail, Tag } from './bjjSession';
import type { TokenGetter } from './useAuthToken';

/**
 * Say what happened, and get a draft to correct.
 *
 * ## A draft, never a session
 *
 * Nothing here logs anything. The response fills a form the athlete confirms,
 * and confirming goes through the same local-first path a typed log takes — so
 * a dictated session becomes exactly the same kind of row, with no marker
 * saying a model was involved. Same rule N26 set for a meal estimate: what
 * happened is what the athlete says happened, whoever typed it first.
 *
 * ## Transcription is on-device, and that is why there is no audio here
 *
 * The athlete dictates into the SYSTEM KEYBOARD's own microphone, so this
 * module only ever handles text. No audio leaves the phone, nothing is
 * recorded, and there is no audio dependency to add — which is a design
 * decision rather than a limitation, and it is what removes the retention
 * question from the whole feature.
 *
 * What *does* leave the device is the sentence, which is about the athlete's
 * training and sometimes their body. The screen says so before it sends.
 */

/** How sure we are is not modelled — an id either exists in the catalog or it does not. */
export type DraftTag = {
  category: Category;
  event: Event;
  /** Position family, or '' when the athlete did not say. */
  position: string;
  /** Set ONLY when the words picked out exactly one catalog entry. */
  technique_id: string | null;
  count: number;
};

/**
 * Something the athlete named that does not pick out one technique.
 *
 * **This is the feature's best idea, not a fallback.** "Armbar" on its own is a
 * dozen catalog entries. A guess here would arrive pre-ticked, plausible, and
 * one tap from permanent; a phrase the athlete resolves with the ordinary
 * picker costs one tap and cannot be wrong. The screen must never auto-select
 * the top match — that is precisely the failure N44 was built to avoid.
 */
export type UnresolvedPhrase = {
  phrase: string;
  category: Category;
  event: Event;
};

/** Why a Notice exists. Branch on these; never pattern-match the sentence. */
export type NoticeReason =
  | 'unknown_technique'
  | 'not_spoken'
  | 'unknown_value'
  | 'count_below_one'
  | 'too_many_tags';

/**
 * One change the server made to the model's answer.
 *
 * Shown rather than swallowed. "We did not find that number in what you said"
 * is something an athlete can act on; a silently blank field is just a blank
 * field.
 */
export type Notice = {
  /** Path in the draft: "rounds", "tags[2].count". */
  field: string;
  /** What the model said, as text, since the fields it describes differ in type. */
  was: string;
  reason: NoticeReason;
};

export type Draft = {
  kind: Kind | '';
  /** null is "didn't say", which is NOT the same as no-gi. */
  gi: boolean | null;
  rounds: number | null;
  round_minutes: number | null;
  session_rpe: number | null;
  note: string;
  body_note: string;
  tags: DraftTag[];
  unresolved: UnresolvedPhrase[];
  notices: Notice[];
  /**
   * A well-formed answer with nothing in it.
   *
   * Deliberately NOT inferred from `tags.length === 0` on the client. The
   * server sets it, and it excludes `note`/`body_note` from the test on
   * purpose: a model that dumps the whole sentence into free text has
   * extracted nothing while producing a lot of characters, which is exactly
   * the case this flag exists for.
   */
  empty: boolean;
  model: string;
};

export type DraftQuota = {
  used: number;
  limit: number;
  remaining: number;
  /** When one more becomes available. Null when nothing is used. */
  resets_at: string | null;
};

export type DraftResponse = { draft: Draft; quota: DraftQuota };

/** Bounds the input, mirroring the server's `MaxDictationRunes`. */
export const MAX_DICTATION_CHARS = 2000;

/**
 * Send what the athlete said.
 *
 * The transcript goes up as the keyboard produced it — deliberately not tidied
 * first. The disfluency is signal, and so is whatever the transcription made of
 * "omoplata"; cleaning it here would hide the one failure mode the eval corpus
 * cannot see, since it is 33 authored cases and 0 recorded ones.
 */
export function draftReflection(
  getToken: TokenGetter,
  dictation: string,
): Promise<DraftResponse> {
  return apiRequest<DraftResponse>(getToken, '/bjj/reflect/draft', {
    method: 'POST',
    body: JSON.stringify({ dictation }),
  });
}

/**
 * Turn a confirmed draft into the detail the local store takes.
 *
 * The draft's shape is already the session's shape — not a coincidence, it is
 * what makes confirming a tap rather than a translation. Three things are
 * dropped on the way: `unresolved` (the athlete has answered it or chosen not
 * to), `notices` (about how the draft was arrived at, not about the training),
 * and `model`. None of them belongs in somebody's own training history.
 *
 * `academy` is not in the draft at all and is left to the caller's default —
 * nobody dictates their gym's name, and inventing one from silence is the
 * class of guess this whole feature refuses.
 */
export function draftToDetail(draft: Draft, fallbackKind: Kind): SessionDetail {
  return {
    kind: draft.kind === '' ? fallbackKind : draft.kind,
    gi: draft.gi,
    rounds: draft.rounds,
    round_minutes: draft.round_minutes,
    session_rpe: draft.session_rpe,
    academy: '',
    note: draft.note,
    body_note: draft.body_note,
    tags: draft.tags.map(tagOf),
  };
}

/** One draft tag as the session store's `Tag`. */
export function tagOf(d: DraftTag): Tag {
  return {
    category: d.category,
    event: d.event,
    position: d.position,
    technique_id: d.technique_id,
    count: d.count,
  };
}

/**
 * A human sentence for a notice.
 *
 * Built from `reason`, never by parsing the server's prose — the reason codes
 * are contract and the sentences beside them are not.
 */
export function describeNotice(n: Notice): string {
  switch (n.reason) {
    case 'not_spoken':
      return `We couldn’t find “${n.was}” in what you said, so ${fieldLabel(n.field)} is blank.`;
    case 'unknown_technique':
      return `“${n.was}” isn’t a technique we know, so it’s waiting for you to pick one.`;
    case 'unknown_value':
      return `“${n.was}” isn’t something we can record for ${fieldLabel(n.field)}.`;
    case 'count_below_one':
      return `${capitalise(fieldLabel(n.field))} came back as “${n.was}”, so we set it to 1.`;
    case 'too_many_tags':
      return `That was a lot — we kept the first ${n.was} and dropped the rest.`;
    default:
      // An unknown reason must still render. A new code shipped by the server
      // is not a reason to show the athlete nothing.
      return `${capitalise(fieldLabel(n.field))} was changed: “${n.was}”.`;
  }
}

/** "tags[2].count" reads as "a tag's count"; "round_minutes" as "round length". */
export function fieldLabel(field: string): string {
  const base = field.replace(/^tags\[\d+\]\./, '');
  switch (base) {
    case 'rounds':
      return 'rounds';
    case 'round_minutes':
      return 'round length';
    case 'session_rpe':
      return 'how hard it was';
    case 'count':
      return 'a count';
    case 'kind':
      return 'the session type';
    case 'gi':
      return 'gi or no-gi';
    default:
      return base.replace(/_/g, ' ');
  }
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
