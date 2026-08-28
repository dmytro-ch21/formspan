import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import ReflectScreen from '../../app/bjj/reflect/[id]';
import type { SessionDetail } from '@/lib/bjjSession';
import { readLocalBjjDetail, saveLocalBjjDetail } from '@/lib/sessionStore';

/**
 * N185 (#590) — the reflection wizard's visual pass, and the two things a
 * restyle must not have quietly broken.
 *
 * 1. **Leaving early loses nothing.** The session is already saved before
 *    this screen ever opens (`app/bjj/log.tsx` commits it); this screen must
 *    never turn "I'm done" into "I lost what I typed". That has to be an
 *    actual assertion against the persisted write, not an assumption that
 *    logic nobody touched still behaves the same under new JSX around it —
 *    the ticket's own acceptance criteria say so explicitly.
 * 2. **A learning-state badge only ever reads real evidence.** N185 adds
 *    "Reliable" as a state a technique can display; this pins that a
 *    technique the funnel already shows landed three times actually renders
 *    that word, so the badge is reachable rather than dead code with no path
 *    to it (a "state that cannot be constructed" is this repo's own recorded
 *    trap for exactly this kind of addition).
 */

jest.setTimeout(30_000);

const mockDetail: SessionDetail = {
  kind: 'class',
  gi: true,
  rounds: 5,
  round_minutes: 5,
  session_rpe: 7,
  academy: '',
  note: '',
  body_note: '',
  tags: [],
};

const deferred = <T,>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), 0));

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return {
    // `KeyboardAwareScroll` calls this too — omitting it here (rather than
    // relying on jest.setup.js's default, which this file's own
    // `jest.mock('expo-router', ...)` entirely replaces) is what took the
    // whole screen down with "useFocusEffect is not a function" the first
    // time this test was written.
    useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]),
    useLocalSearchParams: () => ({ id: 's1' }),
    useRouter: () => ({ push: jest.fn(), back: mockBack, replace: jest.fn() }),
    // The REAL `Stack.Screen` renders nothing into this tree — it hands
    // `options` to React Navigation, which draws the header elsewhere, so
    // RNTL cannot normally reach a `headerRight` button (see the note on
    // this in `profileHeightUnits.test.tsx`). "Done" lives ONLY there, so
    // this mock renders `headerRight()` directly rather than discarding it.
    Stack: {
      Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) =>
        options?.headerRight ? options.headerRight() : null,
    },
    // `RoadmapLine` renders one of these around itself. Not exercised by the
    // fixtures in THIS file (`listWorkingCurricula` resolves `[]` below), but
    // its absence would crash any future test that mocks a non-empty roadmap
    // list — a test-setup gap that would read as a screen bug.
    Link: ({ children }: { children: React.ReactNode }) => React.createElement(Text, null, children),
  };
});

const mockBack = jest.fn();

jest.mock('@/lib/sessionStore', () => ({
  readLocalBjjDetail: jest.fn(() => deferred(mockDetail)),
  saveLocalBjjDetail: jest.fn(async () => {}),
}));

jest.mock('@/lib/sync', () => ({ request: jest.fn() }));

jest.mock('@/lib/bjjFocus', () => ({
  ...jest.requireActual('@/lib/bjjFocus'),
  fetchFocus: jest.fn(async () => []),
}));

jest.mock('@/lib/curriculum', () => ({
  ...jest.requireActual('@/lib/curriculum'),
  listWorkingCurricula: jest.fn(async () => []),
}));

jest.mock('@/lib/sequences', () => ({
  ...jest.requireActual('@/lib/sequences'),
  listSequences: jest.fn(async () => []),
  pendingSequences: jest.fn(async () => []),
  getSequence: jest.fn(async () => null),
  captureSequence: jest.fn(async () => 'seq1'),
}));

const RELIABLE_TECHNIQUE = {
  id: 'armbar-closed-guard',
  name: 'Armbar from Closed Guard',
  aliases: [],
  category: 'Submission',
  position: 'Guard - Bottom',
  position_detail: '',
  gi_no_gi: 'Both',
  typical_belt: '',
  ibjjf_ruleset_id: '',
  setup_from: [],
};

jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: jest.fn(async () => [RELIABLE_TECHNIQUE]),
}));

jest.mock('@/lib/proficiency', () => ({
  ...jest.requireActual('@/lib/proficiency'),
  fetchProficiency: jest.fn(async () => [
    {
      technique_id: 'armbar-closed-guard',
      name: 'Armbar from Closed Guard',
      position: 'Guard - Bottom',
      category: 'Submission',
      drilled: 12,
      attempted: 1,
      scored: 3,
      conceded: 0,
      sessions: 6,
      last_seen: '2026-08-01T00:00:00Z',
    },
  ]),
}));

afterEach(() => {
  mockBack.mockClear();
  (saveLocalBjjDetail as jest.Mock).mockClear();
});

it('saves nothing new and still navigates back when Done is pressed with no edits', async () => {
  render(<ReflectScreen />);

  await waitFor(() => {
    expect(screen.getByTestId('bjj-reflect-screen')).toBeTruthy();
  });

  fireEvent.press(screen.getByTestId('bjj-reflect-done'));

  // The whole point: pressing Done with nothing changed must not write a
  // blank reflection over the one `app/bjj/log.tsx` already saved, and it
  // must actually leave the screen.
  expect(saveLocalBjjDetail).not.toHaveBeenCalled();
  expect(mockBack).toHaveBeenCalled();
});

it('flushes an in-flight note before Done can lose it', async () => {
  render(<ReflectScreen />);

  await waitFor(() => {
    expect(screen.getByTestId('bjj-reflect-screen')).toBeTruthy();
  });

  // Step 0 (drilled) -> step 1 (live) -> step 2 (note).
  fireEvent.press(screen.getByTestId('bjj-reflect-next'));
  fireEvent.press(screen.getByTestId('bjj-reflect-next'));

  await waitFor(() => {
    expect(screen.getByTestId('bjj-note')).toBeTruthy();
  });

  fireEvent.changeText(
    screen.getByTestId('bjj-note'),
    'His grip broke my posture before I could frame',
  );

  // Pressed immediately — well inside the 700ms debounce. `saveLocalBjjDetail`
  // is invoked SYNCHRONOUSLY the moment `finish()` flushes `pending.current`
  // (the mock records the call before its own promise resolves), so this
  // deliberately does NOT use `waitFor`: an earlier version of this test used
  // `waitFor` here and passed for the wrong reason — the untouched 700ms
  // `setTimeout` still landed the write in real wall-clock time well inside
  // `waitFor`'s retry window, regardless of whether Done itself flushed
  // anything. Asserting immediately, before any timer could possibly have
  // fired, is what actually pins "Done flushes now" rather than "the debounce
  // eventually happens".
  fireEvent.press(screen.getByTestId('bjj-reflect-done'));

  expect(saveLocalBjjDetail).toHaveBeenCalledWith(
    'u1',
    's1',
    expect.objectContaining({ note: 'His grip broke my posture before I could frame' }),
  );
  expect(mockBack).toHaveBeenCalled();
});

it('shows Reliable on a technique the funnel already has three live hits for', async () => {
  render(<ReflectScreen />);

  await waitFor(() => {
    expect(screen.getByTestId('bjj-reflect-screen')).toBeTruthy();
  });

  fireEvent.changeText(screen.getByTestId('bjj-drilled-search'), 'armbar');

  await waitFor(() => {
    expect(screen.getByTestId('bjj-drilled-add-armbar-closed-guard-state')).toBeTruthy();
  });
  expect(screen.getByTestId('bjj-drilled-add-armbar-closed-guard-state')).toHaveTextContent(
    'Reliable',
  );

  // Adding it must not regress the badge — the "drilled today" row reads the
  // SAME state (the funnel already dominates the local floor here).
  fireEvent.press(screen.getByTestId('bjj-drilled-add-armbar-closed-guard'));

  await waitFor(() => {
    expect(screen.getByTestId('bjj-drilled-chip-armbar-closed-guard-state')).toBeTruthy();
  });
  expect(screen.getByTestId('bjj-drilled-chip-armbar-closed-guard-state')).toHaveTextContent(
    'Reliable',
  );
});

it('shows no learning-state badge on a drilled row whose technique was retired', async () => {
  // `technique_id: null` is a REAL state, not a hypothetical one — migration
  // 000025's `ON DELETE SET NULL` produces exactly this when a technique is
  // retired, and `removeDrilledTechnique` in `bjjSession.ts` documents the
  // same nullability. `displayLearningState` reads a null id as 'seen', so an
  // unconditional badge here would show "Seen" on a row this session itself
  // recorded as drilled — a direct contradiction on the same line, which is
  // exactly what review caught before this test existed.
  (readLocalBjjDetail as jest.Mock).mockImplementationOnce(() =>
    deferred({
      ...mockDetail,
      tags: [{ category: 'submission', event: 'drilled', position: '', technique_id: null, count: 1 }],
    }),
  );

  render(<ReflectScreen />);

  await waitFor(() => {
    expect(screen.getByText('Drilled today')).toBeTruthy();
  });

  // The row itself must still render (nothing here hides the technique).
  expect(screen.getByTestId('bjj-drilled-chip-null')).toBeTruthy();
  // But no badge — and specifically no "Seen" contradicting a row the
  // session just recorded as drilled.
  expect(screen.queryByTestId('bjj-drilled-chip-null-state')).toBeNull();
  expect(screen.queryByText('Seen')).toBeNull();
});
