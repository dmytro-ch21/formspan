/**
 * N531/#962, extended by N553/#1019 — the drop decision behind the food day
 * view's drag, without a gesture. `useEntryDrag`'s own doc comment says why it
 * is a hook rather than logic inside a row: so THIS file can hand it a set of
 * rectangles and ask what `onDrop` was told.
 *
 * A drop now names TWO things — the meal, and the SLOT inside it — so every
 * case below asserts both.
 */
import * as Haptics from 'expo-haptics';
import { act, renderHook } from '@testing-library/react-native';

import {
  dropTargetFor,
  slotFor,
  useEntryDrag,
  type Frames,
  type RowFrame,
  type SectionFrame,
} from '../useEntryDrag';

const FRAMES: SectionFrame[] = [
  { meal: 'breakfast', top: 100, bottom: 200 },
  { meal: 'lunch', top: 200, bottom: 300 },
  { meal: 'dinner', top: 300, bottom: 400 },
  { meal: 'snack', top: 400, bottom: 500 },
];

/**
 * Three rows in breakfast and one in lunch. Breakfast's rows are 20 tall with
 * midpoints at 120, 140 and 160 — the numbers every slot assertion below is
 * reading against.
 */
const ROWS: RowFrame[] = [
  { id: 'e1', meal: 'breakfast', top: 110, bottom: 130 },
  { id: 'e2', meal: 'breakfast', top: 130, bottom: 150 },
  { id: 'e3', meal: 'breakfast', top: 150, bottom: 170 },
  { id: 'l1', meal: 'lunch', top: 210, bottom: 230 },
];

const ALL: Frames = { sections: FRAMES, rows: ROWS };

describe('dropTargetFor', () => {
  it('names the section under the finger', async () => {
    expect(dropTargetFor(150, FRAMES)).toBe('breakfast');
    expect(dropTargetFor(250, FRAMES)).toBe('lunch');
    expect(dropTargetFor(499, FRAMES)).toBe('snack');
  });

  it('is half-open, so a boundary pixel belongs to exactly one section', async () => {
    expect(dropTargetFor(200, FRAMES)).toBe('lunch');
    expect(dropTargetFor(300, FRAMES)).toBe('dinner');
  });

  it('is null above, below and between the cards — never "the nearest"', async () => {
    expect(dropTargetFor(50, FRAMES)).toBeNull();
    expect(dropTargetFor(500, FRAMES)).toBeNull();
    expect(dropTargetFor(250, [FRAMES[0], FRAMES[2]])).toBeNull();
  });

  it('is null with nothing measured', async () => {
    expect(dropTargetFor(250, [])).toBeNull();
  });
});

async function setup(over: { enabled?: boolean; frames?: Frames } = {}) {
  const onDrop = jest.fn();
  const measure = jest.fn(async () => over.frames ?? ALL);
  const hook = await renderHook(
    ({ enabled }: { enabled: boolean }) => useEntryDrag({ enabled, measure, onDrop }),
    { initialProps: { enabled: over.enabled ?? true } },
  );
  return { ...hook, onDrop, measure };
}

/** Let the `measure` promise land inside `act`. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('slotFor', () => {
  it('opens the gap when the finger crosses a row MIDPOINT, not its edge', async () => {
    // Dragging e3 through breakfast. Midpoints of the OTHER two are 120, 140.
    expect(slotFor(119, 'breakfast', ROWS, 'e3')).toBe(0);
    expect(slotFor(121, 'breakfast', ROWS, 'e3')).toBe(1);
    expect(slotFor(139, 'breakfast', ROWS, 'e3')).toBe(1);
    expect(slotFor(141, 'breakfast', ROWS, 'e3')).toBe(2);
  });

  it('EXCLUDES the dragged row, because that is what an insertion index counts', async () => {
    // With e1 excluded, the rows are e2 (mid 140) and e3 (mid 160), so a
    // finger at 150 is index 1. Counting e1 too would make it 2 — one place
    // off for every drop below the row's own position.
    expect(slotFor(150, 'breakfast', ROWS, 'e1')).toBe(1);
    expect(slotFor(150, 'breakfast', ROWS, 'l1')).toBe(2);
  });

  it('is the end of the meal below every row', async () => {
    expect(slotFor(999, 'breakfast', ROWS, 'l1')).toBe(3);
    expect(slotFor(999, 'breakfast', ROWS, 'e1')).toBe(2);
  });

  it('is 0 for a meal with no rows measured at all', async () => {
    expect(slotFor(350, 'dinner', ROWS, 'e1')).toBe(0);
    expect(slotFor(350, 'dinner', [], 'e1')).toBe(0);
  });

  it('counts only the target meal rows', async () => {
    // A finger inside lunch must not be told "index 3" because breakfast
    // happens to have three rows above it. l1 spans 210-230, midpoint 220.
    expect(slotFor(219, 'lunch', ROWS, 'e1')).toBe(0);
    expect(slotFor(221, 'lunch', ROWS, 'e1')).toBe(1);
  });

  it('does not depend on the order the rows were measured in', async () => {
    const shuffled = [ROWS[2], ROWS[0], ROWS[3], ROWS[1]];
    expect(slotFor(141, 'breakfast', shuffled, 'e3')).toBe(2);
    expect(slotFor(119, 'breakfast', shuffled, 'e3')).toBe(0);
  });
});

describe('useEntryDrag', () => {
  it('a drop on a DIFFERENT section reports a move, then clears', async () => {
    const { result, onDrop } = await setup();
    await act(() => result.current.start('e1', 'breakfast'));
    await settle();
    await act(() => result.current.move(250));
    expect(result.current.target).toBe('lunch');
    await act(() => result.current.end(250));
    // 250 is below lunch's only row (210-230, midpoint 220), so the row lands
    // AFTER it: slot 1, the end of lunch.
    expect(onDrop).toHaveBeenCalledWith('e1', 'breakfast', 'lunch', 1);
    expect(result.current.active).toBeNull();
    expect(result.current.target).toBeNull();
    expect(result.current.slot).toBeNull();
  });

  // N553 — this REPLACES N531's "a drop on the section it started in reports
  // nothing". It is the whole feature: a drop inside the row's own meal is now
  // a reorder, and reporting nothing is what the athlete complained about.
  // The no-op case moved down a level, to `plan()` in entryOrder.ts, which
  // returns no writes when the row lands where it already was.
  it('a drop inside the row own section reports a REORDER, with the slot', async () => {
    const { result, onDrop } = await setup();
    await act(() => result.current.start('e1', 'breakfast'));
    await settle();
    // Past e3's midpoint (160): the end of breakfast, which without e1 itself
    // is index 2.
    await act(() => result.current.move(165));
    expect(result.current.target).toBe('breakfast');
    expect(result.current.slot).toBe(2);
    await act(() => result.current.end(165));
    expect(onDrop).toHaveBeenCalledWith('e1', 'breakfast', 'breakfast', 2);
  });

  it('a drop over a card but over no ROW is the end of that meal', async () => {
    const { result, onDrop } = await setup();
    await act(() => result.current.start('l1', 'lunch'));
    await settle();
    // Below every breakfast row — the card's padding, its Add Food button.
    await act(() => result.current.end(190));
    expect(onDrop).toHaveBeenCalledWith('l1', 'lunch', 'breakfast', 3);
  });

  it('a drop OUTSIDE every section — the day pill, the summary — reports nothing', async () => {
    const { result, onDrop } = await setup();
    await act(() => result.current.start('e1', 'lunch'));
    await settle();
    await act(() => result.current.move(20));
    expect(result.current.target).toBeNull();
    expect(result.current.slot).toBeNull();
    await act(() => result.current.end(20));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('is inert while disabled (combine-select mode): start does nothing, so end cannot drop', async () => {
    const { result, onDrop, measure } = await setup({ enabled: false });
    await act(() => result.current.start('e1', 'breakfast'));
    await settle();
    expect(result.current.active).toBeNull();
    expect(measure).not.toHaveBeenCalled();
    await act(() => result.current.move(250));
    await act(() => result.current.end(250));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('lifting marks the entry active and lights its OWN section first', async () => {
    const { result } = await setup();
    await act(() => result.current.start('e1', 'dinner'));
    expect(result.current.active).toEqual({ id: 'e1', meal: 'dinner' });
    expect(result.current.target).toBe('dinner');
    // No SLOT yet, deliberately: the frames have not arrived, so there is no
    // honest answer to "where in it", and guessing one opens a gap under a
    // finger that has not moved.
    expect(result.current.slot).toBeNull();
  });

  it('measures at START, not at mount — frames are fresh for the drag they serve', async () => {
    const { result, measure } = await setup();
    expect(measure).not.toHaveBeenCalled();
    await act(() => result.current.start('e1', 'breakfast'));
    expect(measure).toHaveBeenCalledTimes(1);
    await settle();
  });

  it('a release before the measurement lands is a cancel, never a guessed move', async () => {
    // One resolver PER measure call, so the test can land the first drag's
    // measurement while the second's is still pending — the first draft of
    // this test kept one variable, resolved the SECOND drag's own frames, and
    // failed on a move that was in fact correct.
    const resolvers: ((f: Frames) => void)[] = [];
    const onDrop = jest.fn();
    const measure = jest.fn(() => new Promise<Frames>((r) => resolvers.push(r)));
    const { result } = await renderHook(() => useEntryDrag({ enabled: true, measure, onDrop }));
    await act(() => result.current.start('e1', 'breakfast'));
    await act(() => result.current.end(250)); // lunch, had the frames arrived
    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.active).toBeNull();
    // The late measurement must not arm the NEXT drag with stale frames:
    // start a second drag whose own measure is still pending, then let the
    // FIRST one resolve.
    await act(() => result.current.start('e2', 'snack'));
    expect(resolvers).toHaveLength(2);
    await act(async () => {
      resolvers[0](ALL);
      await Promise.resolve();
    });
    await act(() => result.current.end(250));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('cancel clears without dropping', async () => {
    const { result, onDrop } = await setup();
    await act(() => result.current.start('e1', 'breakfast'));
    await settle();
    await act(() => result.current.move(250));
    await act(() => result.current.cancel());
    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.active).toBeNull();
    expect(result.current.target).toBeNull();
  });

  it('move and end are no-ops with nothing lifted', async () => {
    const { result, onDrop } = await setup();
    await act(() => result.current.move(250));
    expect(result.current.target).toBeNull();
    await act(() => result.current.end(250));
    expect(onDrop).not.toHaveBeenCalled();
  });
});

/**
 * F44 — the drag's three haptic moments, and the one that must never fire.
 *
 * `move` is called from `onPanResponderMove`, which runs 60-120 times a second.
 * React bails out of an unchanged `setSlot`, so the RE-RENDER cost is per
 * crossing — but a haptic has no such bail-out. Fired unguarded there it is a
 * buzz per frame, and that is the single worst thing this change could ship.
 * These tests exist because "it felt fine when I dragged it once" cannot tell
 * the difference between one tap per crossing and one tap per frame on a
 * simulator with no haptics at all.
 */
describe('F44 — haptics', () => {
  // `jest.setup.js` mocks `expo-haptics` with plain arrows (there is no native
  // module under jest), so there is nothing to assert on until we spy. Spying
  // locally rather than making the global mock a `jest.fn()`: that file is
  // shared by every suite, and widening it for one test is how shared setup
  // accumulates.
  let impactSpy: jest.SpyInstance;
  let selectionSpy: jest.SpyInstance;

  const impact = () => impactSpy.mock.calls.length;
  const selection = () => selectionSpy.mock.calls.length;

  beforeEach(() => {
    impactSpy = jest.spyOn(Haptics, 'impactAsync').mockResolvedValue(undefined);
    selectionSpy = jest.spyOn(Haptics, 'selectionAsync').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('the lift is felt once, when the hold arms', async () => {
    const { result } = await setup();
    await act(() => result.current.start('e1', 'breakfast'));
    expect(impact()).toBe(1);
  });

  it('dragging within one slot is felt ONCE, not once per frame', async () => {
    const { result } = await setup();
    await act(() => result.current.start('e1', 'breakfast'));
    await settle();
    selectionSpy.mockClear();

    // Twenty frames of a finger that has not left the slot. A real drag sends
    // far more than twenty; this is the shape, not the volume.
    await act(() => {
      for (let i = 0; i < 20; i++) result.current.move(155);
    });
    expect(selection()).toBe(1);
  });

  it('each crossing is felt, and only on the crossing', async () => {
    const { result } = await setup();
    await act(() => result.current.start('e1', 'breakfast'));
    await settle();
    selectionSpy.mockClear();

    await act(() => {
      result.current.move(115); // breakfast, slot 0
      result.current.move(115); // same — silent
      result.current.move(165); // breakfast, a later slot
      result.current.move(250); // lunch
      result.current.move(250); // same — silent
    });
    expect(selection()).toBe(3);
  });

  it('a completed drop is felt', async () => {
    const { result } = await setup();
    await act(() => result.current.start('e1', 'breakfast'));
    await settle();
    impactSpy.mockClear();

    await act(() => result.current.end(250));
    expect(impact()).toBe(1);
  });

  it('a CANCELLED drag is felt exactly nothing', async () => {
    // The asymmetry that matters. `cancel` is also what `onPanResponderTerminate`
    // calls, and confirming a move that did not happen is worse than silence —
    // the athlete would feel the same tap for "moved" and "gave up".
    const { result } = await setup();
    await act(() => result.current.start('e1', 'breakfast'));
    await settle();
    impactSpy.mockClear();

    await act(() => result.current.cancel());
    expect(impact()).toBe(0);
  });

  it('a release with no frames is a cancel, and is silent', async () => {
    // The frames never arrived, so there is no honest drop target. `end` takes
    // the cancel path, and must feel like one.
    const measure = jest.fn(() => new Promise<Frames>(() => {}));
    const onDrop = jest.fn();
    const { result } = await renderHook(() =>
      useEntryDrag({ enabled: true, measure, onDrop }),
    );
    await act(() => result.current.start('e1', 'breakfast'));
    impactSpy.mockClear();

    await act(() => result.current.end(250));
    expect(onDrop).not.toHaveBeenCalled();
    expect(impact()).toBe(0);
  });
});
