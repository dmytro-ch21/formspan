import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import CurriculumScreen from '../curriculum/[id]';
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
jest.mock('@/lib/curriculum', () => ({
  ...jest.requireActual('@/lib/curriculum'),
  getCurriculum: (...a: unknown[]) => mockGetCurriculum(...a),
  enrollInCurriculum: jest.fn(() => Promise.resolve()),
  archiveCurriculumEnrollment: jest.fn(() => Promise.resolve()),
}));

const mockSetFocus = jest.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve());
jest.mock('@/lib/bjjFocus', () => ({
  ...jest.requireActual('@/lib/bjjFocus'),
  fetchFocus: () => Promise.resolve([]),
  setFocus: (...a: unknown[]) => mockSetFocus(...a),
}));

jest.mock('@/lib/useAuthToken', () => ({
  useAuthToken: () => () => Promise.resolve('token'),
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

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCurriculum.mockResolvedValue(WHITE);
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
