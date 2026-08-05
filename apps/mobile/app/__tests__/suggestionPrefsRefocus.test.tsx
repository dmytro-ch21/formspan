import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { migratedFixture, type FixtureDb } from '@/lib/__tests__/support/sqlite';
import type { Module } from '@/lib/modules';
import { PREF_SUGGESTIONS, PREF_SUGGESTIONS_OFF, readPref, writePref } from '@/lib/prefs';
import type { Proficiency } from '@/lib/proficiency';

// The two screens under test. Up here with everything else rather than below the
// mocks: jest hoists every `jest.mock` above the imports anyway, so ordering them
// by hand buys nothing and costs two `import/first` warnings against a ratchet
// with no slack. The factories below only CLOSE OVER their `mock*` fixtures —
// none reads one at factory time — so no fixture is touched before its
// declaration has run.
import SuggestionSettingsScreen from '../settings/suggestions';
import Today from '../(tabs)/index';

/**
 * Turning suggestions off in Settings has to take effect on Today.
 *
 * **The bug this exists for.** Today read its four suggestion preferences from a
 * `useEffect` keyed on `[userId]`. A tab screen stays mounted for the life of
 * the process and `/settings/suggestions` is a Stack route pushed *over* the
 * tabs — so that read ran once, ever. The master switch, the per-discipline
 * switches and "Suggest again" all appeared to do nothing until the app was
 * killed. The write half worked perfectly, which is exactly why checking it by
 * hand missed it: Settings is pushed fresh every visit and always reads back
 * what it just wrote. Only the *return* to Today was broken, and only for a
 * process that had already rendered Today once — i.e. always.
 *
 * The fix moved the read into the screen's `useFocusEffect`. Review found it;
 * nothing tested it, and the branch that shipped it said so.
 *
 * ---
 *
 * **Why this file overrides `expo-router` instead of using the shared mock.**
 * This is the whole reason the test is more than four lines, so it is worth
 * being blunt about: under `jest.setup.js` this test would pass against the
 * bug.
 *
 * That mock is `useFocusEffect: (cb) => useEffect(() => cb(), [cb])`. Today's
 * focus callback is a `useCallback` keyed on four callbacks that are themselves
 * stable while `userId` is. Substitute it and the fixed code reduces to
 * `useEffect(read, [userId])` — the shipped bug, verbatim. Measured: the read
 * fires 4 times on mount and 4 times after any `rerender`, for both shapes.
 * There is no focus event in that mock at all; nothing subscribes and nothing
 * dispatches, so no action available to a test re-runs the callback without
 * unmounting — and unmounting re-runs the buggy version too.
 *
 * So the mock below models the real hook. Not react-navigation's: expo-router
 * 57 **vendors its own fork** (`expo-router/build/useFocusEffect.js`) and
 * `@react-navigation/native` is not installed in this workspace at all. The
 * shape copied here is that file's: run on mount only if focused, re-run on a
 * `focus` event guarded against the duplicate one navigation fires at mount,
 * run cleanup on `blur` and drop it, and on unmount run cleanup only if still
 * focused.
 *
 * **Why a real database rather than `jest.fn()` prefs.** The store is not what
 * makes this catch the regression — the focus control is. What it buys is that
 * the assertion is about the two screens agreeing: Settings writes
 * `PREF_SUGGESTIONS`, Today reads it, and `serialiseIdSet` → SQLite TEXT →
 * `parseIdSet` all really run. Against `jest.fn()` a diverged key or a changed
 * encoding is structurally invisible, because the fake returns whatever the
 * reader asks for. It also keeps the test honest about *what* it covers: it
 * asserts a card left the screen, not that `readPref` was called twice — the
 * latter goes red on a harmless refactor and green on nothing that matters.
 *
 * ---
 *
 * **Mutation run.** Every guard here was checked by breaking the code and
 * confirming it went red. Recorded because one of these cases passed for the
 * wrong reason first time round, and only the mutation caught it:
 *
 * | mutation | result |
 * | --- | --- |
 * | the pref read moved back to `useEffect([userId])` — the shipped bug | **5 red** |
 * | same, keeping the cleanup — so the test keys on *where*, not on the return | **5 red** |
 * | `return stop` dropped from the focus effect | 1 red |
 * | Settings writes the master under a different key | 1 red |
 * | Settings writes `'true'`/`'false'` instead of `'1'`/`'0'` | 1 red |
 * | the per-discipline toggle serialises an empty set | 2 red |
 * | "Suggest again" does not remove the id from the set | 1 red |
 * | Today's dismiss never reaches storage | 1 red |
 * | the focus callback keyed on `[]` | **survives** |
 *
 * **The survivor is deliberate, and lint is its guard.** Keyed on `[]` the
 * callback freezes, so a `userId` change would have the screen reading the
 * previous account's preferences — real, but a different bug from this one, and
 * unreachable here because the Clerk mock's user never changes. Under the
 * `[]` mutation `react-hooks/exhaustive-deps` reports a missing-dependency
 * warning on this exact line, which takes `lint:mobile` from 54 to 55 against
 * `--max-warnings=54` and fails the gate. Same division of labour
 * `bjjSessionScreen.test.tsx` documents: the lint rule catches the class, the
 * test catches the runtime behaviour a static rule cannot see.
 *
 * The two cases that stay green under the real bug are the two that assert a
 * card is still *there* — a screen that never re-reads also never hides it.
 * They are negative controls, and a version of this file with only those would
 * be worthless.
 */

jest.setTimeout(30_000);

/**
 * A controllable stand-in for the screen's `navigation`, modelled on
 * `expo-router/build/useFocusEffect.js`.
 *
 * One singleton, so its identity is stable across renders. The real hook keys
 * its outer effect on `[effect, navigation, optionalNavigation]`; an unstable
 * navigation there would re-run the effect on every render, which would hide
 * the very bug this file exists to expose by making *any* code shape look like
 * it re-reads.
 */
const mockNav = {
  focused: true,
  listeners: { focus: new Set<() => void>(), blur: new Set<() => void>() },
};

/** Leave the screen — what pushing `/settings/suggestions` over the tabs does. */
function blur() {
  mockNav.focused = false;
  [...mockNav.listeners.blur].forEach((l) => l());
}

/** Come back to it. */
function focus() {
  mockNav.focused = true;
  [...mockNav.listeners.focus].forEach((l) => l());
}

// Replaces the shared mock WHOLESALE — jest.mock does not merge — so every
// export Today and the settings screen touch has to be re-supplied. Today
// calls useRouter() and throws without it.
jest.mock('expo-router', () => {
  // `jest.requireActual`, not `require`. Both work inside a hoisted factory,
  // but bare `require()` is a `@typescript-eslint/no-require-imports` warning
  // and `lint:mobile` runs at `--max-warnings=54` with no headroom, so a new
  // test file that reaches for the older idiom fails the gate.
  const React = jest.requireActual('react');
  const { Text } = jest.requireActual('react-native');

  const useFocusEffect = (effect: () => void | (() => void)) => {
    React.useEffect(() => {
      let isFocused = false;
      let cleanup: (() => void) | void;

      if (mockNav.focused) {
        cleanup = effect();
        isFocused = true;
      }

      const onFocus = () => {
        // The real hook guards this because navigation also emits `focus` on
        // the initial render; without the guard a screen mounted focused runs
        // its effect twice and every call count in this file is off by one.
        if (isFocused) return;
        if (cleanup !== undefined) cleanup();
        cleanup = effect();
        isFocused = true;
      };
      const onBlur = () => {
        if (cleanup !== undefined) cleanup();
        cleanup = undefined;
        isFocused = false;
      };

      mockNav.listeners.focus.add(onFocus);
      mockNav.listeners.blur.add(onBlur);
      return () => {
        if (cleanup !== undefined) cleanup();
        mockNav.listeners.focus.delete(onFocus);
        mockNav.listeners.blur.delete(onBlur);
      };
    }, [effect]);
  };

  // ONE router object rather than a fresh one per call, for the same
  // identity-stability reason as `mockNav` — see lib/useAuthToken.ts, where an
  // unstable getter turned every dependent effect into a refetch loop.
  const router = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
  return {
    useFocusEffect,
    useLocalSearchParams: () => ({}),
    useRouter: () => router,
    Link: ({ children }: { children?: unknown }) => React.createElement(Text, null, children),
    Stack: { Screen: () => null },
  };
});

/**
 * A REAL migrated SQLite database, shared by both screens.
 *
 * `lib/prefs.ts` calls `getDb()` inside every function, so this one mock covers
 * the settings screen's `writePref` and Today's four `readPref` calls at once —
 * which is what makes them agreeing (or not) observable.
 *
 * The `{ ...real }` spread is load-bearing, not tidiness: `migratedFixture()`
 * imports the app's own `migrate` from the very module being mocked, so
 * dropping it fails with `_db.migrate is not a function` pointing at the
 * fixture rather than at this block.
 */
let mockDb: FixtureDb;
jest.mock('@/lib/db', () => {
  const real = jest.requireActual('@/lib/db');
  return { ...real, getDb: async () => mockDb };
});

/**
 * Relative, deliberately.
 *
 * `funnelGap` drops evidence older than `MAX_AGE_DAYS` (60) and the screen sets
 * `now = new Date()` on focus, so a hard-coded date here would quietly stop
 * producing a card two months after it was written and the file would go green
 * by rendering nothing. A test that expires is worse than no test: it passes.
 */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * Two rows, and both are required.
 *
 * `arm-drag` is the candidate: drilled well past `MIN_DRILLED`, never tried.
 * `scissor-sweep` exists only to satisfy `countersInUse` — `funnelGap` refuses
 * to read "0 attempted" as meaningful unless *some* row proves the athlete uses
 * the live counters at all, because only the focus grid writes them. One row
 * can never be both: the candidate needs `attempted + scored === 0`.
 */
const mockFunnel: Proficiency[] = [
  {
    technique_id: 'arm-drag',
    name: 'Arm drag',
    position: 'Standing',
    category: 'Sweep',
    drilled: 9,
    attempted: 0,
    scored: 0,
    conceded: 0,
    sessions: 3,
    last_seen: daysAgo(3),
  },
  {
    technique_id: 'scissor-sweep',
    name: 'Scissor sweep',
    position: 'Guard',
    category: 'Sweep',
    drilled: 2,
    attempted: 1,
    scored: 1,
    conceded: 0,
    sessions: 2,
    last_seen: daysAgo(3),
  },
];

// Network-only by design, so there is nothing local to seed — without rows
// `funnel` stays null and the card never renders, leaving nothing to assert
// disappeared.
jest.mock('@/lib/proficiency', () => ({ fetchProficiency: jest.fn(async () => mockFunnel) }));

// The settings screen resolves dismissed ids to names through this. Our
// dismissed set is empty so the effect returns early, but an unmocked network
// call left pending outlives the test and reports as an open handle.
jest.mock('@/lib/techniques', () => ({ fetchTechniques: jest.fn(async () => []) }));

/**
 * Two disciplines, because the per-discipline switches render one row each from
 * `enabledSports(modules)` — with the real provider's context default
 * (`modules: []`) there would be no BJJ row to toggle, and the second half of
 * this file would silently assert nothing.
 */
const mockModules: Module[] = (['bjj', 'strength'] as const).map((key) => ({
  key,
  label: key === 'bjj' ? 'BJJ' : 'Strength',
  is_sport: true,
  default_on: true,
  enabled: true,
  capabilities: {
    catalog: key === 'bjj' ? 'techniques' : 'exercises',
    facets: key === 'bjj' ? ['position', 'belt'] : [],
    has_goals: false,
    has_progression: key === 'strength',
    record_kinds: key === 'strength' ? ['1rm'] : [],
  },
}));
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: mockModules, ready: true, refresh: jest.fn() }),
  ModulesProvider: ({ children }: { children?: unknown }) => children,
}));

const USER = 'u1'; // matches jest.setup.js's Clerk mock

beforeEach(async () => {
  mockDb = await migratedFixture();
  mockNav.focused = true;
  mockNav.listeners.focus.clear();
  mockNav.listeners.blur.clear();
});

/** Today, mounted and focused, with its suggestion on screen. */
async function renderTodayShowingASuggestion() {
  const view = render(<Today />);
  await waitFor(() => expect(view.getByTestId('today-suggestion')).toBeTruthy());
  return view;
}

describe('a preference changed while Today sat mounted', () => {
  it('is picked up when Today is returned to', async () => {
    const today = await renderTodayShowingASuggestion();

    // Exactly what the settings screen writes. `'0'`, NOT `'false'`:
    // `parseMaster` is `raw !== '0'`, so any other string reads as ON and this
    // test would pass against the bug — measured, with the card still on
    // screen. The literal is the contract.
    blur();
    await writePref(USER, PREF_SUGGESTIONS, '0');
    await act(async () => {
      focus();
    });

    await waitFor(() => expect(today.queryByTestId('today-suggestion')).toBeNull());
  });

  it('is NOT picked up without returning, which is what made the bug invisible', async () => {
    // The other half of the story, and the reason the fix is about focus rather
    // than about polling: while the athlete is still away, Today is entitled to
    // go on showing what it last read. If this ever fails, the screen has grown
    // a second read path and the focus effect is no longer the thing under test.
    const today = await renderTodayShowingASuggestion();

    blur();
    await writePref(USER, PREF_SUGGESTIONS, '0');
    await act(async () => {});

    expect(today.queryByTestId('today-suggestion')).toBeTruthy();
  });

  it('comes back when the preference is turned on again', async () => {
    // A one-way test would pass against a screen that hides the card on any
    // refocus at all.
    const today = await renderTodayShowingASuggestion();

    blur();
    await writePref(USER, PREF_SUGGESTIONS, '0');
    await act(async () => {
      focus();
    });
    await waitFor(() => expect(today.queryByTestId('today-suggestion')).toBeNull());

    blur();
    await writePref(USER, PREF_SUGGESTIONS, '1');
    await act(async () => {
      focus();
    });
    await waitFor(() => expect(today.queryByTestId('today-suggestion')).toBeTruthy());
  });
});

describe('a read still in flight when the screen is left', () => {
  it('is discarded rather than landing on a screen nobody is looking at', async () => {
    /*
     * What the focus effect's returned cleanup is for. `readSuggestionPrefs`
     * closes over `alive`, and the cleanup flips it false; every `.then` checks
     * it before calling `setState`. Drop the `return stop` and nothing visible
     * changes in the happy path — which is why this needs its own case, and why
     * the mutation run that found this hole is worth repeating on any change
     * here.
     *
     * Arranged so the discarded read is one that WOULD have changed the screen:
     * the preference is already '0' before the read goes out, so a landing read
     * hides the card. Blurring first must leave it up.
     */
    const today = await renderTodayShowingASuggestion();
    await writePref(USER, PREF_SUGGESTIONS, '0');

    // Hold the pref reads open. Scoped to `prefs` so the session, plan and
    // workout reads Today fires on the same focus are unaffected — blocking
    // those would stall the render for reasons unrelated to what is being
    // tested.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const realGetFirst = mockDb.getFirstAsync.bind(mockDb);
    mockDb.getFirstAsync = (async (sql: string, ...params: unknown[]) => {
      if (sql.includes('prefs')) await held;
      return realGetFirst(sql, ...params);
    }) as typeof mockDb.getFirstAsync;

    // Leave first. `focus()` on an already-focused screen is a no-op — the real
    // hook guards against the duplicate focus event navigation fires at mount,
    // and this mock copies that guard. Without this line the effect never
    // re-runs, no read goes out, and the case below asserts nothing at all:
    // written that way it passed, and went on passing with the cleanup deleted.
    await act(async () => {
      blur();
    });
    await act(async () => {
      focus();
    });
    // Left again before the reads come back — the athlete tapped through to
    // another tab while SQLite was still working.
    await act(async () => {
      blur();
    });
    await act(async () => {
      release();
    });

    expect(today.queryByTestId('today-suggestion')).toBeTruthy();
  });
});

/**
 * The round trip through the real screen.
 *
 * The block above writes the preference itself, so it proves the *timing* and
 * nothing about who writes it — a settings screen that wrote the wrong key, or
 * `'off'` instead of `'0'`, would sail through it. These drive the actual
 * `Switch` and let SQLite carry the value across, so the two screens have to
 * agree on the key and the encoding for the card to move.
 */
describe('the switches in Settings', () => {
  it('silence the suggestion when the master is turned off', async () => {
    const today = await renderTodayShowingASuggestion();

    // Pushed OVER the tabs, so Today blurs and stays mounted — the arrangement
    // that made this bug reachable in the first place.
    blur();
    const settings = render(<SuggestionSettingsScreen />);
    const master = await waitFor(() => settings.getByTestId('suggestions-master'));
    await act(async () => {
      fireEvent(master, 'valueChange', false);
    });

    await act(async () => {
      focus();
    });
    await waitFor(() => expect(today.queryByTestId('today-suggestion')).toBeNull());
  });

  it('silence it when only BJJ is turned off, master still on', async () => {
    // The narrower path, and the one that exercises the list encoding rather
    // than a single character: Settings serialises a Set to JSON and Today
    // parses it back.
    const today = await renderTodayShowingASuggestion();

    blur();
    const settings = render(<SuggestionSettingsScreen />);
    const bjj = await waitFor(() => settings.getByTestId('suggestions-bjj'));
    await act(async () => {
      fireEvent(bjj, 'valueChange', false);
    });

    // The master is untouched, so a card that vanishes here can only have done
    // so through the off-list.
    expect(await readPref(USER, PREF_SUGGESTIONS)).not.toBe('0');
    expect(await readPref(USER, PREF_SUGGESTIONS_OFF)).toBe('["bjj"]');

    await act(async () => {
      focus();
    });
    await waitFor(() => expect(today.queryByTestId('today-suggestion')).toBeNull());
  });

  it('undo a dismissal, and the suggestion comes back', async () => {
    /*
     * The whole loop, in the order an athlete does it: dismiss the card on
     * Today, find it under DISMISSED in Settings, tap "Suggest again", come
     * back. Three writes and three reads across two screens, and the only one
     * of the three controls whose failure was *visible* — the other two look
     * like a setting that did nothing, this one looks like a button that did
     * nothing.
     *
     * Dismissing through the card rather than seeding the preference is
     * deliberate: it makes the id Today writes and the id Settings lists the
     * same value, so a change to `serialiseDismissed` has to keep both ends
     * agreeing rather than only the end this file wrote by hand.
     */
    const today = await renderTodayShowingASuggestion();

    await act(async () => {
      fireEvent.press(today.getByTestId('today-suggestion-dismiss'));
    });
    // Optimistic — the card goes immediately rather than after the write lands,
    // so this says nothing yet about what reached SQLite.
    await waitFor(() => expect(today.queryByTestId('today-suggestion')).toBeNull());

    blur();
    const settings = render(<SuggestionSettingsScreen />);
    // That it is listed at all is the assertion: the id had to survive
    // serialisation, the database and parsing to get here. `fetchTechniques` is
    // mocked empty, so the row falls back to the raw id — which is the branch
    // that matters, since a failed name lookup must not cost the undo.
    const restore = await waitFor(() => settings.getByTestId('suggestions-restore-arm-drag'));
    await act(async () => {
      fireEvent.press(restore);
    });

    await act(async () => {
      focus();
    });
    await waitFor(() => expect(today.queryByTestId('today-suggestion')).toBeTruthy());
  });

  it('leaves BJJ alone when a different discipline is silenced', async () => {
    // Turning Strength off must not silence a BJJ suggestion. Without this,
    // `suggestionsAllowed` could ignore its `sport` argument entirely and every
    // other test here would still pass.
    const today = await renderTodayShowingASuggestion();

    blur();
    const settings = render(<SuggestionSettingsScreen />);
    const strength = await waitFor(() => settings.getByTestId('suggestions-strength'));
    await act(async () => {
      fireEvent(strength, 'valueChange', false);
    });

    await act(async () => {
      focus();
    });
    expect(await readPref(USER, PREF_SUGGESTIONS_OFF)).toBe('["strength"]');
    await waitFor(() => expect(today.queryByTestId('today-suggestion')).toBeTruthy());
  });
});
