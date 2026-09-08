import { acceptAllShares, acceptAllSummary } from '@/lib/shareAcceptAll';

/**
 * Accept all (N529/#960) — the loop and the sentence it ends with.
 *
 * The failure this guards is silent on a device: a partial result reported
 * as "all accepted", or a second accept firing before the first has landed.
 * Neither produces an error; both produce a screen that looks fine. Only a
 * stub that can be made to reject, and one that can be held open, makes
 * either visible.
 */

/** A promise that resolves only when the test says so. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('acceptAllShares', () => {
  it('accepts every id, in the order given, and reports each result', async () => {
    const calls: string[] = [];
    const acceptOne = async (id: string) => {
      calls.push(id);
      return { copy: `${id}-copy` };
    };
    const onAccepted = jest.fn();

    const out = await acceptAllShares(['a', 'b', 'c'], acceptOne, { onAccepted });

    expect(calls).toEqual(['a', 'b', 'c']);
    expect(out.accepted.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(out.accepted[1].result).toEqual({ copy: 'b-copy' });
    expect(out.failed).toEqual([]);
    expect(onAccepted).toHaveBeenCalledTimes(3);
    expect(onAccepted).toHaveBeenNthCalledWith(2, 'b', { copy: 'b-copy' });
  });

  it('is SEQUENTIAL: the second accept does not start until the first has landed', async () => {
    // Four server-side copies in parallel from gym wifi is four transactions
    // racing for one athlete's rows. Hold the first open and check nothing
    // else has been asked for.
    const first = deferred<string>();
    const calls: string[] = [];
    const acceptOne = (id: string) => {
      calls.push(id);
      return id === 'a' ? first.promise : Promise.resolve(id);
    };

    const run = acceptAllShares(['a', 'b'], acceptOne);
    await settle();
    expect(calls).toEqual(['a']);

    first.resolve('a');
    const out = await run;
    expect(calls).toEqual(['a', 'b']);
    expect(out.accepted.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('keeps going past a failure, and reports the failure by id with its own message', async () => {
    // The athlete asked for all of them; three copies are better than none.
    const acceptOne = async (id: string) => {
      if (id === 'b') throw new Error('share is gone');
      return id;
    };
    const onAccepted = jest.fn();

    const out = await acceptAllShares(['a', 'b', 'c'], acceptOne, { onAccepted });

    expect(out.accepted.map((x) => x.id)).toEqual(['a', 'c']);
    expect(out.failed).toEqual([{ id: 'b', error: 'share is gone' }]);
    // The hook fires for successes ONLY — a screen dropping cards on it must
    // not drop the one that failed.
    expect(onAccepted.mock.calls.map((c) => c[0])).toEqual(['a', 'c']);
  });

  it('reports a non-Error rejection as text rather than "[object Object]"', async () => {
    const out = await acceptAllShares(['a'], () => Promise.reject('nope'));
    expect(out.failed).toEqual([{ id: 'a', error: 'nope' }]);
  });

  it('returns two empty lists for no ids, without calling anything', async () => {
    const acceptOne = jest.fn();
    expect(await acceptAllShares([], acceptOne)).toEqual({ accepted: [], failed: [] });
    expect(acceptOne).not.toHaveBeenCalled();
  });
});

describe('acceptAllSummary', () => {
  it('confirms a full success with the count, in the single-accept voice', () => {
    expect(acceptAllSummary(4, 0)).toEqual({
      landed: 'Accepted 4 — the copies are yours now.',
      error: null,
    });
  });

  it('uses the singular for one', () => {
    expect(acceptAllSummary(1, 0)).toEqual({
      landed: 'Accepted — the copy is yours now.',
      error: null,
    });
  });

  it('NEVER says "Accepted N" over a partial result — it says N of M', () => {
    const s = acceptAllSummary(3, 1);
    expect(s.landed).toBe('Accepted 3 of 4 — the copies are yours now.');
    expect(s.landed).not.toMatch(/^Accepted 3 —/);
    expect(s.error).toBe("1 didn't go through — it's still below, with what went wrong.");
  });

  it('pluralises the failures', () => {
    expect(acceptAllSummary(1, 2)).toEqual({
      landed: 'Accepted 1 of 3 — the copy is yours now.',
      error: "2 didn't go through — they're still below, with what went wrong.",
    });
  });

  it('confirms NOTHING when nothing went through', () => {
    expect(acceptAllSummary(0, 2)).toEqual({
      landed: null,
      error: 'None of the 2 went through — each is still below, with what went wrong.',
    });
    expect(acceptAllSummary(0, 1)).toEqual({
      landed: null,
      error: "It didn't go through — it's still below, with what went wrong.",
    });
  });
});
