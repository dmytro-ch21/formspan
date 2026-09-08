import { useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { listShareInbox } from './shares';
import type { TokenGetter } from './useAuthToken';

/**
 * How many shares are waiting for this athlete — the number behind the bell
 * (N529/#960, `components/ShareBell.tsx`).
 *
 * ONE process-wide store rather than a fetch per header, and the reason is
 * that `ScreenHeader` is mounted once per tab screen — five at once under
 * `NativeTabs`, plus `library`, `goals` and `phase`. A hook that fetched on
 * mount would ask the server eight times for one number. Same shape as
 * `lib/sync.ts`'s `SyncState`: module state, a listener set, a `use*` hook
 * that subscribes, and an orchestrator that owns the AppState listener.
 *
 * **`null` is "we do not know", and it is not zero.** A badge is believed. A
 * failed read — offline, a 500, a token that could not be minted — publishes
 * `null`, which renders as no badge, exactly as zero does; what it never does
 * is render "0" or throw. `badgeLabel` below is where that rule is enforced,
 * and it is a pure function so the enforcement is testable without a screen.
 * The inbox screen is where a failure is SAID (`shared-load-error`); the bell
 * only ever says how many, or nothing.
 *
 * **Pending means the cards `listShareInbox` returns**, not a separate count
 * endpoint (`getPendingCounts` in `lib/friends.ts` also carries a `shares`
 * number, and `you.tsx`'s Sharing pill reads it). Reading the same list the
 * inbox screen renders is what keeps the bell and the screen from ever
 * disagreeing — and it lets the screen PUBLISH its own count after an
 * accept or a dismiss (`publishShareInboxCount`) instead of a second request
 * racing the first.
 *
 * **When it refreshes, and when it deliberately does not:**
 *
 *   - on identity (sign-in), forced;
 *   - on return to the foreground, forced (`startShareInboxOrchestrator`);
 *   - on focus of any screen carrying the bell, THROTTLED to one read per
 *     `REFRESH_MIN_INTERVAL_MS` — a tab flip is not a reason to ask again
 *     three seconds after the last answer;
 *   - after an accept or a dismiss, by the inbox screen publishing what it
 *     now shows — no request at all.
 *
 * There is no timer. A polling loop is a battery cost paid on every phone for
 * a number that changes a few times a week.
 */

/** A focus-triggered refresh inside this window after a successful read is skipped. */
export const REFRESH_MIN_INTERVAL_MS = 15_000;

/**
 * The server's own badge cap (`friend.maxBadgeCount`), mirrored: at the cap
 * the number means "this many or more" and the badge stops pretending to be
 * exact. Same value `you.tsx` uses for its pills.
 */
export const BADGE_CAP = 100;

let count: number | null = null;
let getTokenRef: TokenGetter | null = null;
let inflight: Promise<void> | null = null;
let lastReadAt = 0;
/**
 * Bumped on every identity change, and the ONLY thing a read's staleness is
 * judged by.
 *
 * The obvious guard — compare the `getToken` a read captured against the
 * current `getTokenRef` — cannot work in this app, and `frontend-reviewer`
 * caught it here (N529/#960). `useAuthToken()` returns a
 * `useCallback(…, [])`: "a token getter whose identity never changes", by
 * design, because a getter that changed identity turned every screen's fetch
 * effect into an infinite refetch loop. The root layout holds ONE of those
 * and hands the same object back on every sign-in — so `getTokenRef !==
 * getToken` is `false` for two DIFFERENT athletes on a shared phone, and the
 * guard it looked like never fired.
 *
 * Reproduced before fixing, and it was two bugs wearing one shape: A signs in
 * and a read goes out; A signs out; B signs in — `refreshShareInbox({force:
 * true})` hits the single-flight guard, is handed A's still-open promise, and
 * **no read is ever issued for B**; then A's read lands, the reference
 * comparison says "same identity", and A's count is published under B's bell.
 *
 * An integer has no such problem, and `lib/session.ts` already carries the
 * same counter for the same reason ("a refresh that started before sign-out
 * can settle after it"). Rather than invent a second mechanism, this is that
 * one.
 */
let epoch = 0;
const listeners = new Set<(n: number | null) => void>();
let appStateSub: { remove(): void } | null = null;

function publish(next: number | null): void {
  count = next;
  for (const l of listeners) {
    try {
      l(next);
    } catch {
      // One throwing subscriber must not stop the rest from hearing.
    }
  }
}

/** The last known count, or null when nothing trustworthy is known. */
export function shareInboxCount(): number | null {
  return count;
}

export function subscribeShareInbox(fn: (n: number | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Who to ask as. `null` on sign-out clears the count — the next athlete on a
 * shared phone must not see the previous one's badge — and a read still in
 * flight for the old identity is ignored when it lands.
 *
 * `inflight` is dropped rather than awaited: the request itself cannot be
 * recalled, but it stops being THIS store's read, so the next caller starts a
 * fresh one instead of being handed the previous athlete's. The orphan still
 * settles; the epoch check is what makes it a no-op.
 */
export function setShareInboxIdentity(getToken: TokenGetter | null): void {
  getTokenRef = getToken;
  lastReadAt = 0;
  epoch += 1;
  inflight = null;
  if (!getToken) {
    publish(null);
    return;
  }
  void refreshShareInbox({ force: true });
}

/**
 * Ask the server how many are waiting. Never rejects: a failure publishes
 * `null` and resolves, because every caller is a screen or a listener with
 * nothing useful to do with the error.
 *
 * Single-flight — a second call while one is in the air returns the same
 * promise — and throttled unless `force`, see the file comment.
 */
export function refreshShareInbox(opts: { force?: boolean } = {}): Promise<void> {
  if (inflight) return inflight;
  const getToken = getTokenRef;
  if (!getToken) return Promise.resolve();
  if (!opts.force && Date.now() - lastReadAt < REFRESH_MIN_INTERVAL_MS) return Promise.resolve();

  const startedAt = epoch;

  const run: Promise<void> = listShareInbox(getToken)
    .then((cards) => {
      // The identity changed underneath this read: whatever it says is about
      // somebody else now. Judged by the epoch, never by the getter's
      // reference — see the `epoch` comment for why the reference cannot tell
      // two athletes apart in this app.
      if (epoch !== startedAt) return;
      lastReadAt = Date.now();
      publish(cards.length);
    })
    .catch(() => {
      if (epoch !== startedAt) return;
      // Unknown, not zero. `lastReadAt` is deliberately NOT advanced, so the
      // next focus asks again rather than sitting inside the throttle window
      // with nothing to show.
      publish(null);
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

/**
 * The inbox screen saying what it is showing. It has just loaded, accepted or
 * dismissed, so its list IS the answer — publishing it costs no request and
 * cannot race one. Counts as a fresh read for the throttle.
 */
export function publishShareInboxCount(n: number): void {
  lastReadAt = Date.now();
  publish(n);
}

/**
 * The foreground trigger. Same shape as `startBiometricSyncOrchestrator`:
 * compares the previous state rather than regex-matching, fires only on a
 * genuine RETURN (background/inactive → active), and is started once for the
 * process from the root layout.
 */
export function startShareInboxOrchestrator(): () => void {
  appStateSub?.remove();
  let previous: AppStateStatus = AppState.currentState;
  appStateSub = AppState.addEventListener('change', (next) => {
    const wasAway = previous === 'background' || previous === 'inactive';
    const returned = wasAway && next === 'active';
    previous = next;
    if (!returned) return;
    void refreshShareInbox({ force: true });
  });
  return () => {
    appStateSub?.remove();
    appStateSub = null;
  };
}

/**
 * The count, live, for a component.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect(subscribe)`:
 * this IS an external store, and React's own primitive for one reads the
 * current value on subscribe itself — closing the gap between a `useState`
 * initialiser and the effect that subscribes, which the hand-rolled shape
 * has to paper over with a `setState` inside the effect (and which the
 * `react-hooks/set-state-in-effect` lint flags).
 */
export function useShareInboxCount(): number | null {
  return useSyncExternalStore(subscribeShareInbox, shareInboxCount);
}

/**
 * What the badge renders, or null for no badge at all.
 *
 * `null` (unknown) and `0` both render NOTHING, and that is the whole rule:
 * a badge is an assertion, and "0" from a failed read would assert that
 * nothing is waiting when the truth is that we could not ask.
 */
export function badgeLabel(n: number | null): string | null {
  if (n === null || n <= 0) return null;
  return n >= BADGE_CAP ? '99+' : String(n);
}

/**
 * The spoken version, which cannot be the visual one: "3" beside a bell is
 * obvious to look at and meaningless to hear, and "99+" is not a phrase.
 */
export function bellLabel(n: number | null): string {
  if (badgeLabel(n) === null) return 'Shares';
  return `Shares, ${n !== null && n >= BADGE_CAP ? 'over 99' : n} waiting`;
}
