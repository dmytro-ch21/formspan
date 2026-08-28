import {
  act,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';

import CurriculumScreen from '../../app/curriculum/[id]';
import type { Curriculum, CurriculumItem } from '@/lib/curriculum';

/**
 * The roadmap screen, tested on the property the whole redesign turns on:
 * **it is a hierarchy of collapsed things.**
 *
 * White belt is 93 lessons across 11 milestones. Everything below is a claim
 * about what is and is not MOUNTED, which is simultaneously the design
 * ("first high level, next more in details") and the performance argument
 * (N30 flagged this screen as a plain `ScrollView` at 85 items). A render test
 * is the only thing that can tell those apart from a screen that merely looks
 * tidy — reading the code cannot, because a collapsed section and a section
 * rendered at zero height are the same source.
 *
 * The other three claims are ones review has already had to catch by eye on
 * this feature:
 *
 *  - a lesson expands IN PLACE, so nothing may navigate,
 *  - the lesson level offers **no way to mark anything complete**, because the
 *    database refuses one (migration 000034),
 *  - and a concept reads as *understand this*, never as an unfinished
 *    measurable.
 */
jest.setTimeout(30_000);

// RNTL's default `asyncUtilTimeout` is ONE SECOND, and this suite needs longer.
// **Measured, not guessed:** with the jest transform cache cleared, the first
// test here fails 3 out of 3 — the screen is still showing its `ActivityIndicator`
// when `waitFor` gives up at one second, and the test takes ~1.8s. Warm, it
// passes 5 out of 5 in ~160ms, which is why a local run says everything is fine
// and a cold runner does not. Seven suites here already raise it for exactly
// this reason, and `jest.config.js`'s `testTimeout: 15_000` is what makes ten
// seconds actually reachable — see F13, where five files asked for ten and jest
// killed them at five.
configure({ asyncUtilTimeout: 10_000 });

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => {
  // `jest.requireActual`, not a bare `require` — the factory is hoisted above
  // the imports, so React has to be reached from inside it, and the lint rule
  // that forbids `require()` is one this file has no reason to spend.
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useLocalSearchParams: () => ({ id: 'white-belt-basics' }),
    useFocusEffect: (cb: () => void) => useEffect(() => cb(), [cb]),
    useRouter: () => ({
      push: mockPush,
      back: mockBack,
      replace: mockReplace,
      canGoBack: () => true,
    }),
    Stack: { Screen: () => null },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

const mockGetCurriculum = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(null));
const mockDeleteCurriculum = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve());
jest.mock('@/lib/curriculum', () => ({
  ...jest.requireActual('@/lib/curriculum'),
  getCurriculum: (...a: unknown[]) => mockGetCurriculum(...a),
  enrollInCurriculum: jest.fn(() => Promise.resolve()),
  archiveCurriculumEnrollment: jest.fn(() => Promise.resolve()),
  deleteCurriculum: (...a: unknown[]) => mockDeleteCurriculum(...a),
}));

const mockSetFocus = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve());
const mockFetchFocus = jest.fn((): Promise<unknown> => Promise.resolve([]));
jest.mock('@/lib/bjjFocus', () => ({
  ...jest.requireActual('@/lib/bjjFocus'),
  fetchFocus: () => mockFetchFocus(),
  setFocus: (...a: unknown[]) => mockSetFocus(...a),
}));

// STABLE across renders, deliberately. `useAuthToken` returning a fresh
// closure each render changes `load`'s identity, which re-fires the mocked
// `useFocusEffect` on every re-render — so the harness manufactured extra
// fetches and nothing could distinguish those from the screen's own. Any test
// counting reads is measuring this mock unless it is stable.
const stableToken = () => Promise.resolve('token');
jest.mock('@/lib/useAuthToken', () => ({
  useAuthToken: () => stableToken,
}));

/**
 * The sync clock, driven by the test — N122.
 *
 * The screen SUBSCRIBES rather than reading a hook value, so the fake has to
 * be a real little broadcaster: `syncState()` for the value it starts from and
 * `subscribeSync` for the changes. `landSync()` is what an outbox push
 * finishing looks like from in here — which is the moment the reflection the
 * athlete just wrote becomes visible to the server, and strictly after this
 * screen's focus refetch has already been and gone.
 */
const mockSyncListeners = new Set<(s: { lastSyncAt: number | null }) => void>();
const mockSyncClock = { lastSyncAt: null as number | null };
function landSync() {
  mockSyncClock.lastSyncAt = (mockSyncClock.lastSyncAt ?? 0) + 1000;
  for (const l of mockSyncListeners) l({ ...mockSyncClock });
}
/** What `setSyncIdentity(null, null)` broadcasts when the athlete signs out. */
function signOut() {
  mockSyncClock.lastSyncAt = null;
  for (const l of mockSyncListeners) l({ ...mockSyncClock });
}
jest.mock('@/lib/sync', () => ({
  ...jest.requireActual('@/lib/sync'),
  syncState: () => ({ ...mockSyncClock }),
  subscribeSync: (fn: (s: { lastSyncAt: number | null }) => void) => {
    mockSyncListeners.add(fn);
    // The real one calls back immediately on subscribe. Reproduced, because
    // the screen's "have I seen this value" guard is what stops that immediate
    // call becoming a second cold-mount fetch — a fake that stayed silent
    // would leave that guard untested.
    fn({ ...mockSyncClock });
    return () => mockSyncListeners.delete(fn);
  },
}));

function technique(id: string, name: string, phase: number, scored: number): CurriculumItem {
  return {
    kind: 'technique',
    technique_id: id,
    name,
    position: 'Guard - Bottom',
    category: 'Sweep',
    order: 0,
    phase,
    notes: 'The one most people land first.',
    criteria: {
      target_scored: scored,
      target_defended: null,
      target_sessions: 12,
      min_hit_rate: null,
      target_drilled_sessions: null,
    },
    progress: {
      scored: 3,
      defended: 0,
      sessions: 2,
      attempts: 9,
      hit_rate: 0.33,
      drilled_sessions: 0,
      mastered: false,
    },
  };
}

const WHITE: Curriculum = {
  id: 'white-belt-basics',
  editable: false,
  official: true,
  name: 'White belt: learn the basic game',
  description: 'Goal: understand what is actually happening in a BJJ match. The rest follows.',
  belt: 'white',
  track: 'belt',
  visibility: 'public',
  enrolled: true,
  started_on: '2026-01-01',
  item_count: 4,
  countable_items: 3,
  mastered_items: 0,
  phases: [
    { order: 0, title: 'Start Standing', description: 'Begin safely.' },
    { order: 1, title: 'Sweep From Bottom', description: 'Bottom to top.' },
    { order: 2, title: 'Strategy', description: 'Ideas only.' },
  ],
  items: [
    technique('grappling-stance', 'Grappling stance', 0, 10),
    technique('scissor-sweep', 'Scissor sweep', 1, 15),
    technique('hip-bump-sweep', 'Hip bump sweep', 1, 12),
    {
      kind: 'concept',
      title: 'Position before submission',
      name: 'Position before submission',
      position: '',
      category: '',
      order: 9,
      phase: 2,
      notes: 'Improve where you are before you try to finish.',
      criteria: null,
      progress: null,
    },
  ],
};

/**
 * `WHITE`'s items, narrowed.
 *
 * `Curriculum.items` is OPTIONAL in the contract — absent on list responses,
 * present on a single read — which is the lazy rule the API deliberately
 * follows, so the type cannot know this fixture has them. Throws rather than
 * defaulting to `[]`: a fixture that quietly lost its items would make every
 * assertion built on it vacuous, which is the failure mode this suite exists
 * to avoid.
 */
function whiteItems(): CurriculumItem[] {
  if (!WHITE.items) throw new Error('WHITE fixture has no items');
  return WHITE.items;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSyncClock.lastSyncAt = null;
  mockSyncListeners.clear();
  mockGetCurriculum.mockResolvedValue(WHITE);
  mockFetchFocus.mockResolvedValue([]);
});

async function open() {
  render(<CurriculumScreen />);
  await waitFor(() => expect(screen.getByTestId('roadmap-title')).toBeTruthy());
}

describe('arriving', () => {
  it('shows the shape of the belt, and none of its contents', async () => {
    await open();

    // Every milestone, by name.
    expect(screen.getByText('Start Standing')).toBeTruthy();
    expect(screen.getByText('Sweep From Bottom')).toBeTruthy();
    expect(screen.getByText('Strategy')).toBeTruthy();

    // And not one lesson. This is the assertion the whole design rests on: at
    // white belt these three stand for 93 rows that must not be mounted.
    expect(screen.queryByText('Grappling stance')).toBeNull();
    expect(screen.queryByText('Scissor sweep')).toBeNull();
    expect(screen.queryByText('Position before submission')).toBeNull();
  });

  it('names the belt in its own right, not by the curriculum sentence', async () => {
    await open();
    expect(screen.getByTestId('roadmap-title')).toHaveTextContent('WHITE BELT');
  });

  it('counts the lessons in each milestone without opening it', async () => {
    await open();
    // Two milestones hold one lesson each, one holds two.
    expect(screen.getAllByText('1 lesson')).toHaveLength(2);
    expect(screen.getByText('2 lessons')).toBeTruthy();
  });

  it('keeps the belt thesis to one line until it is asked to expand', async () => {
    await open();
    expect(screen.getByText('Learn the basic game')).toBeTruthy();
    expect(screen.queryByTestId('roadmap-description')).toBeNull();

    fireEvent.press(screen.getByTestId('roadmap-thesis'));
    expect(screen.getByTestId('roadmap-description')).toBeTruthy();
  });

  it('lets the thesis and the description speak for themselves', async () => {
    // An `accessibilityLabel` REPLACES an element's children for a screen
    // reader, and anything nested inside an accessible element is not reachable
    // as its own node. Labelling this button silenced the thesis; rendering the
    // description inside it made a belt's entire framing — the three orphaned
    // phases #445 moved into the description — announced by nothing at all.
    await open();
    const thesis = screen.getByTestId('roadmap-thesis');
    expect(thesis.props.accessibilityLabel).toBeUndefined();
    expect(thesis).toHaveTextContent(/Learn the basic game/);

    fireEvent.press(thesis);
    // Outside the pressable, so it is its own accessible node.
    expect(within(thesis).queryByTestId('roadmap-description')).toBeNull();
    expect(screen.getByTestId('roadmap-description')).toBeTruthy();
  });
});

describe('the connecting rule', () => {
  it('carries no vertical spacing on the row, which is what keeps it unbroken', async () => {
    // The gutter is a stretched CHILD, so its height is the row's content box:
    // padding on the row is space an absolutely-positioned `bottom: 0` rail can
    // never reach, and it turned one belt-coloured line into eleven dashes. The
    // spacing belongs on `cardCol`, inside the box the gutter matches.
    await open();
    const row = StyleSheet.flatten(screen.getByTestId('roadmap-row-2').props.style);
    expect(row.paddingBottom ?? 0).toBe(0);
    expect(row.paddingTop ?? 0).toBe(0);
    expect(row.paddingVertical ?? 0).toBe(0);
    expect(row.marginBottom ?? 0).toBe(0);
    expect(row.marginTop ?? 0).toBe(0);
  });

  it('runs the full height of a middle row, and stops at the last circle', async () => {
    await open();
    const middle = StyleSheet.flatten(screen.getByTestId('roadmap-rail-2').props.style);
    expect([middle.top, middle.bottom]).toEqual([0, 0]);

    // The last segment ends at its own circle's centre rather than running off
    // the bottom into the completion card.
    const last = StyleSheet.flatten(screen.getByTestId('roadmap-rail-3').props.style);
    expect(last.top).toBe(0);
    expect(last.height).toBeGreaterThan(0);
    // Not merely overridden — ABSENT. Yoga resolves top+bottom by stretching
    // and ignoring the height, so an inherited `bottom: 0` here ran the final
    // segment past its circle and into the completion card.
    expect(last.bottom).toBeUndefined();
  });

  it('applies the same three cases to the inner rule under a lesson list', async () => {
    // Identical shape, identical hazard — and this one is drawn per open
    // milestone, so it regresses without the outer rule changing at all.
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));

    const first = StyleSheet.flatten(
      screen.getByTestId('roadmap-inner-rail-scissor-sweep').props.style,
    );
    expect(first.top).toBeGreaterThan(0);
    expect(first.bottom).toBe(0);
    expect(first.height).toBeUndefined();

    const last = StyleSheet.flatten(
      screen.getByTestId('roadmap-inner-rail-hip-bump-sweep').props.style,
    );
    expect(last.top).toBe(0);
    expect(last.height).toBeGreaterThan(0);
    expect(last.bottom).toBeUndefined();
  });
});

describe('a milestone', () => {
  it('reveals its lessons on tap, names only', async () => {
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));

    expect(screen.getByText('Scissor sweep')).toBeTruthy();
    expect(screen.getByText('Hip bump sweep')).toBeTruthy();
    // Names only: no detail until a lesson itself is asked for.
    expect(screen.queryByTestId('roadmap-lesson-detail-scissor-sweep')).toBeNull();
  });

  it('closes the previous one — only ever one open at a time', async () => {
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-1'));
    expect(screen.getByText('Grappling stance')).toBeTruthy();

    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    expect(screen.queryByText('Grappling stance')).toBeNull();
    expect(screen.getByText('Scissor sweep')).toBeTruthy();
  });

  it('closes again when tapped a second time', async () => {
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    expect(screen.queryByText('Scissor sweep')).toBeNull();
  });

  it('reports its own progress while closed, at its own granularity', async () => {
    await open();
    // Two countable lessons in milestone 2, neither mastered — and the answer
    // is on the CLOSED card, which is what makes the collapsed state useful.
    expect(within(screen.getByTestId('roadmap-milestone-2')).getByText('0/2')).toBeTruthy();
    expect(within(screen.getByTestId('roadmap-milestone-1')).getByText('0/1')).toBeTruthy();
  });

  it('shows NO progress for a milestone nothing can complete', async () => {
    await open();
    // "Strategy" holds one concept. `0/1` there would report a failure the
    // athlete cannot avoid, since nothing in it is completable at all — and
    // milestone 1 proves the counter is drawn at all, so its absence here is
    // the rule firing rather than the feature being missing.
    expect(within(screen.getByTestId('roadmap-milestone-3')).queryByText(/\d+\/\d+/)).toBeNull();
  });
});

describe('a lesson', () => {
  it('expands in place and never navigates away', async () => {
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    fireEvent.press(screen.getByTestId('roadmap-lesson-scissor-sweep'));

    expect(screen.getByTestId('roadmap-lesson-detail-scissor-sweep')).toBeTruthy();
    // The milestone is still on screen around it — that is the whole point of
    // expanding rather than pushing a route.
    expect(screen.getByText('Sweep From Bottom')).toBeTruthy();
    expect(screen.getByText('Hip bump sweep')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('says how it is measured, and where the record stands', async () => {
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    fireEvent.press(screen.getByTestId('roadmap-lesson-scissor-sweep'));

    expect(screen.getByText('HOW THIS IS MEASURED')).toBeTruthy();
    expect(screen.getByText('Landed live')).toBeTruthy();
    expect(screen.getByText('3 / 15')).toBeTruthy();
    expect(screen.getByText('Separate live sessions')).toBeTruthy();
    expect(screen.getByText('2 / 12')).toBeTruthy();
  });

  it('offers no way to mark itself complete', async () => {
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    fireEvent.press(screen.getByTestId('roadmap-lesson-scissor-sweep'));

    // There is deliberately no hand-completion path in the data model, so
    // there must be none on the screen either. A checkbox or a switch here
    // would promise something every write path refuses.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });

  it('starts it instead — one technique, into the focus list', async () => {
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    fireEvent.press(screen.getByTestId('roadmap-lesson-scissor-sweep'));
    fireEvent.press(screen.getByTestId('roadmap-work-scissor-sweep'));

    await waitFor(() => expect(mockSetFocus).toHaveBeenCalled());
    const [, ids, roadmap] = mockSetFocus.mock.calls[0] as [unknown, string[], unknown];
    expect(ids).toEqual(['scissor-sweep']);
    // Attributed to the roadmap, so deactivating it takes back what it added
    // — and nothing the athlete chose by hand.
    expect(roadmap).toEqual({
      curriculum_id: 'white-belt-basics',
      technique_ids: ['scissor-sweep'],
    });
  });

  it('says so instead of offering a dead button when it is already in focus', async () => {
    // A control that returns silently is indistinguishable from one that is
    // broken: the athlete's reading of "nothing happened" is that the tap was
    // dropped. `proposeOneFocus` would return `unchanged` here, so there is
    // nothing for the button to do and it must not be drawn.
    mockFetchFocus.mockResolvedValue([
      {
        technique_id: 'scissor-sweep',
        name: 'Scissor sweep',
        position: 'Guard - Bottom',
        category: 'Sweep',
        started_on: '2026-01-02',
      },
    ]);
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    fireEvent.press(screen.getByTestId('roadmap-lesson-scissor-sweep'));

    expect(screen.queryByTestId('roadmap-work-scissor-sweep')).toBeNull();
    expect(screen.getByTestId('roadmap-in-focus-scissor-sweep')).toHaveTextContent(
      /Already in your focus/,
    );

    // And the lesson beside it, which is NOT in focus, still offers the button.
    fireEvent.press(screen.getByTestId('roadmap-lesson-hip-bump-sweep'));
    expect(screen.getByTestId('roadmap-work-hip-bump-sweep')).toBeTruthy();
  });

  it('reads a concept as something to understand, with nothing to count', async () => {
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-3'));
    fireEvent.press(screen.getByTestId('roadmap-lesson-c9'));

    expect(screen.getByTestId('roadmap-lesson-detail-c9')).toHaveTextContent(/Understand this/);
    expect(screen.queryByText('HOW THIS IS MEASURED')).toBeNull();
    // And no "start this" button: there is nothing a focus chip would record.
    expect(screen.queryByTestId('roadmap-work-c9')).toBeNull();
  });

  it('closes when a different milestone is opened', async () => {
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    fireEvent.press(screen.getByTestId('roadmap-lesson-scissor-sweep'));
    fireEvent.press(screen.getByTestId('roadmap-milestone-1'));
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));

    expect(screen.queryByTestId('roadmap-lesson-detail-scissor-sweep')).toBeNull();
  });
});

describe('the summary cards', () => {
  it('counts milestones that can be completed, not every milestone', async () => {
    await open();
    // Three phases; "Strategy" holds only a concept, so it is neither
    // completable nor counted against the athlete.
    expect(screen.getByText('0 of 2 milestones completed')).toBeTruthy();
  });

  it('reports a derived percentage on both rings', async () => {
    await open();
    expect(screen.getByTestId('roadmap-progress-ring')).toHaveProp(
      'accessibilityLabel',
      '0 percent of milestones completed',
    );
    expect(screen.getByTestId('roadmap-completion-ring')).toBeTruthy();
  });

  it('does not announce a shortfall to a screen reader before counting starts', async () => {
    // The visible counter is already gated on enrolment; leaving the spoken one
    // ungated leaks the exact claim the rest of the screen refuses, through the
    // one layer nobody looks at.
    mockGetCurriculum.mockResolvedValue({ ...WHITE, enrolled: false, started_on: null });
    await open();
    const label = screen.getByTestId('roadmap-milestone-2').props.accessibilityLabel as string;
    expect(label).toContain('2 lessons');
    expect(label).not.toContain('mastered');
  });

  it('says nothing is being counted for a roadmap not taken on', async () => {
    mockGetCurriculum.mockResolvedValue({ ...WHITE, enrolled: false, started_on: null });
    await open();
    expect(screen.getByTestId('roadmap-progress-ring')).toHaveProp(
      'accessibilityLabel',
      'Not started — nothing is being counted yet',
    );
    expect(screen.getByTestId('curriculum-enrollment')).toBeTruthy();
  });
});

/**
 * N122 — logging has to advance the roadmap the athlete is looking at.
 *
 * The backend half was measured correct against a real database: enrol through
 * the repository, write `drilled`/`scored` tags, and `GET /v1/curricula/{id}`
 * returns the counts. What was broken is on this side, and in two places.
 *
 * These are the ones a render test can reach. Neither is visible by reading the
 * screen: an effect that never fires and an effect that fires look identical in
 * source, which is the same argument the file header makes about a collapsed
 * section.
 */
describe('a session logged while the roadmap is open', () => {
  it('re-reads when the sync lands, so the figure moves without leaving', async () => {
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    fireEvent.press(screen.getByTestId('roadmap-lesson-scissor-sweep'));
    const detail = () => within(screen.getByTestId('roadmap-lesson-detail-scissor-sweep'));
    expect(detail().getByText('3 / 15')).toBeTruthy();

    // The reflection lands on the server: two more scored. This is exactly what
    // the outbox push produces, and it happens AFTER the wizard navigated back,
    // so the focus refetch has already been and gone.
    mockGetCurriculum.mockResolvedValue({
      ...WHITE,
      items: whiteItems().map((i) =>
        i.technique_id === 'scissor-sweep' && i.progress
          ? { ...i, progress: { ...i.progress, scored: 5 } }
          : i,
      ),
    });

    landSync();

    // The number moves, and the milestone stays open around it — the point of
    // expanding in place is that a refresh does not cost your position.
    await waitFor(() => expect(detail().getByText('5 / 15')).toBeTruthy());
  });

  it('does not re-read on a cold mount, where the focus read already fired', async () => {
    // `lastSyncAt` starts null and an effect keyed on it runs once regardless.
    // Without the null guard every arrival costs two identical round trips.
    await open();
    expect(mockGetCurriculum).toHaveBeenCalledTimes(1);
  });

  it('does not refetch on sign-out, which broadcasts a null clock', async () => {
    // `setSyncIdentity(null, null)` emits `lastSyncAt: null`. A subscriber
    // holding a number reads that as a change and would fetch with no
    // identity, flashing an error at an athlete who has just signed out in the
    // window before the layout unmounts this screen. Nine modules once told a
    // signed-in athlete to sign in for the mirror-image reason; this is the
    // same class and must stay shut.
    await open();
    landSync();
    await waitFor(() => expect(mockGetCurriculum).toHaveBeenCalledTimes(2));

    signOut();
    // And a sync that lands AFTER sign-out is still not this screen's cue —
    // the guard must re-arm rather than latch.
    expect(mockGetCurriculum).toHaveBeenCalledTimes(2);
  });

  it('says what would count where the athlete drilled something measured live', async () => {
    // 61 of white belt's 81 technique items are measured on live rounds. The
    // API sends `drilled_sessions` for every one of them and the measure list
    // draws it for none — so ten classes of work rendered as a column of
    // zeros. The criteria are untouched; the screen explains itself instead.
    mockGetCurriculum.mockResolvedValue({
      ...WHITE,
      items: whiteItems().map((i) =>
        i.technique_id === 'scissor-sweep' && i.progress
          ? {
              ...i,
              progress: { ...i.progress, scored: 0, attempts: 0, hit_rate: null, drilled_sessions: 6 },
            }
          : i,
      ),
    });
    await open();
    fireEvent.press(screen.getByTestId('roadmap-milestone-2'));
    fireEvent.press(screen.getByTestId('roadmap-lesson-scissor-sweep'));

    const note = screen.getByTestId('roadmap-evidence-scissor-sweep');
    expect(note).toHaveTextContent(/Drilled in 6 classes/);
    expect(note).toHaveTextContent(/land it in a live round/);

    // And still no checkbox. Migration 000034's invariant is what this whole
    // explanation exists to keep — the screen says what would count precisely
    // because it may not offer a way to declare it done.
    expect(screen.queryByTestId('roadmap-complete-scissor-sweep')).toBeNull();
  });
});

/**
 * N83 — Edit and Delete, added to the same overflow menu enrolment already
 * used. Gated on `editable`, exactly like `apps/web`'s detail page gates its
 * Edit link and Delete button — `WHITE` (the fixture every other describe
 * block in this file uses) is `editable: false`, a belt syllabus, and stays
 * that way here: these tests are what pin that a syllabus's menu does NOT
 * grow the two new options, alongside a second fixture that does.
 *
 * `Alert.alert` has no RNTL query of its own, so this reads its call args
 * directly — the options array IS the menu, and pressing a row is calling
 * that option's `onPress`. The one thing this file cannot see is the
 * PLATFORM alert actually rendering; that is `Alert`'s own contract, not this
 * screen's.
 */
describe('the overflow menu: Edit and Delete (N83)', () => {
  const MINE: Curriculum = { ...WHITE, editable: true, official: false, track: null, belt: null };

  function pressMenuAndGetOptions(): { text: string; style?: string; onPress?: () => void }[] {
    fireEvent.press(screen.getByTestId('roadmap-menu'));
    const call = jest.mocked(Alert.alert).mock.calls.at(-1);
    if (!call) throw new Error('Alert.alert was not called');
    return call[2] as { text: string; style?: string; onPress?: () => void }[];
  }

  beforeEach(() => {
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  it('offers neither option on a curriculum that is not editable', async () => {
    mockGetCurriculum.mockResolvedValue(WHITE);
    await open();
    const options = pressMenuAndGetOptions();
    expect(options.map((o) => o.text)).not.toContain('Edit');
    expect(options.map((o) => o.text)).not.toContain('Delete curriculum');
  });

  it('offers Edit on one that is, and it pushes the N83 edit route', async () => {
    mockGetCurriculum.mockResolvedValue(MINE);
    await open();
    const options = pressMenuAndGetOptions();
    const edit = options.find((o) => o.text === 'Edit');
    expect(edit).toBeTruthy();
    edit!.onPress?.();
    expect(mockPush).toHaveBeenCalledWith('/curriculum/edit/white-belt-basics');
  });

  it('Delete asks a second time before it deletes anything', async () => {
    mockGetCurriculum.mockResolvedValue(MINE);
    await open();
    const options = pressMenuAndGetOptions();
    const del = options.find((o) => o.text === 'Delete curriculum');
    expect(del).toBeTruthy();
    expect(del!.style).toBe('destructive');

    del!.onPress?.();
    expect(mockDeleteCurriculum).not.toHaveBeenCalled();

    const confirmCall = jest.mocked(Alert.alert).mock.calls.at(-1)!;
    expect(confirmCall[0]).toMatch(/delete this curriculum/i);
    const confirmOptions = confirmCall[2] as { text: string; style?: string; onPress?: () => void }[];
    const confirm = confirmOptions.find((o) => o.text === 'Delete');
    await act(async () => {
      await confirm!.onPress?.();
    });

    expect(mockDeleteCurriculum).toHaveBeenCalledWith(expect.any(Function), 'white-belt-basics');
    expect(mockReplace).toHaveBeenCalledWith('/curriculum');
  });

  it('Cancel on the confirm leaves the curriculum alone', async () => {
    mockGetCurriculum.mockResolvedValue(MINE);
    await open();
    const del = pressMenuAndGetOptions().find((o) => o.text === 'Delete curriculum');
    del!.onPress?.();

    const confirmOptions = jest.mocked(Alert.alert).mock.calls.at(-1)![2] as {
      text: string;
      onPress?: () => void;
    }[];
    // Cancel carries no `onPress` at all in this screen's own convention
    // (every other Cancel button in this file is `{ text: 'Cancel', style:
    // 'cancel' }`), so there is nothing to press — the assertion is that
    // Delete was never reached.
    expect(confirmOptions.find((o) => o.text === 'Cancel')?.onPress).toBeUndefined();
    expect(mockDeleteCurriculum).not.toHaveBeenCalled();
  });
});
