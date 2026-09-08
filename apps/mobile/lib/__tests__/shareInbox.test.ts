import { AppState } from 'react-native';

import { OfflineError } from '@/lib/apiError';
import {
  BADGE_CAP,
  REFRESH_MIN_INTERVAL_MS,
  badgeLabel,
  bellLabel,
  publishShareInboxCount,
  refreshShareInbox,
  setShareInboxIdentity,
  shareInboxCount,
  startShareInboxOrchestrator,
  subscribeShareInbox,
} from '@/lib/shareInbox';

/**
 * The bell's count store (N529/#960).
 *
 * What is worth pinning is not that a number arrives — it is every way the
 * store could ASSERT something it does not know: a failed read rendering as
 * zero, a read for the previous athlete landing after sign-out, a badge that
 * a focus refresh three seconds after the last one re-requests. None of those
 * throws; all of them are a badge that is quietly wrong.
 */

const mockList = jest.fn((..._a: unknown[]): Promise<unknown[]> => Promise.resolve([]));
jest.mock('@/lib/shares', () => ({
  listShareInbox: (...a: unknown[]) => mockList(...a),
}));

const token = async () => 'tok';
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let now: jest.SpyInstance<number, []>;

beforeEach(async () => {
  mockList.mockReset().mockResolvedValue([]);
  now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  // Sign out between tests: clears the count and resets the throttle.
  setShareInboxIdentity(null);
  await settle();
});

afterEach(() => now.mockRestore());

describe('reading', () => {
  it('publishes the number of cards after a successful read', async () => {
    mockList.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const heard: (number | null)[] = [];
    const off = subscribeShareInbox((n) => heard.push(n));

    setShareInboxIdentity(token);
    await settle();

    expect(shareInboxCount()).toBe(3);
    expect(heard).toEqual([3]);
    off();
  });

  it('publishes UNKNOWN on a failed read — never zero, and never throws', async () => {
    mockList.mockResolvedValue([{ id: 'a' }]);
    setShareInboxIdentity(token);
    await settle();
    expect(shareInboxCount()).toBe(1);

    mockList.mockRejectedValue(new Error('500'));
    await expect(refreshShareInbox({ force: true })).resolves.toBeUndefined();

    expect(shareInboxCount()).toBeNull();
    expect(shareInboxCount()).not.toBe(0);
  });

  it('treats offline as unknown too', async () => {
    mockList.mockRejectedValue(new OfflineError());
    setShareInboxIdentity(token);
    await settle();
    expect(shareInboxCount()).toBeNull();
  });

  it('asks nothing and knows nothing without an identity', async () => {
    await refreshShareInbox({ force: true });
    expect(mockList).not.toHaveBeenCalled();
    expect(shareInboxCount()).toBeNull();
  });

  it('is single-flight: a second call while one is in the air is the same read', async () => {
    const d = deferred<unknown[]>();
    mockList.mockReturnValue(d.promise);
    setShareInboxIdentity(token); // starts read #1
    await settle();

    const again = refreshShareInbox({ force: true });
    const andAgain = refreshShareInbox();
    expect(mockList).toHaveBeenCalledTimes(1);

    d.resolve([{ id: 'a' }, { id: 'b' }]);
    await Promise.all([again, andAgain]);
    expect(shareInboxCount()).toBe(2);
  });
});

describe('the throttle', () => {
  it('skips a focus refresh inside the window, and honours a forced one', async () => {
    setShareInboxIdentity(token);
    await settle();
    expect(mockList).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + REFRESH_MIN_INTERVAL_MS - 1);
    await refreshShareInbox();
    expect(mockList).toHaveBeenCalledTimes(1);

    await refreshShareInbox({ force: true });
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('reads again once the window has passed', async () => {
    setShareInboxIdentity(token);
    await settle();
    now.mockReturnValue(1_000_000 + REFRESH_MIN_INTERVAL_MS);
    await refreshShareInbox();
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it('does NOT start the window on a failure, so the next focus asks again', async () => {
    mockList.mockRejectedValue(new Error('offline'));
    setShareInboxIdentity(token);
    await settle();
    expect(mockList).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_001);
    mockList.mockResolvedValue([{ id: 'a' }]);
    await refreshShareInbox();
    expect(mockList).toHaveBeenCalledTimes(2);
    expect(shareInboxCount()).toBe(1);
  });
});

describe('the inbox screen publishing', () => {
  it('replaces the count without a request, and counts as a fresh read', async () => {
    setShareInboxIdentity(token);
    await settle();
    expect(mockList).toHaveBeenCalledTimes(1);

    now.mockReturnValue(2_000_000);
    publishShareInboxCount(5);
    expect(shareInboxCount()).toBe(5);

    now.mockReturnValue(2_000_000 + 1);
    await refreshShareInbox();
    expect(mockList).toHaveBeenCalledTimes(1);
  });
});

describe('identity', () => {
  it('clears the count on sign-out', async () => {
    mockList.mockResolvedValue([{ id: 'a' }]);
    setShareInboxIdentity(token);
    await settle();
    expect(shareInboxCount()).toBe(1);

    setShareInboxIdentity(null);
    expect(shareInboxCount()).toBeNull();
  });

  it('ignores a read that lands after the identity it was for is gone', async () => {
    // The previous athlete's inbox must not badge the next one's bell on a
    // shared phone.
    const d = deferred<unknown[]>();
    mockList.mockReturnValue(d.promise);
    setShareInboxIdentity(token);
    await settle();

    setShareInboxIdentity(null);
    d.resolve([{ id: 'a' }, { id: 'b' }]);
    await settle();

    expect(shareInboxCount()).toBeNull();
  });

  it('a subscriber that throws does not silence the others', async () => {
    const heard = jest.fn();
    const off1 = subscribeShareInbox(() => {
      throw new Error('boom');
    });
    const off2 = subscribeShareInbox(heard);
    mockList.mockResolvedValue([{ id: 'a' }]);
    setShareInboxIdentity(token);
    await settle();
    expect(heard).toHaveBeenCalledWith(1);
    off1();
    off2();
  });
});

describe('the foreground trigger', () => {
  // Same pattern as `sync.test.ts`: spy on AppState rather than mocking all
  // of react-native, which breaks Expo's global installation.
  let handler: ((s: string) => void) | undefined;
  let spy: jest.SpyInstance;

  beforeEach(() => {
    handler = undefined;
    spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      fn: (s: string) => void,
    ) => {
      handler = fn;
      return { remove: () => void (handler = undefined) };
    }) as never);
  });

  afterEach(() => spy.mockRestore());

  it('refreshes on a return to the foreground, forced past the throttle', async () => {
    setShareInboxIdentity(token);
    await settle();
    const stop = startShareInboxOrchestrator();
    expect(mockList).toHaveBeenCalledTimes(1);

    handler!('background');
    handler!('active');
    await settle();

    expect(mockList).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not refresh on a transition that is not a return', async () => {
    setShareInboxIdentity(token);
    await settle();
    const stop = startShareInboxOrchestrator();

    handler!('inactive');
    await settle();

    expect(mockList).toHaveBeenCalledTimes(1);
    stop();
    expect(handler).toBeUndefined();
  });
});

describe('badgeLabel', () => {
  it('renders NOTHING for unknown and for zero — both are "no claim"', () => {
    expect(badgeLabel(null)).toBeNull();
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(-1)).toBeNull();
  });

  it('renders the count, capped like the server caps it', () => {
    expect(badgeLabel(1)).toBe('1');
    expect(badgeLabel(BADGE_CAP - 1)).toBe(String(BADGE_CAP - 1));
    expect(badgeLabel(BADGE_CAP)).toBe('99+');
    expect(badgeLabel(250)).toBe('99+');
  });
});

describe('bellLabel', () => {
  it('is the bare noun when there is nothing to say', () => {
    expect(bellLabel(null)).toBe('Shares');
    expect(bellLabel(0)).toBe('Shares');
  });

  it('is a sentence, not a digit, when there is', () => {
    expect(bellLabel(1)).toBe('Shares, 1 waiting');
    expect(bellLabel(3)).toBe('Shares, 3 waiting');
    expect(bellLabel(BADGE_CAP)).toBe('Shares, over 99 waiting');
  });
});
