import {
  ACTIVITY_DEFAULT,
  ACTIVITY_LEVELS,
  activityParam,
  adoptServerActivity,
  cacheActivityLevel,
  isActivityLevel,
  readActivityChoice,
  rememberActivityChoice,
  settleActivityChoice,
} from '../activityLevel';
import { PREF_ACTIVITY_LEVEL, writePref } from '../prefs';
import { migratedFixture, type FixtureDb } from './support/sqlite';

/**
 * The daily-movement level: where it is kept, and which side wins.
 *
 * Two kinds of test, deliberately separated. The storage half runs against a
 * REAL database through `migratedFixture` — the `owed` flag is a SQL
 * behaviour (`max(prefs.dirty, excluded.dirty)`) and an array mock can supply
 * the very thing under test, which has happened in this suite before. The rule
 * half is pure, because the reconciliation is where the interesting mistakes
 * are and it should be readable without a database.
 */

let mockFixture: FixtureDb;
jest.mock('../db', () => {
  const real = jest.requireActual('../db');
  return { ...real, getDb: async () => mockFixture };
});

const U = 'user_a';

beforeEach(async () => {
  mockFixture = await migratedFixture();
});

describe('what the device remembers', () => {
  it('reports never-chosen for a device that has never been told', async () => {
    // Not `light`. "We have never asked this person" and "this person chose
    // light" are different facts and the screen renders them differently —
    // one gets a filled pill, the other gets a dashed one and a sentence.
    expect(await readActivityChoice(U)).toEqual({ level: null, owed: false });
  });

  it('keeps a choice across a read, and marks it as not yet sent', async () => {
    await rememberActivityChoice(U, 'active');
    expect(await readActivityChoice(U)).toEqual({ level: 'active', owed: true });
  });

  it('clears the debt only against the value that was actually pushed', async () => {
    await rememberActivityChoice(U, 'active');
    // The athlete changed their mind while the first push was in flight.
    await rememberActivityChoice(U, 'sedentary');
    await settleActivityChoice(U, 'active');

    // Still owed: the account heard `active`, and the device now holds
    // `sedentary`. Clearing on key alone would mark the second change as sent
    // and it would never go out — the change is lost with nothing said.
    expect(await readActivityChoice(U)).toEqual({ level: 'sedentary', owed: true });
  });

  it('settles the debt when the pushed value is still the current one', async () => {
    // The complement of the case above, and the half that catches a
    // compare-and-swap so strict it never matches — every choice would then
    // stay owed forever and the screen would permanently claim to be offline.
    await rememberActivityChoice(U, 'active');
    await settleActivityChoice(U, 'active');
    expect(await readActivityChoice(U)).toEqual({ level: 'active', owed: false });
  });

  it('does not clear a pending debt when adopting the server value', async () => {
    await rememberActivityChoice(U, 'active');
    await cacheActivityLevel(U, 'light');
    // `writePref` uses max(dirty), so a plain local write cannot cancel a
    // change the account has never heard. Without that, a profile fetch
    // landing a moment after an offline choice silently reverts it.
    expect((await readActivityChoice(U)).owed).toBe(true);
  });

  it('keeps one athlete’s choice off another athlete’s screen', async () => {
    await rememberActivityChoice(U, 'active');
    // A shared device. The prefs table is scoped by user for exactly this
    // reason, and a calorie target is not a setting to hand to whoever signs
    // in next.
    expect(await readActivityChoice('user_b')).toEqual({ level: null, owed: false });
  });

  it('discards a cached level the vocabulary no longer knows', async () => {
    // Written straight to the store, because the typed API cannot express it —
    // which is the point: this is what a level retired by a later release
    // looks like on a device that has not been reinstalled.
    await writePref(U, PREF_ACTIVITY_LEVEL, 'moderate', { owed: true });
    // Dropped rather than returned. Returned, it would be sent as an
    // `?activity=moderate` and earn a 400 — breaking the entire derivation,
    // not just the pills, over a string nobody typed.
    expect(await readActivityChoice(U)).toEqual({ level: null, owed: true });
  });
});

describe('which side wins', () => {
  it('sends nothing when the account is up to date', () => {
    // The only path by which a level chosen in the browser reaches the phone:
    // send no parameter, let the server answer from the profile, adopt it.
    expect(activityParam({ level: 'active', owed: false })).toBeUndefined();
  });

  it('sends the local value while it is still owed', () => {
    // The server holds the STALE copy here, so its answer must not drive the
    // ladder — the athlete would watch their own choice fail to take effect.
    expect(activityParam({ level: 'active', owed: true })).toBe('active');
  });

  it('sends nothing when there is a debt but no value to send', () => {
    expect(activityParam({ level: null, owed: true })).toBeUndefined();
  });

  it('adopts the server’s answer when nothing is owed', () => {
    expect(
      adoptServerActivity(
        { level: 'light', owed: false },
        { activity: 'active', activity_chosen: true },
      ),
    ).toEqual({ level: 'active', owed: false });
  });

  it('ignores the server while a local choice is still owed', () => {
    // The failure this prevents is specific and was live in `useTrackEffort`
    // once: change it offline, the push fails and is swallowed, the next
    // successful read overwrites the cache with the server's stale value, and
    // the setting reverts on its own, minutes later, with nothing said.
    const pending = { level: 'active' as const, owed: true };
    expect(adoptServerActivity(pending, { activity: 'light', activity_chosen: true })).toBe(pending);
  });

  it('does not turn the server’s assumption into a choice', () => {
    // `activity_chosen: false` means the server applied the default because
    // nobody had picked. Storing `light` here would manufacture a decision out
    // of an assumption — and the next request, owing nothing, would send it as
    // truth, making the assumption permanent and invisible.
    expect(
      adoptServerActivity(
        { level: null, owed: false },
        { activity: 'light', activity_chosen: false },
      ),
    ).toEqual({ level: null, owed: false });
  });

  it('learns nothing from a response that says nothing', () => {
    // A server predating this field, or a payload that lost it. Falling back
    // to the default here would silently overwrite a real stored choice with
    // an assumption on every request an older deployment served.
    const known = { level: 'active' as const, owed: false };
    expect(adoptServerActivity(known, {})).toBe(known);
    expect(adoptServerActivity(known, { activity: 'moderate', activity_chosen: true })).toBe(known);
  });
});

describe('the vocabulary', () => {
  it('is the three levels the wire contract names, in the order the pills render', () => {
    // Pinned to LITERALS, not to the constant. Asserting `ACTIVITY_LEVELS`
    // against itself is true by construction and stays green the day somebody
    // changes it — which is the drift worth catching, and is exactly the trap
    // #398 found on this screen.
    expect([...ACTIVITY_LEVELS]).toEqual(['sedentary', 'light', 'active']);
  });

  it('defaults to light', () => {
    expect(ACTIVITY_DEFAULT).toBe('light');
  });

  it('refuses the textbook levels the truncated ladder excludes', () => {
    // `moderate` and above already include exercise. The derivation adds
    // logged training as its own line, so accepting one would count every mat
    // class twice — a few hundred kcal a day, in the direction that makes a
    // cut silently not happen.
    for (const bad of ['moderate', 'very_active', 'Light', '', null, undefined, 1.45]) {
      expect(isActivityLevel(bad)).toBe(false);
    }
  });
});
