import {
  ApiError,
  TimeoutError,
  isPermanentStatus,
  isTransportFailure,
  transportDiagnosis,
} from './apiError';
import { apiRequest } from './apiRequest';
import { SLOW_REQUEST_TIMEOUT_MS } from './authedFetch';
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
 * Send what the athlete said, once.
 *
 * The transcript goes up as the keyboard produced it — deliberately not tidied
 * first. The disfluency is signal, and so is whatever the transcription made of
 * "omoplata"; cleaning it here would hide the one failure mode the eval corpus
 * cannot see, since it is 33 authored cases and 0 recorded ones.
 *
 * **`SLOW_REQUEST_TIMEOUT_MS`, like every other route that waits on a model.**
 * This one was on the 30s default while `describeMeal`, `estimateMeal` and
 * `identifyMachine` all sit on 45s — and the reason that constant exists is
 * written on it: "it waits on a language model … the backend puts no ceiling of
 * its own on that call". A dictation cut off at 30s is a self-inflicted
 * `TimeoutError`, which is precisely the transient failure N118 is about.
 *
 * Exported so a caller can deliberately take one shot; {@link draftReflection}
 * is what screens want.
 */
export function draftReflectionOnce(
  getToken: TokenGetter,
  dictation: string,
): Promise<DraftResponse> {
  return apiRequest<DraftResponse>(
    getToken,
    '/bjj/reflect/draft',
    { method: 'POST', body: JSON.stringify({ dictation }) },
    { timeoutMs: SLOW_REQUEST_TIMEOUT_MS },
  );
}

/**
 * What a failed draft attempt is worth, and it is denominated in the athlete's
 * daily allowance rather than in wall time (N118).
 *
 * - `free` — nothing was billed, so trying again costs the athlete nothing.
 * - `metered` — the provider answered and billed us, so the server has already
 *   spent one of the ten. A retry spends a second.
 * - `final` — trying again cannot help, or must not be attempted.
 */
export type DraftRetryClass = 'free' | 'metered' | 'final';

/**
 * The server code that means "our provider is broken", as opposed to `internal`
 * which means we are.
 *
 * `apihttp.CodeUnavailable`, built by #367 for exactly this: two failures that
 * share a status and differ only by code, so a client can act on the difference
 * without matching a prose message the API conventions forbid it from matching.
 */
const CODE_PROVIDER_UNAVAILABLE = 'unavailable';

/**
 * Which of the three a failure is.
 *
 * ## This is N55's taxonomy plus two things only this endpoint knows
 *
 * The transport family and {@link isPermanentStatus} answer most of it, and
 * they are used rather than re-derived. What N55 cannot know is that this route
 * *charges* — `POST /v1/bjj/reflect/draft` is metered against ten drafts a day,
 * and the backend's whole reason for metering a REFUSAL is to stop a client
 * looping on input the model keeps declining. So two statuses are overridden
 * here, in opposite directions:
 *
 * - **429 is `final`, though N55 calls it retryable.** On this route a 429 is
 *   not a throttle to wait out, it is the daily allowance being gone. Retrying
 *   a quota rejection is the worst behaviour available to this code.
 * - **422 is `metered`, though `isPermanentStatus` calls it permanent.** See
 *   {@link METERED_ATTEMPTS} — this is the judgement call N118 turns on.
 *
 * The unconfigured-deploy case (no provider key, 503 + `internal`) lands in
 * `metered` and will never succeed. It is indistinguishable from a real
 * answered-but-unusable call on the wire, it costs one retry, and it is a state
 * a deploy is either permanently in or permanently not — so it is not worth a
 * third code to separate.
 */
export function draftRetryClass(err: unknown): DraftRetryClass {
  // **OUR OWN DEADLINE FIRING IS NOT FREE, and reading it as free is the
  // mistake this whole class is built to avoid.**
  //
  // A `TimeoutError` means `netFetch` aborted at 45s, which cancels the request
  // context server-side while the handler is inside the provider call. The
  // backend meters that ON PURPOSE — `internal/platform/llm` maps a cancelled
  // or timed-out call away from `ErrUnreachable` for two stated reasons, the
  // second being that "if cancellation were free, the quota would be trivially
  // defeatable", and `reflect_handler.go` records the draft under
  // `context.WithoutCancel` so hanging up cannot escape the meter.
  //
  // So a client that classified its own timeout as free would retry three times
  // and spend three of the athlete's ten while believing it had spent none —
  // the exact failure this file exists to prevent, arriving from the one
  // direction N55 cannot see.
  if (err instanceof TimeoutError) return 'metered';

  // The rest of the N55 family: no status, no code, and no evidence the request
  // was ever answered. `OfflineError` has positive evidence it was not — the
  // reachability probe failed — and `RequestDroppedError` failed on its own
  // merits, typically long before a model is involved.
  //
  // Not risk-free, and the backend says so in the same breath: a request that
  // reached the handler and then lost its network is billed anyway, and llm.go
  // calls that asymmetry deliberate and bounded. What makes it acceptable HERE
  // is that these are the fast failures — the brief interruption this ticket is
  // about — while the slow one above is handled as what it is.
  if (isTransportFailure(err)) return 'free';
  if (!(err instanceof ApiError)) return 'final';

  if (err.status === 429) return 'final';

  // The provider never answered, so the handler returned BEFORE `RecordDraft`
  // and nothing was charged. Free, and the likeliest thing to succeed on the
  // next attempt.
  if (err.status === 503 && err.code === CODE_PROVIDER_UNAVAILABLE) return 'free';

  // Everything the provider actually answered has been billed and metered.
  if (err.status === 422 || err.status >= 500) return 'metered';

  // N55 decides the rest: 401 refreshes a short-lived Clerk token and works,
  // 408 says so on the tin, and every other 4xx will be refused identically
  // forever.
  return isPermanentStatus(err.status) ? 'final' : 'free';
}

/**
 * How many attempts a failure that cost nothing gets.
 *
 * Three in total — the first plus two — because the shape being covered is a
 * gym dead-spot or a provider blip, both of which clear in seconds or not at
 * all. Beyond that the athlete is better served by being told than by being
 * kept waiting behind a spinner.
 */
export const FREE_ATTEMPTS = 3;

/**
 * How many attempts a failure that SPENT ONE OF THE TEN gets. Two: the first,
 * and one retry.
 *
 * ## Why a refusal is retried at all, when the backend meters it to stop that
 *
 * The report N118 was filed from: *"I first got an error that it's not
 * articulated correctly and then I just resent again"* — and the resend, of the
 * same words, worked. So on this route a refusal is not a verdict on the
 * athlete's sentence. It is one sample.
 *
 * That contradicts what three places in this repo asserted, so the mechanism is
 * worth stating rather than the anecdote: `llm.Request` has no temperature
 * field, so both providers are called at their default sampling temperature.
 * Identical input therefore does not imply identical output, and a `refusal`
 * field or an early stop reason is drawn from that same distribution. The
 * "a refusal is deterministic" claim was inherited from TRUNCATION — which
 * genuinely is deterministic and genuinely does map onto the same sentinel —
 * and generalised to every refusal without anyone measuring it.
 *
 * ## What the second attempt costs, stated plainly
 *
 * One draft, out of ten a day. That is exactly what the athlete already spent
 * by tapping the button again, and it is bounded three ways: to ONE extra
 * attempt per tap, by the retry class above; to the athlete's own allowance,
 * because the server's quota gate runs BEFORE any token is spent, so a retry
 * with nothing left comes back 429 and stops here; and away from a loop, which
 * is the property the backend's metering exists to protect — two attempts is
 * not a loop.
 *
 * The case this spends a draft on for nothing is a truncated response, which
 * will truncate again. It shares a status and a code with a sampled refusal and
 * cannot be told apart by a client; separating them would need a new sentinel
 * in `internal/platform/llm` and a new code on the wire, which is a bigger
 * change than the evidence yet justifies.
 */
export const METERED_ATTEMPTS = 2;

/** Waits before a free retry. Short, because a blip is short. */
export const FREE_RETRY_DELAYS_MS = [400, 1600];

/**
 * The wait before the one metered retry. Longer than the first free one and
 * shorter than a person deciding to tap again.
 */
export const METERED_RETRY_DELAY_MS = 900;

/**
 * The second bound, and it is the one that protects the athlete's patience
 * rather than their allowance.
 *
 * An attempt count alone is not a bound anybody can feel: this route runs on a
 * 45s deadline, so three timed-out attempts is over two minutes behind a
 * spinner with no way out. Once this much has gone by, whatever is left is
 * reported instead of retried.
 *
 * Checked before each WAIT rather than before each attempt, so an attempt
 * already in flight is always allowed to finish — abandoning a call that may
 * have been billed would be the worst of both.
 */
export const DRAFT_RETRY_BUDGET_MS = 60_000;

export interface DraftRetryOptions {
  /** Injected by tests so a backoff ladder is not a wall-clock cost. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected by tests, so {@link DRAFT_RETRY_BUDGET_MS} is reachable in one. */
  now?: () => number;
  /**
   * Called before each retry, so a screen can say it is still working.
   *
   * Deliberately not an error channel: a retry in progress is not a failure,
   * and showing one is the thing the athlete reported.
   */
  onRetry?: (attempt: number) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send what the athlete said, and try again when trying again is the answer.
 *
 * The athlete does nothing. The dictation is held by the caller and never
 * touched here, so nothing about a retry can lose it.
 *
 * Bounded by {@link FREE_ATTEMPTS} and {@link METERED_ATTEMPTS} — read those
 * two doc comments before changing a number here, because the second one is a
 * decision about somebody's daily allowance and not a tuning constant.
 */
export async function draftReflection(
  getToken: TokenGetter,
  dictation: string,
  opts: DraftRetryOptions = {},
): Promise<DraftResponse> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let freeAttempts = 0;
  let meteredAttempts = 0;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await draftReflectionOnce(getToken, dictation);
    } catch (err) {
      const cls = draftRetryClass(err);
      if (cls === 'final') throw err;

      let wait: number;
      if (cls === 'free') {
        freeAttempts += 1;
        if (freeAttempts >= FREE_ATTEMPTS) throw err;
        wait = FREE_RETRY_DELAYS_MS[Math.min(freeAttempts - 1, FREE_RETRY_DELAYS_MS.length - 1)];
      } else {
        meteredAttempts += 1;
        if (meteredAttempts >= METERED_ATTEMPTS) throw err;
        wait = METERED_RETRY_DELAY_MS;
      }

      if (now() - startedAt >= DRAFT_RETRY_BUDGET_MS) throw err;

      opts.onRetry?.(attempt);
      await sleep(wait);
    }
  }
}

/**
 * The one line an athlete reads when every attempt has failed.
 *
 * ## Written here, not taken off the wire
 *
 * The screen used to render `err.message` for every failure, which is how the
 * handler's *"try saying what happened in plainer terms"* became a sentence
 * telling somebody they had spoken badly about a failure that was nothing to do
 * with them. Backend prose is written for an API consumer; this is written for
 * a person holding a phone in a gym.
 *
 * Same shape as `identifyErrorMessage` and `estimateErrorMessage`: the
 * transport's own diagnosis composed with the action THIS screen can offer,
 * then a switch on the status and the code — never on the message, per the API
 * conventions.
 *
 * **Two statuses deliberately keep the server's sentence**, for the reason
 * `estimateApi` records: they carry something this file cannot reconstruct. A
 * 429 states when the next draft is available, and substituting "you're out of
 * drafts" would throw the reset away; a 400 names the actual limit that was
 * broken. Neither is a diagnosis of how the athlete spoke.
 *
 * Every branch says the words are still there, because they are — nothing on
 * any failure path clears the input — and because "do I have to say all that
 * again" is the first thing anybody wonders.
 */
export function draftErrorMessage(err: unknown): string {
  const diagnosis = transportDiagnosis(err);
  if (diagnosis) return `${diagnosis} What you said is still here — try again in a moment.`;

  if (!(err instanceof ApiError)) {
    return 'That didn’t work. What you said is still here — try again, or log it by hand.';
  }

  if (err.status === 422) {
    // THE SENTENCE THIS TICKET IS ABOUT. It says what happened, it does not say
    // the athlete spoke badly, and the remedy it offers is the one that was
    // actually observed to work: send the same words.
    return 'We couldn’t turn that into a session this time. What you said is still here — send it again, or log it by hand.';
  }
  if (err.status === 503 && err.code === CODE_PROVIDER_UNAVAILABLE) {
    return 'The service that reads your words isn’t answering. That used none of your daily drafts — what you said is still here.';
  }
  if (err.status === 503) {
    return 'Reading a dictation isn’t working right now. What you said is still here — try again later, or log it by hand.';
  }

  return err.message || 'That didn’t work. What you said is still here — try again, or log it by hand.';
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
