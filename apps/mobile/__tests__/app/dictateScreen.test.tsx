import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import DictateReflectionScreen from '../../app/bjj/dictate';
import { ApiError } from '@/lib/apiError';
import { draftReflection, type Draft, type DraftResponse } from '@/lib/reflectApi';
import { saveLocalBjjDetail } from '@/lib/sessionStore';
import { fetchTechniques, type TechniqueSummary } from '@/lib/techniques';

/**
 * The dictation screen's one rule: **never guess for the athlete** (N60).
 *
 * The server validates every technique id against the 542-row catalog and hands
 * back the phrases that pick out more than one entry, deliberately declining to
 * choose. The entire value of that is lost if the screen picks the top match —
 * the guess arrives pre-ticked, plausible, and one tap from permanent. That is
 * the failure N44 was built to avoid and N47 was filed to fix, and it is the
 * kind of thing that cannot be caught by a typechecker or by reading the diff,
 * because auto-selecting looks like helpfulness.
 *
 * These are component tests rather than pure ones on purpose, against this
 * suite's general preference: the property is about what reaches
 * `saveLocalBjjDetail` after a real interaction, and a pure test of the
 * transform cannot see a screen that adds a tag in a `useEffect`.
 *
 * N120/#509 added a second rule this file has to pin: Save must land on the
 * session's own read view, never back in the reflection wizard — the exact
 * hand-off this ticket reverses. `mockReplace` below is what makes that an
 * assertion rather than a hope; the default `expo-router` mock in
 * `jest.setup.js` hands back a fresh `jest.fn()` on every `useRouter()` call,
 * which is unobservable by design.
 */

jest.setTimeout(30_000);

const mockReplace = jest.fn();

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    // `KeyboardAwareScrollView` calls this too — see the identical note in
    // `bjjReflectScreen.test.tsx`.
    useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]),
    useLocalSearchParams: () => ({}),
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: mockReplace }),
    Stack: { Screen: () => null },
  };
});

const deferred = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 0));

const baseDraft: Draft = {
  kind: 'rolling',
  gi: true,
  rounds: 5,
  round_minutes: 5,
  session_rpe: 8,
  note: '',
  body_note: '',
  tags: [],
  unresolved: [],
  notices: [],
  empty: false,
  model: 'test-model',
};

let mockResponse: DraftResponse = {
  draft: baseDraft,
  quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
};

jest.mock('@/lib/reflectApi', () => ({
  ...jest.requireActual('@/lib/reflectApi'),
  draftReflection: jest.fn(() => deferred(mockResponse)),
}));

jest.mock('@/lib/sessionStore', () => ({
  startLocalSession: jest.fn(async () => ({ id: 'new-session' })),
  saveLocalBjjDetail: jest.fn(async () => {}),
}));

jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

// The catalog the picker offers. "Armbar" is genuinely ambiguous across these,
// which is the whole reason the server refuses to choose. "Knee cut" is
// unambiguous — used by the N120/#509 "add a technique" tests, which need a
// search that resolves to exactly one result rather than a picker.
jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: jest.fn(() =>
    deferred([
      { id: 'armbar-from-guard', name: 'Armbar from Guard', aliases: ['armbar'], category: 'Submission', position: 'Closed Guard - Bottom', position_detail: '', gi_no_gi: 'Both' },
      { id: 'armbar-from-mount', name: 'Armbar from Mount', aliases: ['armbar'], category: 'Submission', position: 'Mount - Top', position_detail: '', gi_no_gi: 'Both' },
      { id: 'knee-cut-pass', name: 'Knee Cut Pass', aliases: ['knee cut'], category: 'Pass', position: 'Half Guard - Top', position_detail: '', gi_no_gi: 'Both' },
    ]),
  ),
}));

/** Dictate a sentence and get the draft back. */
async function speak(text = 'Five rounds, caught an armbar') {
  render(<DictateReflectionScreen />);
  fireEvent.changeText(screen.getByLabelText('What happened in the session'), text);
  fireEvent.press(screen.getByLabelText('Read what I said'));
}

jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});

beforeEach(() => {
  jest.clearAllMocks();
  mockReplace.mockClear();
  mockResponse = {
    draft: baseDraft,
    quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
  };
});

it('offers a choice for an unresolved phrase and adds NO tag for it', async () => {
  mockResponse = {
    draft: {
      ...baseDraft,
      tags: [],
      unresolved: [{ phrase: 'armbar', category: 'submission', event: 'scored' }],
    },
    quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
  };

  await speak();

  // The prompt appears, offering more than one — because narrowing to one IS
  // the guess.
  //
  // All three inside the `waitFor`, deliberately. The draft and the technique
  // library arrive on two independent timers, and asserting the options
  // synchronously after waiting only for the PROMPT passes when those two
  // happen to flush together and fails when anything adds a render between
  // them. It did: N118 added one state update to this screen and turned this
  // into a red test about a picker it never touched.
  await waitFor(() => {
    expect(screen.getByText(/which one\?/i)).toBeTruthy();
    expect(screen.getByText('Armbar from Guard')).toBeTruthy();
    expect(screen.getByText('Armbar from Mount')).toBeTruthy();
  });

  // And saving without answering writes no technique at all. This is the
  // assertion the whole file exists for: an auto-selected top match would
  // still render a plausible screen and still save — silently, and wrongly.
  fireEvent.press(screen.getByLabelText('Save this session'));
  await waitFor(() => {
    expect(saveLocalBjjDetail).toHaveBeenCalled();
  });
  const detail = (saveLocalBjjDetail as jest.Mock).mock.calls[0][2];
  expect(detail.tags).toEqual([]);
});

/**
 * N119/#508: "when some techniques are logged and not found in library it is
 * not creating a new item, but it should."
 *
 * Before this existed, "Skip this one" was the ONLY way an unresolved phrase
 * left the screen short of a real match — and it discarded the phrase with
 * no trace. These pin the third path: the phrase itself must survive into
 * the saved session, distinguishably from a matched tag, and it must never
 * touch the shared technique catalog (a mangled dictation must never become
 * a permanent, shared entry — the "pool guards" guarantee).
 */
describe('a technique the library does not know', () => {
  it('is kept, not dropped, when the athlete says to keep it as said', async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [],
        unresolved: [{ phrase: 'pool guards', category: 'sweep', event: 'scored' }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };

    await speak('swept twice from pool guards');
    await waitFor(() => {
      expect(screen.getByLabelText('Keep “pool guards” as said, not matched to the library')).toBeTruthy();
    });
    fireEvent.press(screen.getByLabelText('Keep “pool guards” as said, not matched to the library'));

    // The unresolved prompt is gone — it has been answered, the same as a
    // real pick would have closed it.
    expect(screen.queryByText(/which one\?/i)).toBeNull();

    // And it renders in "What happened", distinguishably from a matched tag:
    // the phrase itself, quoted, plus the "not matched" hint. This is the
    // "athlete can see it was not recognised" half of the acceptance
    // criteria.
    expect(screen.getByText('“pool guards”')).toBeTruthy();
    expect(screen.getByText('Not matched to the library')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Save this session'));
    await waitFor(() => {
      expect(saveLocalBjjDetail).toHaveBeenCalled();
    });
    const detail = (saveLocalBjjDetail as jest.Mock).mock.calls[0][2];
    expect(detail.tags).toHaveLength(1);
    // Never a technique id — that is the whole guarantee. Nothing on this
    // path ever writes to the technique catalog; the phrase lives on the
    // SESSION's own tag, never anywhere a mangled "pool guards" could
    // become a permanent, shared library entry.
    expect(detail.tags[0].technique_id).toBeFalsy();
    expect(detail.tags[0].label).toBe('pool guards');
    expect(detail.tags[0].category).toBe('sweep');
    expect(detail.tags[0].event).toBe('scored');
  });

  it('lets the athlete resolve a kept phrase to a real technique before saving', async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [],
        unresolved: [{ phrase: 'armbar', category: 'submission', event: 'scored' }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };

    await speak();
    await waitFor(() => {
      expect(screen.getByLabelText('Keep “armbar” as said, not matched to the library')).toBeTruthy();
    });
    fireEvent.press(screen.getByLabelText('Keep “armbar” as said, not matched to the library'));

    // Correcting it is not a one-way door: the same screen that offered
    // "Keep as said" lets the athlete change their mind and match it after
    // all, without having to redo the dictation.
    fireEvent.press(screen.getByLabelText('Match “armbar” to a technique'));
    await waitFor(() => {
      expect(screen.getByText('Armbar from Mount')).toBeTruthy();
    });
    fireEvent.press(screen.getByText('Armbar from Mount'));

    fireEvent.press(screen.getByLabelText('Save this session'));
    await waitFor(() => {
      expect(saveLocalBjjDetail).toHaveBeenCalled();
    });
    const detail = (saveLocalBjjDetail as jest.Mock).mock.calls[0][2];
    expect(detail.tags).toHaveLength(1);
    expect(detail.tags[0].technique_id).toBe('armbar-from-mount');
    // The label is cleared once resolved — a resolved tag carrying a stale
    // phrase is exactly the confusion this field exists to prevent.
    expect(detail.tags[0].label).toBeFalsy();
  });

  /**
   * Regression for the race a reviewer caught: the catalog-fetch effect used
   * to be gated on `unresolved.length`, so keeping the LAST unresolved
   * phrase while the fetch was still in flight cancelled it — and nothing
   * ever retried, because the guard now read "nothing needs it" even though
   * a labelled tag's own "Match in library" control still did. `catalog`
   * would then stay `null` forever and this control would spin with no way
   * out. The fix widens the gate to "does anything on screen still need the
   * catalog", which includes a kept-but-unmatched tag.
   */
  it('still loads the catalog for "Match in library" when the last phrase is kept before the fetch resolves', async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [],
        unresolved: [{ phrase: 'pool guards', category: 'sweep', event: 'scored' }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };

    // Controlled by hand rather than the shared `deferred` helper's fixed
    // timer — the race depends on the fetch still being unresolved at the
    // exact moment "Keep as said" is pressed.
    let resolveCatalog!: (list: TechniqueSummary[]) => void;
    (fetchTechniques as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<TechniqueSummary[]>((resolve) => {
          resolveCatalog = resolve;
        }),
    );

    await speak('swept twice from pool guards');
    await waitFor(() => {
      expect(
        screen.getByLabelText('Keep “pool guards” as said, not matched to the library'),
      ).toBeTruthy();
    });

    // This is the last unresolved phrase, so `unresolved.length` drops to 0
    // right here — the moment that used to cancel the in-flight fetch.
    fireEvent.press(screen.getByLabelText('Keep “pool guards” as said, not matched to the library'));

    // Only now does the fetch resolve. Under the bug, nothing would still be
    // listening for it.
    resolveCatalog([
      {
        id: 'pull-guard',
        name: 'Pull Guard',
        aliases: ['pool guards'],
        category: 'Sweep',
        position: 'Standing',
        position_detail: '',
        gi_no_gi: 'Both',
        typical_belt: '',
        ibjjf_ruleset_id: '',
        setup_from: [],
      },
    ]);

    fireEvent.press(screen.getByLabelText('Match “pool guards” to a technique'));
    await waitFor(() => {
      expect(screen.getByText('Pull Guard')).toBeTruthy();
    });
  });
});

it('adds the technique the athlete picked, and only that one', async () => {
  mockResponse = {
    draft: {
      ...baseDraft,
      tags: [],
      unresolved: [{ phrase: 'armbar', category: 'submission', event: 'scored' }],
    },
    quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
  };

  await speak();
  await waitFor(() => {
    expect(screen.getByText('Armbar from Mount')).toBeTruthy();
  });
  fireEvent.press(screen.getByText('Armbar from Mount'));

  fireEvent.press(screen.getByLabelText('Save this session'));
  await waitFor(() => {
    expect(saveLocalBjjDetail).toHaveBeenCalled();
  });
  const detail = (saveLocalBjjDetail as jest.Mock).mock.calls[0][2];
  expect(detail.tags).toHaveLength(1);
  expect(detail.tags[0].technique_id).toBe('armbar-from-mount');
  // The category and event come from what the athlete SAID, not from the
  // technique they picked — they told us it was a submission they scored.
  expect(detail.tags[0].category).toBe('submission');
  expect(detail.tags[0].event).toBe('scored');
});

it('says nothing was picked up rather than showing an empty confirm screen', async () => {
  mockResponse = {
    draft: { ...baseDraft, tags: [], rounds: null, round_minutes: null, session_rpe: null, gi: null, kind: '', empty: true },
    quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
  };

  await speak('remind me to buy a mouthguard');

  await waitFor(() => {
    expect(screen.getByTestId('dictate-empty')).toBeTruthy();
  });
  // An empty draft must not offer a Save — a confirm screen with nothing on it
  // reads as a successful reading and gets confirmed without being read.
  expect(screen.queryByLabelText('Save this session')).toBeNull();
});

it('shows what the server changed, in words rather than reason codes', async () => {
  mockResponse = {
    draft: {
      ...baseDraft,
      rounds: null,
      notices: [{ field: 'rounds', was: '6', reason: 'not_spoken' }],
    },
    quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
  };

  await speak();

  await waitFor(() => {
    expect(screen.getByTestId('dictate-notices')).toBeTruthy();
  });
  // The number the model invented is named, so the athlete knows what was
  // dropped and why the field is blank.
  expect(screen.getByText(/6/)).toBeTruthy();
  expect(screen.queryByText(/not_spoken/)).toBeNull();
});

/**
 * N121/#510: "I mention the submissions I completed, takedowns, sweeps — but
 * they never get counted in the log."
 *
 * Two different tags below: one whose count the server floored to 1 (never
 * confirmed — must read as blank, not as a normal "1"), and one the athlete
 * genuinely said was "one" (a real 1 — must read as an ordinary count).
 * Collapsing those two into the same stepper display is the bug the ticket
 * describes: a spoken count that silently reads exactly like "none said".
 */
describe('a tag count the server could not verify', () => {
  it('reads as blank rather than as a confident 1, distinct from a real 1', async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [
          { category: 'submission', event: 'scored', position: '', technique_id: null, count: 1 }, // floored — the athlete said "five"
          { category: 'sweep', event: 'scored', position: '', technique_id: null, count: 1 }, // genuinely said "one sweep"
        ],
        notices: [{ field: 'tags[0].count', was: '5', reason: 'not_spoken' }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };

    await speak('five submissions, one sweep');

    await waitFor(() => {
      expect(screen.getByText('scored submission')).toBeTruthy();
    });
    // The uncertain tag shows the blank glyph and says so beside it — not "1".
    expect(screen.getByLabelText('scored submission: how many? not set')).toBeTruthy();
    expect(screen.getByText(/we weren.t sure/i)).toBeTruthy();
    // The confirmed tag still reads as an ordinary, un-flagged "1".
    expect(screen.getByLabelText('1 scored sweep')).toBeTruthy();

    // And the notice text itself no longer claims the field is blank — it is
    // showing "1" on screen right now, so saying "blank" would contradict
    // what the athlete can see.
    expect(screen.getByTestId('dictate-notices')).toBeTruthy();
    expect(screen.queryByText(/is blank/i)).toBeNull();
  });

  it('stops reading as blank the moment the athlete sets a real number', async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [{ category: 'pass', event: 'scored', position: '', technique_id: null, count: 1 }],
        notices: [{ field: 'tags[0].count', was: '5', reason: 'not_spoken' }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };

    await speak('five passes');
    await waitFor(() => {
      expect(screen.getByLabelText('scored pass: how many? not set')).toBeTruthy();
    });

    // "+" on a blank count confirms at the hidden floor first — same reasoning
    // as "−": the underlying value is already 1, and jumping straight to 2
    // would silently double-count for an athlete who tapped once meaning "yes,
    // one". Matches the session-level `Stepper`'s own null-count semantics.
    fireEvent.press(screen.getByLabelText('Set scored pass to 1'));
    expect(screen.queryByLabelText('scored pass: how many? not set')).toBeNull();
    expect(screen.getByLabelText('1 scored pass')).toBeTruthy();

    // Now an ordinary, un-flagged stepper — a second "+" behaves normally.
    fireEvent.press(screen.getByLabelText('One more scored pass'));
    expect(screen.getByLabelText('2 scored pass')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Save this session'));
    await waitFor(() => {
      expect(saveLocalBjjDetail).toHaveBeenCalled();
    });
    expect((saveLocalBjjDetail as jest.Mock).mock.calls[0][2].tags[0].count).toBe(2);
  });

  it('confirms at the floor on "−" rather than deleting a tag nobody asked to remove', async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [{ category: 'takedown', event: 'scored', position: '', technique_id: null, count: 1 }],
        notices: [{ field: 'tags[0].count', was: '3', reason: 'not_spoken' }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };

    await speak('a few takedowns');
    await waitFor(() => {
      expect(screen.getByLabelText('Confirm scored takedown at 1')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText('Confirm scored takedown at 1'));

    // Confirmed at 1, not removed — a blind "−" on an uncertain count must not
    // read as "delete this", which would silently drop a real event.
    expect(screen.getByLabelText('1 scored takedown')).toBeTruthy();
  });

  /**
   * N121/#510 — the gap `ac-verifier` found in this ticket's first review
   * pass. Every other test in this `describe` block sets up the model
   * MISBEHAVING (inventing a number, or returning something malformed) and
   * getting caught by `not_spoken`/`count_below_one`. This one is the common,
   * well-behaved path: the model correctly reads "a couple of sweeps" as a
   * hedge and does exactly what the prompt asks — leaves `count` at 1, sets
   * nothing else wrong. Before `hedged_count` existed, that produced ZERO
   * notices (1 is an ordinary count) and this exact tag rendered as a
   * confident, un-flagged "1" — the ticket's "stays null and the confirm
   * screen asks" criterion silently unmet on the path that matters most.
   */
  it('asks about a hedge the model correctly declined to invent a number for', async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [{ category: 'sweep', event: 'scored', position: '', technique_id: null, count: 1 }],
        notices: [{ field: 'tags[0].count', was: '1', reason: 'hedged_count' }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };

    await speak('a couple of sweeps, hard to say exactly');

    await waitFor(() => {
      expect(screen.getByLabelText('scored sweep: how many? not set')).toBeTruthy();
    });
    // The stepper reads blank, same as any other uncertain count — this is
    // not a second UI, it is the same mechanism reached a new way.
    expect(screen.getByText(/how many\? we weren.t sure/i)).toBeTruthy();
    // The real message renders (not just "neither wrong message showed" —
    // that would also pass if `describeNotice` silently fell through to its
    // unknown-reason default), and it does not accuse the model of a
    // mistake — it made none; the athlete gave a range, not a number.
    expect(screen.getByTestId('dictate-notices')).toBeTruthy();
    expect(screen.getByText(/you said a range/i)).toBeTruthy();
    expect(screen.queryByText(/couldn.t match/i)).toBeNull();
    expect(screen.queryByText(/came back as/i)).toBeNull();
  });
});

it('lets a miscounted round be corrected before anything is saved', async () => {
  // N40's finding: this model class states a miscount flatly. "Rolled five"
  // coming back as six is the error that survives review, so correcting it has
  // to be a thumb-reachable step rather than a keyboard field.
  mockResponse = {
    draft: { ...baseDraft, rounds: 6 },
    quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
  };

  await speak('rolled five rounds');

  await waitFor(() => {
    expect(screen.getByLabelText('One fewer Rounds')).toBeTruthy();
  });
  fireEvent.press(screen.getByLabelText('One fewer Rounds'));

  fireEvent.press(screen.getByLabelText('Save this session'));
  await waitFor(() => {
    expect(saveLocalBjjDetail).toHaveBeenCalled();
  });
  expect((saveLocalBjjDetail as jest.Mock).mock.calls[0][2].rounds).toBe(5);
});

it('keeps the note field mounted when it is emptied', async () => {
  // It was gated on the LIVE value, so backspacing the note to empty unmounted
  // the input mid-edit — keyboard gone, section unreachable, text unrecoverable
  // on this screen. Gating on what the model extracted is what fixes it, and
  // this is the only thing that would catch the regression.
  mockResponse = {
    draft: { ...baseDraft, note: 'Felt sharp.' },
    quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
  };

  await speak();
  await waitFor(() => {
    expect(screen.getByLabelText('Session note')).toBeTruthy();
  });

  fireEvent.changeText(screen.getByLabelText('Session note'), '');
  // Still there, still editable.
  expect(screen.getByLabelText('Session note')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Session note'), 'Actually, felt flat.');

  fireEvent.press(screen.getByLabelText('Save this session'));
  await waitFor(() => {
    expect(saveLocalBjjDetail).toHaveBeenCalled();
  });
  expect((saveLocalBjjDetail as jest.Mock).mock.calls[0][2].note).toBe('Actually, felt flat.');
});

it('shows a body note rather than saving it sight-unseen', async () => {
  // The screen's premise is that everything it saves arrived editable. A body
  // note is exactly the kind of thing that must not be written unread.
  mockResponse = {
    draft: { ...baseDraft, body_note: 'Knee popped in round three.' },
    quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
  };

  await speak();
  await waitFor(() => {
    expect(screen.getByLabelText('Note about your body')).toBeTruthy();
  });
  expect(screen.getByDisplayValue('Knee popped in round three.')).toBeTruthy();
});

it('tells "nothing matched" apart from "could not load"', async () => {
  // One branch said "couldn't load the library" for three different states,
  // which was wrong in two of them — it flashed on every first load, and it was
  // permanently wrong when the library HAD loaded and the client's ranker
  // simply scored nothing. Sending someone to fix a connection that is fine is
  // worse than saying nothing.
  mockResponse = {
    draft: {
      ...baseDraft,
      unresolved: [{ phrase: 'the spinny thing', category: 'sweep', event: 'scored' }],
    },
    quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
  };

  await speak();

  await waitFor(() => {
    expect(screen.getByText(/which one\?/i)).toBeTruthy();
  });
  // The catalog loads fine and contains no match for this phrase.
  await waitFor(() => {
    expect(screen.getByText(/nothing in the library matches/i)).toBeTruthy();
  });
  expect(screen.queryByText(/couldn’t load the library/i)).toBeNull();
});

it('says how many are left even when the draft came back empty', async () => {
  // An empty draft still spends one. Inviting a retry without saying so sends
  // the athlete into a 429 they had no way to see coming.
  mockResponse = {
    draft: { ...baseDraft, tags: [], empty: true },
    quota: { used: 10, limit: 10, remaining: 0, resets_at: null },
  };

  await speak('remind me to buy a mouthguard');

  await waitFor(() => {
    expect(screen.getByTestId('dictate-empty')).toBeTruthy();
  });
  expect(screen.getByTestId('dictate-quota')).toBeTruthy();
  expect(screen.getByText(/last one for today/i)).toBeTruthy();
});

/**
 * What the athlete is left holding when it does not work (N118).
 *
 * The report: *"I first got an error that it's not articulated correctly and
 * then I just resent again."* Two things are wrong in that sentence and only
 * one of them is the wording — the other is that resending worked, so the app
 * could have done it.
 *
 * The retry itself is pinned in `lib/__tests__/dictateRetry.test.ts`, where the
 * quota consequence can be counted. What is here is what the SCREEN does with
 * the outcome, which no pure test can see.
 */
describe('when the draft fails', () => {
  const asMock = () => draftReflection as jest.Mock;

  it('keeps every word the athlete said', async () => {
    asMock().mockRejectedValueOnce(new ApiError('server prose', 'invalid_input', 422));

    const said = 'Hour of gi. Drilled the knee cut, then five rounds.';
    await speak(said);

    await waitFor(() => {
      expect(screen.getByText(/couldn’t turn that into a session/i)).toBeTruthy();
    });
    // Re-recording is not a recovery. The field still holds it, and the button
    // that sends it is still there.
    expect(screen.getByLabelText('What happened in the session').props.value).toBe(said);
    expect(screen.getByLabelText('Read what I said')).toBeTruthy();
  });

  it('does not tell the athlete they spoke badly, and does not echo the server', async () => {
    asMock().mockRejectedValueOnce(
      new ApiError('could not read that as a session — try saying what happened in plainer terms', 'invalid_input', 422),
    );

    await speak();

    await waitFor(() => {
      expect(screen.getByText(/couldn’t turn that into a session/i)).toBeTruthy();
    });
    // The exact accusation, gone — and gone because the screen writes its own
    // line, not because the server happens to word it differently today.
    expect(screen.queryByText(/plainer terms/i)).toBeNull();
    expect(screen.queryByText(/articulat/i)).toBeNull();
  });

  it('says it is still working while it retries, without showing an error', async () => {
    let release: (() => void) | null = null;
    asMock().mockImplementationOnce(async (_t: unknown, _d: string, opts: { onRetry?: (attempt: number) => void }) => {
      opts?.onRetry?.(1);
      await new Promise<void>((r) => {
        release = r;
      });
      return mockResponse;
    });

    await speak();

    await waitFor(() => {
      expect(screen.getByTestId('dictate-retrying')).toBeTruthy();
    });
    // A retry in flight is not a failure, so nothing red is on screen.
    expect(screen.queryByText(/couldn’t/i)).toBeNull();

    // And VoiceOver is told, in the SAME words the screen shows.
    //
    // `accessibilityLiveRegion` is Android-only — the pattern `sign-in.tsx`
    // and `forgot-password.tsx` already follow — so without the announcement a
    // screen-reader user gets no signal that the app is still working, which
    // is the entire reason this line exists. Raised in review, and it survived
    // the first mutation pass with nothing red.
    const spoken = (AccessibilityInfo.announceForAccessibility as jest.Mock).mock.calls.map((c) => c[0]);
    expect(spoken).toHaveLength(1);
    expect(screen.getByTestId('dictate-retrying')).toHaveTextContent(spoken[0]);

    // And it goes away when the retry lands, because the whole pre-draft block
    // it lives in does.
    release!();
    await waitFor(() => {
      expect(screen.getByLabelText('Save this session')).toBeTruthy();
    });
    expect(screen.queryByTestId('dictate-retrying')).toBeNull();
  });
});

/**
 * N120/#509: "once we do the verbal log … it should be enough. If we log by
 * audio this should fill everything and we should be done."
 *
 * The screen used to `router.replace` into the ordinary reflection wizard
 * after Save, so a dictated session had to be corrected a second time
 * through three tap-through steps. These pin the reversal: Save now lands on
 * the session's own read view, and this screen carries the two editing
 * surfaces the wizard offered that the old confirm screen did not —
 * correcting what a tag's event actually was, and adding a technique the
 * dictation never named at all — so nothing is lost by not handing off.
 */
describe('N120/#509: the confirm screen is the whole flow', () => {
  it('lands on the session read view after Save, never the reflection wizard', async () => {
    await speak();
    await waitFor(() => {
      expect(screen.getByLabelText('Save this session')).toBeTruthy();
    });
    fireEvent.press(screen.getByLabelText('Save this session'));

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalled();
    });
    const [dest] = mockReplace.mock.calls[0];
    expect(dest).toEqual({ pathname: '/bjj/session/[id]', params: { id: 'new-session' } });
    // The exact hand-off this ticket reverses, asserted as an explicit
    // negative rather than just "replace happened with something new".
    expect(dest.pathname).not.toBe('/bjj/reflect/[id]');
  });

  it('does not navigate while the draft is only on screen — draft-then-confirm is unchanged', async () => {
    await speak();
    await waitFor(() => {
      expect(screen.getByLabelText('Save this session')).toBeTruthy();
    });
    // Arriving at the confirm screen must not itself be a navigation event —
    // only an explicit Save tap is. This is the guard N120/#509 must not
    // weaken while shortening the flow.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('exposes a blank, editable note and body field even when dictation said nothing', async () => {
    // baseDraft's note/body_note are both '' — the old screen hid the whole
    // section on this input. Hidden reads as "there is nothing to say";
    // blank-with-a-placeholder reads as "we heard nothing", which is the
    // honest one and the one the ticket's blank-vs-invented rule requires.
    await speak();
    await waitFor(() => {
      expect(screen.getByLabelText('Session note')).toBeTruthy();
    });
    expect(screen.getByLabelText('Session note').props.value).toBe('');
    expect(screen.getByLabelText('Session note').props.placeholder).toMatch(/nothing said/i);
    expect(screen.getByLabelText('Note about your body')).toBeTruthy();
    expect(screen.getByLabelText('Note about your body').props.placeholder).toMatch(/nothing said/i);

    fireEvent.changeText(screen.getByLabelText('Session note'), 'Sharp today.');
    fireEvent.changeText(screen.getByLabelText('Note about your body'), 'Knee twinge.');
    fireEvent.press(screen.getByLabelText('Save this session'));

    await waitFor(() => {
      expect(saveLocalBjjDetail).toHaveBeenCalled();
    });
    const detail = (saveLocalBjjDetail as jest.Mock).mock.calls[0][2];
    expect(detail.note).toBe('Sharp today.');
    expect(detail.body_note).toBe('Knee twinge.');
  });

  it('lets the athlete add a technique the dictation never named at all', async () => {
    mockResponse = {
      draft: { ...baseDraft, tags: [] },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };
    await speak('Just rolled, nothing structured');

    await waitFor(() => {
      expect(screen.getByLabelText('Add a technique')).toBeTruthy();
    });
    fireEvent.changeText(screen.getByLabelText('Add a technique'), 'knee cut');
    await waitFor(() => {
      expect(screen.getByLabelText('Add Knee Cut Pass')).toBeTruthy();
    });
    fireEvent.press(screen.getByLabelText('Add Knee Cut Pass'));

    // Added as `drilled` — the wizard's own default for a technique picked by
    // search rather than named in an exchange.
    await waitFor(() => {
      expect(screen.getByText('drilled pass · Half Guard')).toBeTruthy();
    });

    fireEvent.press(screen.getByLabelText('Save this session'));
    await waitFor(() => {
      expect(saveLocalBjjDetail).toHaveBeenCalled();
    });
    const detail = (saveLocalBjjDetail as jest.Mock).mock.calls[0][2];
    expect(detail.tags).toHaveLength(1);
    expect(detail.tags[0]).toMatchObject({
      technique_id: 'knee-cut-pass',
      event: 'drilled',
      category: 'pass',
      count: 1,
    });
  });

  it('does not add the same technique twice as drilled', async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [{ category: 'pass', event: 'drilled', position: 'Half Guard', technique_id: 'knee-cut-pass', count: 1 }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };
    await speak('Drilled knee cut, then rolled');

    await waitFor(() => {
      expect(screen.getByLabelText('Add a technique')).toBeTruthy();
    });
    fireEvent.changeText(screen.getByLabelText('Add a technique'), 'knee cut');
    await waitFor(() => {
      expect(screen.getByLabelText('Knee Cut Pass, already added')).toBeTruthy();
    });
    fireEvent.press(screen.getByLabelText('Knee Cut Pass, already added'));

    fireEvent.press(screen.getByLabelText('Save this session'));
    await waitFor(() => {
      expect(saveLocalBjjDetail).toHaveBeenCalled();
    });
    // Still one — the press on an already-added result did nothing.
    expect((saveLocalBjjDetail as jest.Mock).mock.calls[0][2].tags).toHaveLength(1);
  });

  it("lets the athlete correct what a tag's event actually was", async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [{ category: 'submission', event: 'scored', position: '', technique_id: null, count: 1 }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };
    await speak('Landed an armbar');

    await waitFor(() => {
      expect(screen.getByText('scored submission')).toBeTruthy();
    });
    // The model read this as scored; the athlete corrects it to conceded —
    // same tag, same count, a different outcome.
    fireEvent.press(screen.getByTestId('dictate-tag-0-event-conceded'));

    fireEvent.press(screen.getByLabelText('Save this session'));
    await waitFor(() => {
      expect(saveLocalBjjDetail).toHaveBeenCalled();
    });
    const detail = (saveLocalBjjDetail as jest.Mock).mock.calls[0][2];
    expect(detail.tags).toHaveLength(1);
    expect(detail.tags[0].event).toBe('conceded');
    expect(detail.tags[0].count).toBe(1);
  });

  it("lets the athlete correct where a tag happened", async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [{ category: 'submission', event: 'scored', position: '', technique_id: 'armbar-from-guard', count: 1 }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };
    await speak('Landed an armbar');

    await waitFor(() => {
      expect(screen.getByText('scored submission')).toBeTruthy();
    });
    // The dictation named the technique but not where it happened — the
    // athlete fills that in without re-entering anything already correct.
    fireEvent.press(screen.getByTestId('dictate-tag-0-position-Guard'));

    fireEvent.press(screen.getByLabelText('Save this session'));
    await waitFor(() => {
      expect(saveLocalBjjDetail).toHaveBeenCalled();
    });
    const detail = (saveLocalBjjDetail as jest.Mock).mock.calls[0][2];
    expect(detail.tags[0].position).toBe('Guard');
    // Correcting position leaves everything else on the tag untouched.
    expect(detail.tags[0].event).toBe('scored');
    expect(detail.tags[0].count).toBe(1);
  });

  it('restricts an untagged tag to Scored/Conceded and flags one the dictation already stranded outside that pair', async () => {
    // No `technique_id` — a category-level read the model made without
    // naming a specific technique, and with an event the app has no display
    // surface for on `session/[id].tsx` (see `TagRow`'s own comment). This is
    // the shape the model can hand back even though nothing on this screen
    // would ever construct one by hand.
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [{ category: 'pass', event: 'drilled', position: '', technique_id: null, count: 1 }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };
    await speak('Worked on some passing');

    await waitFor(() => {
      expect(screen.getByText('drilled pass')).toBeTruthy();
    });
    // The honest flag, not a silent restriction.
    expect(screen.getByText(/no technique named/i)).toBeTruthy();
    // Only the two events the read view can actually show for a tag with no
    // technique — matching what the wizard's own category grid ever writes.
    expect(screen.getByTestId('dictate-tag-0-event-scored')).toBeTruthy();
    expect(screen.getByTestId('dictate-tag-0-event-conceded')).toBeTruthy();
    expect(screen.queryByTestId('dictate-tag-0-event-drilled')).toBeNull();
    expect(screen.queryByTestId('dictate-tag-0-event-attempted')).toBeNull();
    expect(screen.queryByTestId('dictate-tag-0-event-defended')).toBeNull();

    // Reclassifying it into one of the two clears the flag and makes it a
    // tag the read view can display.
    fireEvent.press(screen.getByTestId('dictate-tag-0-event-scored'));
    expect(screen.queryByText(/no technique named/i)).toBeNull();

    fireEvent.press(screen.getByLabelText('Save this session'));
    await waitFor(() => {
      expect(saveLocalBjjDetail).toHaveBeenCalled();
    });
    const detail = (saveLocalBjjDetail as jest.Mock).mock.calls[0][2];
    expect(detail.tags[0].event).toBe('scored');
  });

  it('leaves all five event choices open for a tag that DOES name a technique', async () => {
    // The restriction is specific to `technique_id: null` — a named
    // technique still supports the full funnel via `techniqueRows`, so
    // narrowing its choices too would take away a legitimate correction.
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [{ category: 'pass', event: 'drilled', position: '', technique_id: 'knee-cut-pass', count: 1 }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };
    await speak('Drilled the knee cut');

    await waitFor(() => {
      expect(screen.getByText('drilled pass')).toBeTruthy();
    });
    for (const key of ['drilled', 'attempted', 'scored', 'conceded', 'defended']) {
      expect(screen.getByTestId(`dictate-tag-0-event-${key}`)).toBeTruthy();
    }
    expect(screen.queryByText(/no technique named/i)).toBeNull();
  });

  /**
   * N119/#508 × N120/#509, reconciled at rebase: a tag kept as unmatched
   * also carries `technique_id: null`, the same shape the restriction above
   * exists to narrow — but it is NOT the same case. `session/[id].tsx` gives
   * every labelled tag its own display surface ("Said, not matched to the
   * library") regardless of `event`, so the read-view gap the restriction
   * guards against never applies to it. If this test ever fails because the
   * restriction widened to catch labelled tags too, that is a regression,
   * not a fix — see `TagRow`'s `untaggedLimited` comment.
   */
  it('leaves all five event choices open for a tag kept as unmatched, unlike a plain untagged one', async () => {
    mockResponse = {
      draft: {
        ...baseDraft,
        tags: [],
        // `drilled` specifically — the one event a plain untagged tag can
        // never carry into "What happened live" or "Techniques", so this
        // pins that a labelled tag is not held to that same restriction.
        unresolved: [{ phrase: 'pool guards', category: 'sweep', event: 'drilled' }],
      },
      quota: { used: 1, limit: 10, remaining: 9, resets_at: null },
    };
    await speak('drilled from pool guards');

    await waitFor(() => {
      expect(screen.getByLabelText('Keep “pool guards” as said, not matched to the library')).toBeTruthy();
    });
    fireEvent.press(screen.getByLabelText('Keep “pool guards” as said, not matched to the library'));

    await waitFor(() => {
      expect(screen.getByText('“pool guards”')).toBeTruthy();
    });
    for (const key of ['drilled', 'attempted', 'scored', 'conceded', 'defended']) {
      expect(screen.getByTestId(`dictate-tag-0-event-${key}`)).toBeTruthy();
    }
    // No "stranded" flag either — a labelled tag is never stranded by event.
    expect(screen.queryByText(/no technique named/i)).toBeNull();
  });
});
