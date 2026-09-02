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

// N468/#792: two techniques that both match a "knee shield" search, so the
// "add a second related technique without retyping" scenario has a second
// result to tap.
const KNEE_SHIELD_GUARD = {
  id: 'knee-shield-guard',
  name: 'Knee Shield Guard',
  aliases: [],
  category: 'Guard',
  position: 'Guard - Bottom',
  position_detail: '',
  gi_no_gi: 'Both',
  typical_belt: '',
  ibjjf_ruleset_id: '',
  setup_from: [],
};
const KNEE_SHIELD_RECOVERY = {
  id: 'knee-shield-recovery',
  name: 'Knee Shield Recovery',
  aliases: [],
  category: 'Guard',
  position: 'Guard - Bottom',
  position_detail: '',
  gi_no_gi: 'Both',
  typical_belt: '',
  ibjjf_ruleset_id: '',
  setup_from: [],
};

jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: jest.fn(async () => [RELIABLE_TECHNIQUE, KNEE_SHIELD_GUARD, KNEE_SHIELD_RECOVERY]),
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

/**
 * N119/#508: the wizard is the "correct it" surface for a tag dictation kept
 * unmatched — `dictate.tsx`'s own header says there is "no separate 'review
 * a dictated session' surface, deliberately", so this IS where a phrase gets
 * a second chance at a real match once one exists.
 */
it('shows a tag kept unmatched from dictation, and resolves it to a real technique', async () => {
  (readLocalBjjDetail as jest.Mock).mockImplementationOnce(() =>
    deferred({
      ...mockDetail,
      tags: [
        {
          category: 'submission',
          event: 'scored',
          position: '',
          technique_id: null,
          count: 1,
          label: 'armbar',
        },
      ],
    }),
  );

  render(<ReflectScreen />);
  await waitFor(() => {
    expect(screen.getByTestId('bjj-reflect-screen')).toBeTruthy();
  });

  // Step 0 (drilled) -> step 1 (live), where this list lives.
  fireEvent.press(screen.getByTestId('bjj-reflect-next'));

  await waitFor(() => {
    expect(screen.getByText('Said, not matched to the library')).toBeTruthy();
  });
  // The phrase itself is visible — the "athlete can see it was not
  // recognised" half of the acceptance criteria.
  expect(screen.getByText('“armbar”')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Match “armbar” to a technique'));
  await waitFor(() => {
    expect(screen.getByLabelText('Armbar from Closed Guard, for “armbar”')).toBeTruthy();
  });
  fireEvent.press(screen.getByLabelText('Armbar from Closed Guard, for “armbar”'));

  // Resolved: the section is gone, and what got persisted carries the real
  // technique id with no leftover label.
  await waitFor(() => {
    expect(screen.queryByText('Said, not matched to the library')).toBeNull();
  });
  await waitFor(() => {
    expect(saveLocalBjjDetail).toHaveBeenCalledWith(
      'u1',
      's1',
      expect.objectContaining({
        tags: [
          expect.objectContaining({
            technique_id: 'armbar-closed-guard',
            label: undefined,
          }),
        ],
      }),
    );
  });
});

/**
 * N119/#508, the review finding both `ac-verifier` and `frontend-reviewer`
 * converged on independently: the plain category grid (`bump()` in this
 * screen, `tagCount()` in `lib/bjjSession.ts`) matched on
 * `!t.technique_id` alone, which a labelled ("kept unmatched") tag also
 * satisfies. Tapping the grid's "+" on the same category/event/position
 * could silently inflate a specific phrase's count; long-pressing "−"
 * could splice the labelled tag out of `detail.tags` entirely, with no
 * "Removed" notice anywhere — the exact silent-discard failure this
 * ticket exists to end, recreated one screen along, on a control that
 * looks like it only ever touches the anonymous grid.
 */
it('never lets the plain grid touch a labelled tag, in either direction', async () => {
  (readLocalBjjDetail as jest.Mock).mockImplementationOnce(() =>
    deferred({
      ...mockDetail,
      tags: [
        {
          category: 'sweep',
          event: 'scored',
          position: '',
          technique_id: null,
          count: 1,
          label: 'pool guards',
        },
      ],
    }),
  );

  render(<ReflectScreen />);
  await waitFor(() => {
    expect(screen.getByTestId('bjj-reflect-screen')).toBeTruthy();
  });

  // Step 0 (drilled) -> step 1 (live).
  fireEvent.press(screen.getByTestId('bjj-reflect-next'));

  await waitFor(() => {
    expect(screen.getByText('“pool guards”')).toBeTruthy();
  });

  // The plain grid counter for the same category/event/position excludes
  // the labelled tag's count — it lives only in the dedicated "Said, not
  // matched" row above, never blended into this anonymous total.
  // (Checked via the counter's own accessibility label, "Swept them: N" —
  // its rendered text also includes the row's static "Swept them" caption,
  // so a plain text-content match can't tell the value 0 from the label.)
  expect(screen.getByTestId('bjj-live-sweep-scored').props.accessibilityLabel).toBe(
    'Swept them: 0',
  );

  // Tap "+": must create a NEW, separate tag rather than incrementing the
  // labelled one. Overstating "pool guards" is the miscount half of the bug.
  fireEvent.press(screen.getByTestId('bjj-live-sweep-scored'));
  await waitFor(() => {
    expect(saveLocalBjjDetail).toHaveBeenLastCalledWith(
      'u1',
      's1',
      expect.objectContaining({
        tags: expect.arrayContaining([
          expect.objectContaining({ label: 'pool guards', count: 1 }),
          expect.not.objectContaining({ label: 'pool guards' }),
        ]),
      }),
    );
  });
  expect((saveLocalBjjDetail as jest.Mock).mock.calls.at(-1)?.[2].tags).toHaveLength(2);
  // Still a single occurrence, never "×2".
  expect(screen.queryByText('“pool guards” ×2')).toBeNull();
  expect(screen.getByText('“pool guards”')).toBeTruthy();

  // Long-press "−" on the same cell: must delete only the freshly-added
  // plain tag, never the labelled one — the deletion half of the bug, and
  // the one N119 itself exists to end.
  fireEvent(screen.getByTestId('bjj-live-sweep-scored'), 'longPress');
  await waitFor(() => {
    expect((saveLocalBjjDetail as jest.Mock).mock.calls.at(-1)?.[2].tags).toEqual([
      expect.objectContaining({ label: 'pool guards', count: 1 }),
    ]);
  });
  expect(screen.getByText('“pool guards”')).toBeTruthy();
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

/**
 * N468/#792 §1 — the user's own repro: search once, add a technique, and add
 * a second related one without retyping anything.
 */
describe('N468/#792: search does not clear itself on selection', () => {
  it('adds a second matching technique from the same search, with no retyping', async () => {
    render(<ReflectScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('bjj-reflect-screen')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByTestId('bjj-drilled-search'), 'knee shield');
    await waitFor(() => {
      expect(screen.getByTestId('bjj-drilled-add-knee-shield-guard')).toBeTruthy();
      expect(screen.getByTestId('bjj-drilled-add-knee-shield-recovery')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('bjj-drilled-add-knee-shield-guard'));

    // The query survives the selection — the whole point of this ticket.
    expect(screen.getByTestId('bjj-drilled-search').props.value).toBe('knee shield');

    // The second technique is STILL offered, with no retyping, and adding it
    // works too.
    await waitFor(() => {
      expect(screen.getByTestId('bjj-drilled-add-knee-shield-recovery')).toBeTruthy();
    });
    fireEvent.press(screen.getByTestId('bjj-drilled-add-knee-shield-recovery'));

    await waitFor(() => {
      expect(screen.getByTestId('bjj-drilled-chip-knee-shield-guard')).toBeTruthy();
      expect(screen.getByTestId('bjj-drilled-chip-knee-shield-recovery')).toBeTruthy();
    });
  });

  it('a technique already added does not reappear in the results for the same query', async () => {
    render(<ReflectScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('bjj-reflect-screen')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByTestId('bjj-drilled-search'), 'knee shield');
    await waitFor(() => {
      expect(screen.getByTestId('bjj-drilled-add-knee-shield-guard')).toBeTruthy();
    });

    fireEvent.press(screen.getByTestId('bjj-drilled-add-knee-shield-guard'));

    // It visibly disappears from the results — no retyping happened, so
    // this is the filter, not a cleared search.
    await waitFor(() => {
      expect(screen.queryByTestId('bjj-drilled-add-knee-shield-guard')).toBeNull();
    });
    // The other match for the same query is unaffected.
    expect(screen.getByTestId('bjj-drilled-add-knee-shield-recovery')).toBeTruthy();
  });

  it('tapping the search input resets the query, ready for new text', async () => {
    render(<ReflectScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('bjj-reflect-screen')).toBeTruthy();
    });

    const search = screen.getByTestId('bjj-drilled-search');
    fireEvent.changeText(search, 'knee shield');
    expect(search.props.value).toBe('knee shield');

    fireEvent(search, 'focus');
    expect(search.props.value).toBe('');
  });

  it('reads as "already added everything that matches", never as "no match", once every result is already drilled', async () => {
    render(<ReflectScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('bjj-reflect-screen')).toBeTruthy();
    });

    fireEvent.changeText(screen.getByTestId('bjj-drilled-search'), 'armbar');
    await waitFor(() => {
      expect(screen.getByTestId('bjj-drilled-add-armbar-closed-guard')).toBeTruthy();
    });
    fireEvent.press(screen.getByTestId('bjj-drilled-add-armbar-closed-guard'));

    // "armbar" now matches exactly one technique in this fixture, and it is
    // already added — a real match, not a lookup miss, so the copy must say
    // so rather than claiming the library has nothing for "armbar".
    await waitFor(() => {
      expect(screen.getByTestId('bjj-drilled-all-added')).toBeTruthy();
    });
    expect(screen.queryByTestId('bjj-drilled-empty')).toBeNull();
  });
});
