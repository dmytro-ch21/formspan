/**
 * Accepting every waiting share at once (N529/#960).
 *
 * A CLIENT LOOP, deliberately, rather than a bulk endpoint: `POST
 * /v1/shares/{id}/accept` already makes each copy inside its own server-side
 * transaction, and the only property a bulk call would add — all-or-nothing —
 * is the one the screen must NOT have. An athlete with four shares, one of
 * which was taken back a minute ago, wants the other three; refusing all four
 * because one is a ghost is worse than the partial result. So this runs them
 * one after another and reports both lists.
 *
 * SEQUENTIAL, not `Promise.all`: each accept is a server-side copy, and four
 * of them in parallel from a phone on gym wifi is four transactions racing
 * for the same athlete's rows. One at a time is also what makes the partial
 * result readable — the cards vanish in order as they land.
 *
 * Pure of React and of the network. `acceptOne` is injected so the loop, the
 * ordering and the partial-failure bookkeeping can be pinned without a screen
 * — the failure mode this guards (reporting "all accepted" over a partial
 * result) is silent on a device and only a test can hold it still.
 */

export type AcceptAllResult<T> = {
  /** In the order they were accepted, which is the order they were given. */
  accepted: { id: string; result: T }[];
  /** Each failure keeps its own message, so the card can say what went wrong. */
  failed: { id: string; error: string }[];
};

export async function acceptAllShares<T>(
  ids: readonly string[],
  acceptOne: (id: string) => Promise<T>,
  hooks: {
    /**
     * Called after EACH success, before the next accept starts, so the screen
     * can drop the card as it lands rather than all at once at the end.
     */
    onAccepted?: (id: string, result: T) => void;
  } = {},
): Promise<AcceptAllResult<T>> {
  const accepted: AcceptAllResult<T>['accepted'] = [];
  const failed: AcceptAllResult<T>['failed'] = [];
  for (const id of ids) {
    let result: T;
    try {
      result = await acceptOne(id);
    } catch (err) {
      // A failure on one is a fact about that one. The loop goes on — the
      // athlete asked for all of them, and three copies are better than none.
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    accepted.push({ id, result });
    hooks.onAccepted?.(id, result);
  }
  return { accepted, failed };
}

/**
 * What the screen says afterwards, in `LANDED_MESSAGE`'s voice.
 *
 * Two lines rather than one, because they are two different kinds of
 * statement: `landed` is the confirmation (what is now yours), `error` is the
 * admission (what is not). A single sentence carrying both would either bury
 * the failure inside good news or make a full success read as a warning.
 *
 * **Never "Accepted N" over a partial result.** With any failure the count
 * is stated as "N of M", so the number on screen is the number that
 * happened.
 */
export function acceptAllSummary(
  accepted: number,
  failed: number,
): { landed: string | null; error: string | null } {
  const total = accepted + failed;
  const copies = accepted === 1 ? 'the copy is' : 'the copies are';
  if (accepted === 0) {
    return {
      landed: null,
      error:
        failed === 1
          ? "It didn't go through — it's still below, with what went wrong."
          : `None of the ${failed} went through — each is still below, with what went wrong.`,
    };
  }
  if (failed === 0) {
    return {
      landed:
        accepted === 1 ? 'Accepted — the copy is yours now.' : `Accepted ${accepted} — ${copies} yours now.`,
      error: null,
    };
  }
  return {
    landed: `Accepted ${accepted} of ${total} — ${copies} yours now.`,
    error:
      failed === 1
        ? "1 didn't go through — it's still below, with what went wrong."
        : `${failed} didn't go through — they're still below, with what went wrong.`,
  };
}
