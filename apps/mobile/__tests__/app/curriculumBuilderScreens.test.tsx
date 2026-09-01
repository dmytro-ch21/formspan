import { useEffect } from 'react';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import NewCurriculumScreen from '../../app/curriculum/new';
import EditCurriculumScreen from '../../app/curriculum/edit/[id]';
import type { Curriculum } from '@/lib/curriculum';
import type { TechniqueSummary } from '@/lib/techniques';

/**
 * N83 — building and correcting a curriculum on the phone.
 *
 * What is pinned here is the WIRING: which state each screen is in, what a
 * tap does to the draft, and what actually reaches `createCurriculum` /
 * `updateCurriculum` / `deleteCurriculum`. The reorder/remap arithmetic is
 * `lib/__tests__/curriculumDraft.test.ts`'s job, and neither file can see the
 * other's class of bug — a mutation record entry lives in that file for the
 * pure logic; this one is what would have caught the web builder's own
 * "criteria cleared without its dependent" class of defect if it had reached
 * a screen rather than a pure function.
 */
jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const CATALOG: TechniqueSummary[] = [
  {
    id: 't-knee-cut', name: 'Knee cut', aliases: [], category: 'pass',
    position: 'Half guard top', position_detail: '', gi_no_gi: 'both', typical_belt: 'blue',
    ibjjf_ruleset_id: '', setup_from: [],
  },
  {
    id: 't-armbar', name: 'Armbar', aliases: [], category: 'submission',
    position: 'Mount', position_detail: '', gi_no_gi: 'both', typical_belt: 'white',
    ibjjf_ruleset_id: '', setup_from: [],
  },
];

jest.mock('@/lib/techniques', () => ({
  ...jest.requireActual('@/lib/techniques'),
  fetchTechniques: jest.fn(async () => CATALOG),
}));

const mockCreateCurriculum = jest.fn();
const mockUpdateCurriculum = jest.fn();
const mockDeleteCurriculum = jest.fn();
const mockGetCurriculum = jest.fn();
jest.mock('@/lib/curriculum', () => ({
  ...jest.requireActual('@/lib/curriculum'),
  createCurriculum: (...a: unknown[]) => mockCreateCurriculum(...a),
  updateCurriculum: (...a: unknown[]) => mockUpdateCurriculum(...a),
  deleteCurriculum: (...a: unknown[]) => mockDeleteCurriculum(...a),
  getCurriculum: (...a: unknown[]) => mockGetCurriculum(...a),
}));

/** See `addFoodCatalog.test.tsx`: a `mock`-prefixed binding rather than a
 *  `require` inside the factory, which the lint ratchet will not absorb. */
const mockUseEffect = useEffect;

const mockReplace = jest.fn();
const mockBack = jest.fn();
let mockParams: Record<string, string> = { id: 'c1' };
jest.mock('expo-router', () => ({
  __esModule: true,
  // `KeyboardAwareScrollView` (used by `CurriculumEditor`) reads this itself
  // — see `recipeScreen.test.tsx`'s identical mock for the same reason.
  useFocusEffect: (cb: () => void) => mockUseEffect(() => cb(), [cb]),
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: jest.fn(), back: mockBack, replace: mockReplace }),
  Stack: { Screen: () => null },
}));

// The hold gesture has its own suite (`holdToConfirm.test.tsx`) — this stands
// in a plain button that fires `onConfirm` on press, the same substitution
// `bjjSessionScreen.test.tsx` uses for the identical reason: re-driving the
// 900ms hold here would test that component twice and this screen zero times
// extra.
jest.mock('@/components/HoldToConfirm', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text } = require('react-native');
  return {
    HoldToConfirm: ({
      label,
      onConfirm,
      testID,
    }: {
      label: string;
      onConfirm: () => void;
      testID?: string;
    }) => React.createElement(Pressable, { onPress: onConfirm, testID }, React.createElement(Text, null, label)),
  };
});

function curriculum(over: Partial<Curriculum> = {}): Curriculum {
  return {
    id: 'c1',
    editable: true,
    name: 'Guard passing for winter',
    description: 'Half guard focus',
    belt: null,
    track: null,
    visibility: 'private',
    enrolled: false,
    started_on: null,
    item_count: 1,
    countable_items: 0,
    mastered_items: 0,
    concept_items: 0,
    read_concepts: 0,
    items: [
      {
        id: 1, kind: 'technique', technique_id: 't-knee-cut', name: 'Knee cut',
        position: 'Half guard top', category: 'pass', order: 0, phase: null,
        notes: '', criteria: null, progress: null, read_at: null,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  mockCreateCurriculum.mockReset();
  mockUpdateCurriculum.mockReset();
  mockDeleteCurriculum.mockReset();
  mockGetCurriculum.mockReset().mockResolvedValue(curriculum());
  mockReplace.mockReset();
  mockBack.mockReset();
  mockParams = { id: 'c1' };
});

describe('creating a curriculum', () => {
  it('disables Save until a name is entered', async () => {
    render(<NewCurriculumScreen />);
    await waitFor(() => expect(screen.getByTestId('curriculum-save')).toBeTruthy());
    expect(screen.getByTestId('curriculum-save').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
    fireEvent.changeText(screen.getByTestId('curriculum-name'), 'Guard retention');
    expect(screen.getByTestId('curriculum-save').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: false }),
    );
  });

  it('adds a technique from the picker and saves it in the create payload', async () => {
    render(<NewCurriculumScreen />);
    fireEvent.changeText(await screen.findByTestId('curriculum-name'), 'Guard retention');

    fireEvent.press(screen.getByTestId('curriculum-add-technique'));
    await waitFor(() => expect(screen.getByTestId('technique-picker')).toBeTruthy());
    fireEvent.press(await screen.findByTestId('technique-picker-t-knee-cut'));

    // Back on the builder, with the picked technique in the list.
    expect(await screen.findByText('Knee cut')).toBeTruthy();

    mockCreateCurriculum.mockResolvedValue(curriculum({ id: 'new-1' }));
    await act(async () => fireEvent.press(screen.getByTestId('curriculum-save')));

    expect(mockCreateCurriculum).toHaveBeenCalledTimes(1);
    const [, payload] = mockCreateCurriculum.mock.calls[0];
    expect(payload.name).toBe('Guard retention');
    expect(payload.items).toEqual([{ technique_id: 't-knee-cut', notes: '', title: undefined }]);
    expect(mockReplace).toHaveBeenCalledWith('/curriculum/new-1');
  });

  it('a technique already added shows as disabled in the picker, not a second time in the list', async () => {
    render(<NewCurriculumScreen />);
    fireEvent.changeText(await screen.findByTestId('curriculum-name'), 'X');
    fireEvent.press(screen.getByTestId('curriculum-add-technique'));
    fireEvent.press(await screen.findByTestId('technique-picker-t-knee-cut'));
    await screen.findByText('Knee cut');

    fireEvent.press(screen.getByTestId('curriculum-add-technique'));
    const disabledRow = await screen.findByTestId('technique-picker-t-knee-cut');
    expect(disabledRow.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
  });

  it('adds a concept, and refuses to save it untitled', async () => {
    render(<NewCurriculumScreen />);
    fireEvent.changeText(await screen.findByTestId('curriculum-name'), 'X');
    fireEvent.press(screen.getByTestId('curriculum-add-concept'));

    await act(async () => fireEvent.press(screen.getByTestId('curriculum-save')));
    expect(screen.getByTestId('curriculum-error')).toHaveTextContent(/concept/i);
    expect(mockCreateCurriculum).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByTestId('curriculum-item-0-title'), 'Posture before passing');
    mockCreateCurriculum.mockResolvedValue(curriculum());
    await act(async () => fireEvent.press(screen.getByTestId('curriculum-save')));
    const [, payload] = mockCreateCurriculum.mock.calls[0];
    expect(payload.items[0]).toEqual(
      expect.objectContaining({ kind: 'concept', title: 'Posture before passing' }),
    );
  });

  it('reorders items with the up/down buttons, and the new order is what saves', async () => {
    render(<NewCurriculumScreen />);
    fireEvent.changeText(await screen.findByTestId('curriculum-name'), 'X');
    fireEvent.press(screen.getByTestId('curriculum-add-technique'));
    fireEvent.press(await screen.findByTestId('technique-picker-t-knee-cut'));
    await screen.findByText('Knee cut');
    fireEvent.press(screen.getByTestId('curriculum-add-technique'));
    fireEvent.press(await screen.findByTestId('technique-picker-t-armbar'));
    await screen.findByText('Armbar');

    // Armbar was added second, so it starts at index 1.
    expect(screen.getByTestId('curriculum-item-1-up').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: false }),
    );
    fireEvent.press(screen.getByTestId('curriculum-item-1-up'));

    mockCreateCurriculum.mockResolvedValue(curriculum());
    await act(async () => fireEvent.press(screen.getByTestId('curriculum-save')));
    const [, payload] = mockCreateCurriculum.mock.calls[0];
    expect(payload.items.map((i: { technique_id?: string }) => i.technique_id)).toEqual([
      't-armbar',
      't-knee-cut',
    ]);
  });

  it('removes an item', async () => {
    render(<NewCurriculumScreen />);
    fireEvent.changeText(await screen.findByTestId('curriculum-name'), 'X');
    fireEvent.press(screen.getByTestId('curriculum-add-technique'));
    fireEvent.press(await screen.findByTestId('technique-picker-t-knee-cut'));
    await screen.findByText('Knee cut');

    fireEvent.press(screen.getByTestId('curriculum-item-0-remove'));
    expect(screen.queryByText('Knee cut')).toBeNull();
    expect(screen.getByTestId('curriculum-no-items')).toBeTruthy();
  });

  it('adds completion criteria with the shipped defaults, editable, and removable', async () => {
    render(<NewCurriculumScreen />);
    fireEvent.changeText(await screen.findByTestId('curriculum-name'), 'X');
    fireEvent.press(screen.getByTestId('curriculum-add-technique'));
    fireEvent.press(await screen.findByTestId('technique-picker-t-knee-cut'));
    await screen.findByText('Knee cut');

    fireEvent.press(screen.getByTestId('curriculum-item-0-add-criteria'));
    expect(screen.getByTestId('curriculum-item-0-target-scored').props.value).toBe('25');
    expect(screen.getByTestId('curriculum-item-0-target-sessions').props.value).toBe('12');
    expect(screen.getByTestId('curriculum-item-0-hit-rate').props.value).toBe('35');

    fireEvent.changeText(screen.getByTestId('curriculum-item-0-target-scored'), '40');

    mockCreateCurriculum.mockResolvedValue(curriculum());
    await act(async () => fireEvent.press(screen.getByTestId('curriculum-save')));
    const [, payload] = mockCreateCurriculum.mock.calls[0];
    expect(payload.items[0]).toEqual(
      expect.objectContaining({ target_scored: 40, target_sessions: 12, min_hit_rate: 0.35 }),
    );

    fireEvent.press(screen.getByTestId('curriculum-item-0-remove-criteria'));
    expect(screen.queryByTestId('curriculum-item-0-target-scored')).toBeNull();
    expect(screen.getByTestId('curriculum-item-0-add-criteria')).toBeTruthy();
  });

  /**
   * Clearing "Land it" clears the hit rate WITH it — the rate divides the
   * offensive attempt count, and the server refuses the pair otherwise. This
   * is the mobile side of `CurriculumBuilder.tsx`'s identical guard.
   */
  it('clears the hit rate when the offensive target is cleared', async () => {
    render(<NewCurriculumScreen />);
    fireEvent.changeText(await screen.findByTestId('curriculum-name'), 'X');
    fireEvent.press(screen.getByTestId('curriculum-add-technique'));
    fireEvent.press(await screen.findByTestId('technique-picker-t-knee-cut'));
    await screen.findByText('Knee cut');
    fireEvent.press(screen.getByTestId('curriculum-item-0-add-criteria'));

    fireEvent.changeText(screen.getByTestId('curriculum-item-0-target-scored'), '');
    expect(screen.getByTestId('curriculum-item-0-hit-rate').props.value).toBe('');
  });

  it('adds a phase, assigns an item to it, and reorders phases', async () => {
    render(<NewCurriculumScreen />);
    fireEvent.changeText(await screen.findByTestId('curriculum-name'), 'X');
    fireEvent.press(screen.getByTestId('curriculum-add-phase'));
    fireEvent.changeText(screen.getByTestId('curriculum-phase-0-title'), 'Foundations');

    fireEvent.press(screen.getByTestId('curriculum-add-technique'));
    fireEvent.press(await screen.findByTestId('technique-picker-t-knee-cut'));
    await screen.findByText('Knee cut');
    fireEvent.press(screen.getByTestId('curriculum-item-0-phase-0'));

    mockCreateCurriculum.mockResolvedValue(curriculum());
    await act(async () => fireEvent.press(screen.getByTestId('curriculum-save')));
    const [, payload] = mockCreateCurriculum.mock.calls[0];
    expect(payload.phases).toEqual([{ title: 'Foundations', description: '' }]);
    expect(payload.items[0].phase).toBe(0);
  });

  it('refuses to save an untitled phase, and blames the phase', async () => {
    render(<NewCurriculumScreen />);
    fireEvent.changeText(await screen.findByTestId('curriculum-name'), 'X');
    fireEvent.press(screen.getByTestId('curriculum-add-phase'));

    await act(async () => fireEvent.press(screen.getByTestId('curriculum-save')));
    expect(screen.getByTestId('curriculum-error')).toHaveTextContent(/phase/i);
    expect(mockCreateCurriculum).not.toHaveBeenCalled();
  });
});

describe('editing an existing curriculum', () => {
  it('shows a loading state before the curriculum arrives', async () => {
    let settle: (v: Curriculum) => void = () => {};
    mockGetCurriculum.mockReturnValue(new Promise((res) => { settle = res; }));
    render(<EditCurriculumScreen />);
    expect(screen.getByTestId('curriculum-edit-loading')).toBeTruthy();
    await act(async () => settle(curriculum()));
    await waitFor(() => expect(screen.getByTestId('curriculum-name')).toBeTruthy());
  });

  it('loads the existing fields and items', async () => {
    render(<EditCurriculumScreen />);
    await waitFor(() => expect(screen.getByTestId('curriculum-name').props.value).toBe('Guard passing for winter'));
    expect(screen.getByTestId('curriculum-description').props.value).toBe('Half guard focus');
    expect(await screen.findByText('Knee cut')).toBeTruthy();
  });

  it('refuses to render an editor for a curriculum that is not yours', async () => {
    mockGetCurriculum.mockResolvedValue(curriculum({ editable: false }));
    render(<EditCurriculumScreen />);
    await waitFor(() => expect(screen.getByTestId('curriculum-edit-not-editable')).toBeTruthy());
    expect(screen.queryByTestId('curriculum-name')).toBeNull();
  });

  it('shows the load error rather than a blank editor when the fetch fails', async () => {
    mockGetCurriculum.mockRejectedValue(new Error('offline'));
    render(<EditCurriculumScreen />);
    await waitFor(() => expect(screen.getByTestId('curriculum-edit-error')).toBeTruthy());
  });

  it('saves under the id it was opened with, and navigates to the roadmap viewer', async () => {
    render(<EditCurriculumScreen />);
    await waitFor(() => expect(screen.getByTestId('curriculum-name')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('curriculum-name'), 'Guard passing, revised');

    mockUpdateCurriculum.mockResolvedValue(curriculum({ name: 'Guard passing, revised' }));
    await act(async () => fireEvent.press(screen.getByTestId('curriculum-save')));

    expect(mockUpdateCurriculum).toHaveBeenCalledTimes(1);
    const [, id, payload] = mockUpdateCurriculum.mock.calls[0];
    expect(id).toBe('c1');
    expect(payload.name).toBe('Guard passing, revised');
    expect(mockReplace).toHaveBeenCalledWith('/curriculum/c1');
  });

  it('deletes the curriculum and returns to the list', async () => {
    render(<EditCurriculumScreen />);
    await waitFor(() => expect(screen.getByTestId('curriculum-delete')).toBeTruthy());

    mockDeleteCurriculum.mockResolvedValue(undefined);
    await act(async () => fireEvent.press(screen.getByTestId('curriculum-delete')));

    expect(mockDeleteCurriculum).toHaveBeenCalledWith(expect.any(Function), 'c1');
    expect(mockReplace).toHaveBeenCalledWith('/curriculum');
  });

  /**
   * A failed delete used to be silent — `deleteNow`'s catch set `error`, but
   * the only branch that ever rendered it was the initial-load failure, so a
   * hold-to-confirm could fire, the overlay flash and vanish, and the
   * athlete would have no way to tell the curriculum still exists.
   * frontend-reviewer's finding on this PR.
   */
  it('shows an error and stays put when the delete request fails', async () => {
    render(<EditCurriculumScreen />);
    await waitFor(() => expect(screen.getByTestId('curriculum-delete')).toBeTruthy());

    mockDeleteCurriculum.mockRejectedValue(new Error('offline'));
    await act(async () => fireEvent.press(screen.getByTestId('curriculum-delete')));

    expect(screen.getByTestId('curriculum-delete-error')).toHaveTextContent('offline');
    expect(mockReplace).not.toHaveBeenCalledWith('/curriculum');
    // The curriculum is still here to retry against — this is not the
    // initial-load-failed state, which would have unmounted the editor.
    expect(screen.getByTestId('curriculum-name')).toBeTruthy();
  });
});
