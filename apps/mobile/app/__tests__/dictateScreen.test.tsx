import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import DictateReflectionScreen from '../bjj/dictate';
import type { Draft, DraftResponse } from '@/lib/reflectApi';
import { saveLocalBjjDetail } from '@/lib/sessionStore';

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
 */

jest.setTimeout(30_000);

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
// which is the whole reason the server refuses to choose.
jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: jest.fn(() =>
    deferred([
      { id: 'armbar-from-guard', name: 'Armbar from Guard', aliases: ['armbar'], category: 'Submission', position: 'Closed Guard - Bottom', position_detail: '', gi_no_gi: 'Both' },
      { id: 'armbar-from-mount', name: 'Armbar from Mount', aliases: ['armbar'], category: 'Submission', position: 'Mount - Top', position_detail: '', gi_no_gi: 'Both' },
    ]),
  ),
}));

/** Dictate a sentence and get the draft back. */
async function speak(text = 'Five rounds, caught an armbar') {
  render(<DictateReflectionScreen />);
  fireEvent.changeText(screen.getByLabelText('What happened in the session'), text);
  fireEvent.press(screen.getByLabelText('Read what I said'));
}

beforeEach(() => {
  jest.clearAllMocks();
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

  // The prompt appears...
  await waitFor(() => {
    expect(screen.getByText(/which one\?/i)).toBeTruthy();
  });
  // ...offering more than one, because narrowing to one IS the guess.
  expect(screen.getByText('Armbar from Guard')).toBeTruthy();
  expect(screen.getByText('Armbar from Mount')).toBeTruthy();

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
