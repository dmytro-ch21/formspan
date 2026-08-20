import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import GoalsScreen from '../(tabs)/goals';
import {
  cacheActivityLevel,
  readActivityChoice,
  rememberActivityChoice,
  settleActivityChoice,
} from '@/lib/activityLevel';
import { ApiError } from '@/lib/apiError';
import { fetchAdjustment, listTargets, saveTarget, suggestedTarget } from '@/lib/nutritionApi';
import { setActivityLevel } from '@/lib/profile';

/**
 * The Goals tab, and the two things that broke when it stopped being a pushed
 * screen (N70).
 *
 * `app/food/target.tsx` was opened from Food, so it REMOUNTED on every visit:
 * the fetch ran, the arithmetic ladder was current, and the day it saves
 * against was evaluated afresh. A tab mounts once, lazily, and then stays
 * mounted for the life of the process. Neither symptom is visible in a diff and
 * neither is reachable by a test that renders the screen once — they both need
 * a second visit, which is exactly why review found them and the suite did not.
 *
 * These are component tests rather than pure ones because the properties are
 * about LIFECYCLE: what a refocus does, and what a stale receipt is still
 * claiming afterwards. There is nothing pure to extract.
 */

// RNTL's default `asyncUtilTimeout` is ONE SECOND, and this suite needs longer:
// clearing the receipt runs a refetch, a promise resolution and a re-render, and
// on a CI runner that chain exceeded a second. It passed locally at ~1.4s and
// failed on CI, which is the worst way to find out. Six suites here already
// raise it for the same reason, and `jest.config.js`'s `testTimeout: 15_000`
// is what makes ten seconds actually reachable — see F13, where five files
// asked for ten and jest killed them at five.
configure({ asyncUtilTimeout: 10_000 });

jest.mock('@/lib/nutritionApi', () => ({
  suggestedTarget: jest.fn(),
  saveTarget: jest.fn(),
  listTargets: jest.fn(),
  fetchAdjustment: jest.fn(),
  // NOT a stub. `targetOn` is the pure "newest row on or before this day" rule,
  // and a mock returning whatever the test handed it would supply the very
  // behaviour under test — the screen would pass while picking the wrong row.
  // The real one comes from the module itself.
  targetOn: jest.requireActual('@/lib/nutritionApi').targetOn,
}));

// ONE getter, created once — because that is the real hook's contract, not a
// convenience. `useAuthToken` returns `useCallback(..., [])` and its docstring
// explains why in detail: Clerk's own `getToken` is rebuilt every render, and
// anything depending on it turns a focus fetch into an infinite refetch loop
// that also wipes local state a frame after each load.
//
// A mock handing out a fresh `jest.fn()` per render reintroduces exactly that
// loop inside the test, and the screen then fails for a reason that does not
// exist in the app. It did, before this was fixed.
const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({
  useAuthToken: () => mockTokenGetter,
}));

jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#8BC34A', on: '#000' }),
}));

/**
 * The activity-level store, stubbed at the STORAGE boundary only.
 *
 * `activityParam`, `adoptServerActivity` and `isActivityLevel` come through
 * `requireActual` — they are the reconciliation rule, and a mock returning
 * whatever the test handed it would SUPPLY the behaviour under test. Same
 * reasoning as `targetOn` above. What is stubbed is the four functions that
 * touch SQLite, because `expo-sqlite` cannot run here and because their SQL is
 * covered properly by `lib/__tests__/activityLevel.test.ts` against a real
 * database.
 */
jest.mock('@/lib/activityLevel', () => ({
  ...jest.requireActual('@/lib/activityLevel'),
  readActivityChoice: jest.fn(),
  rememberActivityChoice: jest.fn(),
  cacheActivityLevel: jest.fn(),
  settleActivityChoice: jest.fn(),
}));

jest.mock('@/lib/profile', () => ({ setActivityLevel: jest.fn() }));

const mockRead = readActivityChoice as jest.MockedFunction<typeof readActivityChoice>;
const mockCache = cacheActivityLevel as jest.MockedFunction<typeof cacheActivityLevel>;
const mockRemember = rememberActivityChoice as jest.MockedFunction<typeof rememberActivityChoice>;
const mockSettle = settleActivityChoice as jest.MockedFunction<typeof settleActivityChoice>;
const mockPushLevel = setActivityLevel as jest.MockedFunction<typeof setActivityLevel>;

/**
 * The focus effect is the subject, so it is driven by hand rather than mocked
 * away: `refocus()` runs every registered callback the way returning to a tab
 * does.
 *
 * **An ARRAY, not one callback, and that is not tidiness.** The screen has two
 * focus effects now — the derivation, which the activity pills change, and the
 * live target plus the weekly proposal, which they cannot. An earlier version
 * of this mock kept a single `refocus` and each `useFocusEffect` overwrote the
 * last, so `refocus()` re-ran only whichever registered second and the other
 * effect was silently untested through the one door that exercises it.
 */
const mockFocusCbs: (() => void | (() => void))[] = [];
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  // Keyed on the CALLBACK, not on []. React Navigation re-runs a focus effect
  // when its callback identity changes while the screen is focused, and the
  // screen relies on exactly that: `load` changes with the activity, so moving
  // a pill refetches through this path rather than through a second effect.
  // Pinned to [] this mock silently models a different hook, and the test fails
  // against correct code — which is what it did first.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const react = jest.requireActual('react') as typeof import('react');
    react.useEffect(() => {
      mockFocusCbs.push(cb);
      const cleanup = cb();
      return () => {
        const i = mockFocusCbs.indexOf(cb);
        if (i >= 0) mockFocusCbs.splice(i, 1);
        if (cleanup) cleanup();
      };
    }, [cb]);
  },
}));

function refocus() {
  // Copied before iterating: a callback re-registering during the loop would
  // otherwise be run twice, or skipped, depending on where it landed.
  for (const cb of [...mockFocusCbs]) cb();
}

const mockSuggested = suggestedTarget as jest.MockedFunction<typeof suggestedTarget>;
const mockSave = saveTarget as jest.MockedFunction<typeof saveTarget>;
const mockList = listTargets as jest.MockedFunction<typeof listTargets>;
const mockAdjust = fetchAdjustment as jest.MockedFunction<typeof fetchAdjustment>;

/**
 * Whether a pill is rendered as the athlete's own choice.
 *
 * Read off the prop rather than through `toHaveAccessibilityState`, which this
 * version of RNTL does not ship. `accessibilityState.selected` is the thing
 * VoiceOver actually announces, so it is also the property worth asserting:
 * a pill that merely LOOKS unselected while announcing itself as selected is
 * still telling a blind athlete they chose something they did not.
 */
function selectedState(testID: string): boolean | undefined {
  return screen.getByTestId(testID).props.accessibilityState?.selected;
}

/** A stored target, as the server sends it back. */
function target(over: Partial<Awaited<ReturnType<typeof listTargets>>[number]> = {}) {
  return {
    effective_on: '2020-01-01',
    kcal: 2700,
    protein_g: 180,
    carb_g: 300,
    fat_g: 80,
    fibre_g: 30,
    source: 'derived' as const,
    ...over,
  };
}

/** A weekly proposal, with only the fields the card actually reads. */
function proposal(over: Record<string, unknown> = {}) {
  return {
    adjustment: {
      from_kcal: 2700,
      to_kcal: 2480,
      delta_kcal: -220,
      protein_g: 180,
      carb_g: 240,
      fat_g: 80,
      fibre_g: 30,
      effective_on: '2030-06-02',
      basis: null,
      ...over,
    },
    blocked_by: [],
  } as unknown as Awaited<ReturnType<typeof fetchAdjustment>>;
}

function suggestion(kcal: number) {
  return {
    suggestion: {
      kcal,
      protein_g: 150,
      carb_g: 300,
      fat_g: 70,
      fibre_g: 30,
      basis: {
        rmr_kcal: 1700,
        rmr_precision: 'estimated',
        activity_factor: 1.35,
        training_kcal: 300,
        phase_delta_kcal: -400,
        weight_kg: 80,
        projection: null,
      },
    },
    missing: [],
    activity: 'light',
    activity_chosen: false,
  } as unknown as Awaited<ReturnType<typeof suggestedTarget>>;
}

beforeEach(() => {
  jest.clearAllMocks();
  // A device that has never been told, and a server that says it assumed —
  // the state a brand-new athlete is actually in.
  mockRead.mockResolvedValue({ level: null, owed: false });
  mockRemember.mockResolvedValue(undefined);
  mockSettle.mockResolvedValue(undefined);
  // Must RESOLVE, not merely be callable. The screen writes the settled level
  // back with `void cacheActivityLevel(...).catch(...)`, so a `jest.fn()`
  // returning undefined throws inside the effect - which surfaces as six
  // unrelated tests timing out, not as anything pointing here.
  mockCache.mockResolvedValue(undefined);
  mockPushLevel.mockResolvedValue(undefined as never);
  mockSuggested.mockResolvedValue(suggestion(2400));
  mockSave.mockResolvedValue(undefined as never);
  mockList.mockResolvedValue([]);
  mockAdjust.mockResolvedValue({ adjustment: null, blocked_by: [] });
});

describe('the Goals tab refetches when it is focused again', () => {
  // A tab mounts once and stays mounted. Without a focus refetch the ladder
  // keeps describing the weight, training load and phase it read the first time
  // the tab was ever opened — including after the athlete changes their phase
  // from a button on this very screen.
  it('asks again on every focus, not only on mount', async () => {
    render(<GoalsScreen />);
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(1));

    refocus();
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(2));
  });
});

describe('the saved receipt', () => {
  it('appears when a target is accepted', async () => {
    render(<GoalsScreen />);
    const accept = await screen.findByTestId('target-accept');
    fireEvent.press(accept);

    expect(await screen.findByTestId('target-saved')).toBeTruthy();
  });

  // The receipt belongs to the numbers that were saved. Moving an activity pill
  // produces a fresh and UNSAVED suggestion, and leaving "Saved" underneath it
  // attaches a confirmation to something that was never stored — worse than
  // showing nothing, because the athlete has no reason to doubt it.
  it('goes away when the suggestion is replaced by a fresh one', async () => {
    render(<GoalsScreen />);
    fireEvent.press(await screen.findByTestId('target-accept'));
    expect(await screen.findByTestId('target-saved')).toBeTruthy();

    mockSuggested.mockResolvedValue(suggestion(2100));
    fireEvent.press(screen.getByTestId('target-activity-active'));

    // Sequenced in two steps rather than one, because they fail for different
    // reasons and a single `waitFor` cannot say which happened: the refetch not
    // firing at all, or firing and not clearing the receipt. The first version
    // asserted only the second and went red on CI while passing locally — the
    // race was invisible because the machine was fast enough to hide it.
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('target-saved')).toBeNull());
  });

  // The same rule through the other door: coming back to the tab re-asks, so
  // whatever is on screen is unsaved again.
  it('goes away when the tab is focused again', async () => {
    render(<GoalsScreen />);
    fireEvent.press(await screen.findByTestId('target-accept'));
    expect(await screen.findByTestId('target-saved')).toBeTruthy();

    refocus();
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('target-saved')).toBeNull());
  });
});

/**
 * N72 — the two ways of DISAGREEING with the derivation, which lived on web
 * only until now.
 *
 * The screen could show an athlete the whole argument for 2,700 kcal and gave
 * them nowhere to answer it. These cover the answer: a number you type, and the
 * weekly correction you accept — plus the row that says which of the three is
 * actually in force, because with three sources on one screen that is the thing
 * most easily got wrong.
 */

/**
 * Open the typed-target form, AFTER the derivation has landed.
 *
 * The wait is not politeness. The form seeds itself at mount and never again —
 * that is what stops a late fetch overwriting digits somebody is typing — so a
 * form opened before the suggestion arrives seeds on nothing, and the prefill
 * assertions below are then testing an empty form.
 *
 * This used to press the toggle the instant it existed and pass anyway, purely
 * because `mockResolvedValue` settled within one microtask. N93 put a local
 * cache read in front of the fetch and the race flipped: same code, same
 * intent, suddenly red. The dependency was always there and was never stated.
 *
 * Keyed on the loading note rather than on a suggestion, so it works equally
 * for the case where nothing can be derived — `data` is set either way.
 */
async function openManualForm() {
  await waitFor(() => expect(screen.queryByText('Working it out…')).toBeNull());
  fireEvent.press(await screen.findByTestId('manual-toggle'));
  return screen.findByTestId('manual-form');
}

/** Fill the four required fields with a coherent set of numbers. */
function typeATarget(kcal: string) {
  fireEvent.changeText(screen.getByTestId('manual-kcal'), kcal);
  fireEvent.changeText(screen.getByTestId('manual-protein_g'), '170');
  fireEvent.changeText(screen.getByTestId('manual-carb_g'), '200');
  fireEvent.changeText(screen.getByTestId('manual-fat_g'), '70');
}

describe('typing your own target', () => {
  it('saves it as manual, with no arithmetic attached', async () => {
    render(<GoalsScreen />);
    await openManualForm();

    typeATarget('2000');
    fireEvent.press(screen.getByTestId('manual-save'));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const body = mockSave.mock.calls[0][2];
    expect(body.kcal).toBe(2000);
    expect(body.source).toBe('manual');
    // A typed number has no derivation. Sending the suggestion's basis along
    // would be the tidy-looking version of attaching an explanation that was
    // never true — and the row above would then offer to show it.
    expect(body.basis).toBeNull();
    // 30 rather than null, and that is the prefill doing its job: the form
    // opened on the suggestion, whose fibre is 30, and the athlete changed
    // four fields rather than five. Asserting null here was the first version
    // of this test and it failed against correct code.
    expect(body.fibre_g).toBe(30);
  });

  it('sends an unstated fibre as null rather than as a confident zero', async () => {
    render(<GoalsScreen />);
    await openManualForm();

    typeATarget('2000');
    // Cleared, not left at the seed — a target that does not state fibre is
    // not a zero-fibre target, and `Number('')` is a perfectly finite 0.
    fireEvent.changeText(screen.getByTestId('manual-fibre_g'), '');
    fireEvent.press(screen.getByTestId('manual-save'));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    expect(mockSave.mock.calls[0][2].fibre_g).toBeNull();
  });

  it('refuses to save an incomplete form, and says why', async () => {
    render(<GoalsScreen />);
    await openManualForm();

    fireEvent.changeText(screen.getByTestId('manual-kcal'), '2000');
    // Emptied deliberately. `Number('')` is a finite 0, so without the parse
    // guard this would store 0 g of protein as though somebody chose it.
    fireEvent.changeText(screen.getByTestId('manual-protein_g'), '');
    fireEvent.press(screen.getByTestId('manual-save'));

    expect(await screen.findByTestId('manual-problem')).toBeTruthy();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('says so when the save could not reach the server', async () => {
    // Offline is this app's ordinary weather, and a button that simply
    // un-dims reads as a successful save.
    mockSave.mockRejectedValueOnce(new Error('offline'));
    render(<GoalsScreen />);
    await openManualForm();

    typeATarget('2000');
    fireEvent.press(screen.getByTestId('manual-save'));

    const failed = await screen.findByTestId('manual-failed');
    expect(failed).toHaveTextContent(/try again when you have signal/);
  });

  it('reports a server REFUSAL in the server’s words, not as bad signal', async () => {
    // The bug this covers: every failure shared the offline sentence, so an
    // athlete whose number the server permanently refuses was sent to look for
    // a better connection for a request that would fail identically forever.
    // A dead end presented as weather.
    mockSave.mockRejectedValueOnce(
      new ApiError('kcal must be between 800 and 8000', 'invalid_input', 400),
    );
    render(<GoalsScreen />);
    await openManualForm();

    typeATarget('2000');
    fireEvent.press(screen.getByTestId('manual-save'));

    const failed = await screen.findByTestId('manual-failed');
    expect(failed).toHaveTextContent(/must be between 800 and 8000/);
    expect(failed).not.toHaveTextContent(/signal/);
  });

  it('catches a mis-keyed calorie figure before it costs a round trip', async () => {
    // The client rail now matches the server's, so the common typo — a dropped
    // digit — is refused locally with the limit named, and `saveTarget` is
    // never called. A client rail WIDER than the server's is worse than none:
    // it guarantees the confusing remote failure above.
    render(<GoalsScreen />);
    await openManualForm();

    typeATarget('700');
    fireEvent.press(screen.getByTestId('manual-save'));

    expect(await screen.findByTestId('manual-problem')).toHaveTextContent(/between 800 and 8000/);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('opens on what is in force, so disagreeing means editing one number', async () => {
    // The point of the prefill: five fields on a number pad is authoring a
    // target from scratch, which is not something anybody does standing up.
    mockList.mockResolvedValue([target({ kcal: 2700 })]);
    render(<GoalsScreen />);
    await screen.findByTestId('live-target');
    await openManualForm();

    expect(screen.getByTestId('manual-kcal').props.value).toBe('2700');
  });

  it('re-reads what is in force after saving', async () => {
    // Without this the athlete types 2,000, saves, and the heading still says
    // 2,700 — which reads as the save not having worked.
    mockList.mockResolvedValue([target({ kcal: 2700 })]);
    render(<GoalsScreen />);
    await screen.findByTestId('live-target');
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    await openManualForm();

    typeATarget('2000');
    fireEvent.press(screen.getByTestId('manual-save'));

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('is reachable when no target can be derived at all', async () => {
    // The athlete with an incomplete profile is precisely the one with no other
    // way to get a target. Nesting the form inside the derivation block would
    // hide the escape hatch from the only people who need it.
    mockSuggested.mockResolvedValue({
      suggestion: null,
      missing: ['height_cm'],
    } as unknown as Awaited<ReturnType<typeof suggestedTarget>>);
    render(<GoalsScreen />);

    expect(await screen.findByTestId('manual-toggle')).toBeTruthy();
    await openManualForm();
    expect(screen.getByTestId('manual-kcal')).toBeTruthy();
  });
});

describe('what you are eating to', () => {
  it('names the source, so the ladder is not read as its working', async () => {
    mockList.mockResolvedValue([target({ source: 'manual', kcal: 2000 })]);
    render(<GoalsScreen />);

    expect(await screen.findByTestId('live-target')).toBeTruthy();
    expect(screen.getByText(/you typed this one/)).toBeTruthy();
  });

  it('distinguishes "could not read it" from "you have none"', async () => {
    // Both are zero rows. Reporting the first as the second tells an athlete
    // who set a target last week to go and set it again.
    mockList.mockRejectedValue(new Error('offline'));
    render(<GoalsScreen />);

    expect(await screen.findByTestId('live-target-unknown')).toBeTruthy();
    expect(screen.queryByTestId('live-target-none')).toBeNull();
  });

  it('says none when the read succeeded and there genuinely is none', async () => {
    mockList.mockResolvedValue([]);
    render(<GoalsScreen />);

    expect(await screen.findByTestId('live-target-none')).toBeTruthy();
  });
});

describe('the weekly adjustment', () => {
  it('explains a withheld proposal instead of showing nothing', async () => {
    // A blocked check is the ORDINARY outcome and a 200. The guards are the
    // feature, so they get plain language rather than a spinner.
    mockAdjust.mockResolvedValue({
      adjustment: null,
      blocked_by: ['not_weighing', 'too_soon'],
    } as unknown as Awaited<ReturnType<typeof fetchAdjustment>>);
    render(<GoalsScreen />);

    expect(await screen.findByTestId('adjustment-blocked-not_weighing')).toBeTruthy();
    expect(screen.getByTestId('adjustment-blocked-too_soon')).toBeTruthy();
    expect(screen.getByText(/Four in each of the last two weeks/)).toBeTruthy();
  });

  it('files an accepted proposal under ITS OWN date, never today', async () => {
    // The server picks tomorrow deliberately: a target applied retroactively
    // judges a day already mostly eaten, and the remaining figure jumps under
    // the athlete's thumb. Substituting today's date is the one-character
    // version of that bug, and it would look completely correct.
    mockAdjust.mockResolvedValue(proposal({ effective_on: '2030-06-02' }));
    render(<GoalsScreen />);

    fireEvent.press(await screen.findByTestId('adjustment-accept'));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const [, date, body] = mockSave.mock.calls[0];
    expect(date).toBe('2030-06-02');
    expect(body.kcal).toBe(2480);
    expect(body.source).toBe('adjustment');
    // An adjustment's arithmetic is a different shape from a derivation's and
    // the row stores the latter. Null keeps the stored explanation honest.
    expect(body.basis).toBeNull();
  });

  it('says so when accepting could not reach the server', async () => {
    mockAdjust.mockResolvedValue(proposal());
    mockSave.mockRejectedValueOnce(new Error('offline'));
    render(<GoalsScreen />);

    fireEvent.press(await screen.findByTestId('adjustment-accept'));
    expect(await screen.findByTestId('adjustment-failed')).toBeTruthy();
  });

  /**
   * The arithmetic ladder, which was entirely unrendered by this suite until
   * review pointed it out: every fixture carried `basis: null`, so the card's
   * whole argument — six rows and both sign formatters — was dead code as far
   * as any test could tell. "Show the arithmetic" is the feature; a proposal
   * you cannot inspect is a verdict.
   */
  describe('the arithmetic behind a proposal', () => {
    const withBasis = () =>
      proposal({
        basis: {
          observed_kg_per_week: -0.3,
          observed_pct_per_week: -0.003,
          target_kg_per_week: -0.6,
          target_pct_per_week: -0.0075,
          trend_weight_kg: 80,
          earlier_trend_weight_kg: 80.3,
          weighins_recent_half: 5,
          weighins_earlier_half: 4,
          days_logged: 12,
          days_considered: 14,
          days_on_current_target: 21,
          kcal_per_kg: 7700,
          raw_delta_kcal: -330,
          capped: true,
          cap_reason: 'a step this size is capped at 220 kcal',
        },
      });

    it('is hidden until asked for, then shown', async () => {
      // Collapsed by default on the phone — this screen already carries a
      // six-row derivation ladder, and opening a second above it pushes the
      // thing you came for off the first screenful.
      mockAdjust.mockResolvedValue(withBasis());
      render(<GoalsScreen />);

      await screen.findByTestId('adjustment-proposal');
      expect(screen.queryByTestId('adjustment-arithmetic')).toBeNull();

      fireEvent.press(screen.getByTestId('adjustment-toggle'));
      expect(await screen.findByTestId('adjustment-arithmetic')).toBeTruthy();
    });

    it('shows the RAW figure when the step was capped', async () => {
      // Shown BECAUSE it was capped. Hiding it makes the final number look
      // like the arithmetic's answer when it deliberately is not — the last
      // line would simply not follow from the one above it.
      mockAdjust.mockResolvedValue(withBasis());
      render(<GoalsScreen />);
      fireEvent.press(await screen.findByTestId('adjustment-toggle'));

      const ladder = await screen.findByTestId('adjustment-arithmetic');
      expect(ladder).toHaveTextContent(/−330 kcal/);
      expect(ladder).toHaveTextContent(/capped — a step this size is capped at 220 kcal/);
    });

    it('states the evidence the proposal rests on', async () => {
      // The proposal is only as good as the fortnight behind it, and the
      // fortnight is not visible in the number.
      mockAdjust.mockResolvedValue(withBasis());
      render(<GoalsScreen />);
      fireEvent.press(await screen.findByTestId('adjustment-toggle'));

      expect(await screen.findByTestId('adjustment-arithmetic')).toHaveTextContent(
        /Based on 12 of 14 days logged, and 21 days on your current target/,
      );
    });

    it('signs a rate rather than leaving the direction to be inferred', async () => {
      mockAdjust.mockResolvedValue(withBasis());
      render(<GoalsScreen />);
      fireEvent.press(await screen.findByTestId('adjustment-toggle'));

      // −0.30% observed against −0.75% asked for. Both signs rendered, so a
      // formatter that dropped them — or emitted a "−0.00%" rounding artefact
      // reading as a direction — fails here.
      const ladder = await screen.findByTestId('adjustment-arithmetic');
      expect(ladder).toHaveTextContent(/−0\.30% of bodyweight per week/);
      expect(ladder).toHaveTextContent(/−0\.75% of bodyweight per week/);
    });
  });
});

describe('the activity pills move the derivation and nothing else', () => {
  // Two focus effects rather than one, and this is the property that buys it:
  // a chip press cannot change a year of target history or the weekly
  // proposal, so refetching either is two round trips on a cellular connection
  // for an answer that cannot have moved. Web made exactly this mistake and
  // its review caught it.
  it('does not refetch the targets or the proposal on a pill press', async () => {
    render(<GoalsScreen />);
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    fireEvent.press(screen.getByTestId('target-activity-active'));

    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(2));
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockAdjust).toHaveBeenCalledTimes(1);
  });
});

/**
 * N93 - the level survives leaving the tab.
 *
 * Reported from a device as "Target doesn't save previously added type of
 * activity": the pills were a `useState('light')`, so they reset on every
 * navigation and the derived calorie target reset with them. The athlete read
 * one number and came back to another, with nothing saying so.
 *
 * **Every case here needs a REFOCUS, not a second render.** A tab mounts once
 * and stays mounted for the life of the process, so a test that renders the
 * screen twice tests a lifecycle this screen does not have - and would pass
 * against the bug.
 */
describe('the activity level is remembered', () => {
  it('is read back on every focus, not only on mount', async () => {
    render(<GoalsScreen />);
    await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(1));

    refocus();

    // The mount-effect version of this passed every other test in this file
    // and failed exactly here. It is the whole ticket.
    await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(2));
  });

  it('shows the stored level on arrival, without anybody pressing anything', async () => {
    // The cache and the server agree, which is the ordinary state. They have
    // to be set together: the response is what the screen ultimately believes,
    // so a fixture where the device holds `active` and the server reports
    // nobody has chosen is not a stale cache, it is an incoherent world.
    mockRead.mockResolvedValue({ level: 'active', owed: false });
    mockSuggested.mockResolvedValue({
      ...suggestion(2400),
      activity: 'active',
      activity_chosen: true,
    } as never);
    render(<GoalsScreen />);

    await waitFor(() => expect(selectedState('target-activity-active')).toBe(true));
    expect(selectedState('target-activity-light')).toBe(false);
  });

  it('lets go of a cached level the account no longer holds', async () => {
    // The device cached `active` from an earlier sync and owes nothing, so the
    // server is authoritative - and it says nobody has chosen. Keeping the
    // local copy here would let a phone assert a choice the account does not
    // have, which is the same two-surfaces-disagreeing failure in the other
    // direction. It reverts to the assumption rather than to a filled pill.
    mockRead.mockResolvedValue({ level: 'active', owed: false });
    render(<GoalsScreen />);

    await waitFor(() => expect(selectedState('target-activity-active')).toBe(false));
    expect(await screen.findByTestId('target-activity-assumed')).toBeTruthy();
  });

  it('derives at the stored level rather than at the default', async () => {
    // The half that matters more than the pill: the NUMBER has to be the
    // stored level's number. A screen that highlighted the right pill and
    // still derived at `light` would look completely fixed.
    mockRead.mockResolvedValue({ level: 'active', owed: true });
    render(<GoalsScreen />);

    await waitFor(() => expect(mockSuggested).toHaveBeenCalled());
    expect(mockSuggested.mock.calls[0][2]).toBe('active');
  });

  it('asks the server what the account holds when nothing is owed', async () => {
    // No parameter, deliberately. This is the only path by which a level
    // chosen in the browser reaches the phone - pin the local value here and
    // the two surfaces derive different targets for the same athlete, which is
    // the failure the whole server-side decision exists to prevent.
    mockRead.mockResolvedValue({ level: 'active', owed: false });
    render(<GoalsScreen />);

    await waitFor(() => expect(mockSuggested).toHaveBeenCalled());
    expect(mockSuggested.mock.calls[0][2]).toBeUndefined();
  });

  it('waits for the cache before asking, so the first answer is the right one', async () => {
    let release: (v: { level: 'active'; owed: boolean }) => void = () => {};
    mockRead.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<GoalsScreen />);

    // Nothing yet. Asking first would send no parameter, take the server's
    // answer, and overwrite a choice made offline a moment before the read
    // landed - and the athlete would watch the number jump.
    await waitFor(() => expect(mockRead).toHaveBeenCalled());
    expect(mockSuggested).not.toHaveBeenCalled();

    await act(async () => {
      release({ level: 'active', owed: true });
    });
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(1));
    expect(mockSuggested.mock.calls[0][2]).toBe('active');
  });

  it('writes the choice to the device before it tries the account', async () => {
    // A gym is where this gets pressed and a gym is where there is no signal.
    // Recording the debt only when the push fails loses the change to a crash
    // between the two.
    mockPushLevel.mockRejectedValue(new Error('offline'));
    render(<GoalsScreen />);
    await waitFor(() => expect(mockSuggested).toHaveBeenCalled());

    fireEvent.press(screen.getByTestId('target-activity-active'));

    await waitFor(() => expect(mockRemember).toHaveBeenCalledWith('u1', 'active'));
    await waitFor(() => expect(mockPushLevel).toHaveBeenCalled());
    // Not settled: the account never heard it, so the debt has to stand.
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('says when a choice is on the phone only', async () => {
    mockPushLevel.mockRejectedValue(new Error('offline'));
    render(<GoalsScreen />);
    await waitFor(() => expect(mockSuggested).toHaveBeenCalled());

    fireEvent.press(screen.getByTestId('target-activity-active'));

    // "Changed" and "changed on this phone only" are different outcomes. A
    // pill that simply moves reads as a successful save.
    expect(await screen.findByTestId('target-activity-unsynced')).toBeTruthy();
  });

  it('settles the debt and drops the notice once the account has it', async () => {
    render(<GoalsScreen />);
    await waitFor(() => expect(mockSuggested).toHaveBeenCalled());

    fireEvent.press(screen.getByTestId('target-activity-active'));

    await waitFor(() => expect(mockSettle).toHaveBeenCalledWith('u1', 'active'));
    await waitFor(() => expect(screen.queryByTestId('target-activity-unsynced')).toBeNull());
  });

  it('retries a push the account never heard, on the next focus', async () => {
    // **The offline half of the feature is this test.** Without the retry, the
    // only `setActivityLevel` call in the app is a pill press — so a choice
    // made in a gym dead-spot stays owed FOREVER unless the athlete happens to
    // tap the same pill again while online, and web goes on deriving at the
    // stale level indefinitely. The screen promises otherwise in as many words
    // ("It reaches your account next time you have signal").
    //
    // Review found this. The module doc described the retry and the on-screen
    // copy promised it; nothing implemented it, and every other test here
    // passed.
    mockRead.mockResolvedValue({ level: 'active', owed: true });
    render(<GoalsScreen />);

    await waitFor(() => expect(mockPushLevel).toHaveBeenCalledWith(expect.anything(), 'active'));
    await waitFor(() => expect(mockSettle).toHaveBeenCalledWith('u1', 'active'));
    // And it stops claiming to be unsent once it has landed.
    await waitFor(() => expect(screen.queryByTestId('target-activity-unsynced')).toBeNull());
  });

  it('leaves the debt standing when the retry cannot reach the server either', async () => {
    mockRead.mockResolvedValue({ level: 'active', owed: true });
    mockPushLevel.mockRejectedValue(new Error('still offline'));
    render(<GoalsScreen />);

    await waitFor(() => expect(mockPushLevel).toHaveBeenCalled());
    // Not settled — settling on a failed push marks the change as sent and it
    // never goes out again, which is worse than never having retried.
    expect(mockSettle).not.toHaveBeenCalled();
    expect(await screen.findByTestId('target-activity-unsynced')).toBeTruthy();
  });

  it('does not retry when there is nothing owed', async () => {
    mockRead.mockResolvedValue({ level: 'active', owed: false });
    render(<GoalsScreen />);

    await waitFor(() => expect(mockSuggested).toHaveBeenCalled());
    // A PATCH on every focus would write the athlete's own value back to the
    // account forever, for nothing.
    expect(mockPushLevel).not.toHaveBeenCalled();
  });

  it('does not let a slow cache read revert a pill pressed while it was in flight', async () => {
    let release: (v: { level: 'light'; owed: boolean }) => void = () => {};
    mockRead
      .mockResolvedValueOnce({ level: 'light', owed: false })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
    render(<GoalsScreen />);
    await waitFor(() => expect(mockSuggested).toHaveBeenCalled());

    // A second focus starts a read; the athlete taps before it resolves.
    refocus();
    await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(2));
    fireEvent.press(screen.getByTestId('target-activity-active'));
    await waitFor(() => expect(selectedState('target-activity-active')).toBe(true));

    // The read now resolves with its PRE-TAP snapshot. Applying it would put
    // the pill back to `light` under the athlete's thumb and unpin the query.
    await act(async () => {
      release({ level: 'light', owed: false });
    });
    expect(selectedState('target-activity-active')).toBe(true);
  });

  it('does not re-derive when the push succeeds', async () => {
    // A successful push must not change the request. Driving the query
    // parameter off the sync flag instead of a separate pin does exactly that:
    // the parameter disappears the instant the push lands, and the whole
    // ladder is fetched a second time for an answer that cannot have moved.
    render(<GoalsScreen />);
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(1));

    fireEvent.press(screen.getByTestId('target-activity-active'));

    await waitFor(() => expect(mockSettle).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('target-activity-unsynced')).toBeNull());
    expect(mockSuggested).toHaveBeenCalledTimes(2);
  });
});

describe('an assumed level is not shown as a chosen one', () => {
  it('selects no pill when the athlete has never chosen', async () => {
    render(<GoalsScreen />);
    await waitFor(() => expect(mockSuggested).toHaveBeenCalled());

    // `activity_chosen: false` is in the contract precisely so a client can
    // tell an assumption from a decision. A filled pill attributes a choice to
    // somebody who never made one - and the next request would then send it as
    // truth, making the assumption permanent and invisible.
    for (const key of ['sedentary', 'light', 'active']) {
      expect(selectedState(`target-activity-${key}`)).toBe(false);
    }
  });

  it('names the level it assumed rather than leaving it to be guessed', async () => {
    render(<GoalsScreen />);
    // The pills show no selection, so without this the screen says nothing at
    // all about which of the three the number was worked out at.
    const note = await screen.findByTestId('target-activity-assumed');
    expect(note).toHaveTextContent(/On your feet/);
  });

  it('stops saying it assumed once a level is chosen', async () => {
    mockRead.mockResolvedValue({ level: 'sedentary', owed: false });
    mockSuggested.mockResolvedValue({
      ...suggestion(2400),
      activity: 'sedentary',
      activity_chosen: true,
    } as never);
    render(<GoalsScreen />);

    await waitFor(() => expect(mockSuggested).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('target-activity-assumed')).toBeNull());
  });

  it('names whichever level the SERVER says it used, not the client default', async () => {
    // Read off the response rather than a local constant, so the pills and the
    // arithmetic cannot describe different things - which is the reported bug
    // in its purest form. Pinned to a literal label, not to ACTIVITY_DEFAULT:
    // a constant asserted against itself survives the constant moving.
    mockSuggested.mockResolvedValue({
      ...suggestion(2400),
      activity: 'sedentary',
      activity_chosen: false,
    } as never);
    render(<GoalsScreen />);

    const note = await screen.findByTestId('target-activity-assumed');
    expect(note).toHaveTextContent(/Desk job/);
  });
});
