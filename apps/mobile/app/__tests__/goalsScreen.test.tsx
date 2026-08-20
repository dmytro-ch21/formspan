import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import GoalsScreen from '../(tabs)/goals';
import { ApiError } from '@/lib/apiError';
import { fetchAdjustment, listTargets, saveTarget, suggestedTarget } from '@/lib/nutritionApi';

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
  } as unknown as Awaited<ReturnType<typeof suggestedTarget>>;
}

beforeEach(() => {
  jest.clearAllMocks();
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

async function openManualForm() {
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
