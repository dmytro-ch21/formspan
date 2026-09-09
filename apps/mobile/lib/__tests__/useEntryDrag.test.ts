/**
 * N531/#962 — the drop decision behind the food day view's drag, without a
 * gesture. `useEntryDrag`'s own doc comment says why it is a hook rather
 * than logic inside a row: so THIS file can hand it four rectangles and ask
 * what `onDrop` was told.
 */
import { act, renderHook } from '@testing-library/react-native';

import { dropTargetFor, useEntryDrag, type SectionFrame } from '../useEntryDrag';

const FRAMES: SectionFrame[] = [
  { meal: 'breakfast', top: 100, bottom: 200 },
  { meal: 'lunch', top: 200, bottom: 300 },
  { meal: 'dinner', top: 300, bottom: 400 },
  { meal: 'snack', top: 400, bottom: 500 },
];

describe('dropTargetFor', () => {
  it('names the section under the finger', () => {
    expect(dropTargetFor(150, FRAMES)).toBe('breakfast');
    expect(dropTargetFor(250, FRAMES)).toBe('lunch');
    expect(dropTargetFor(499, FRAMES)).toBe('snack');
  });

  it('is half-open, so a boundary pixel belongs to exactly one section', () => {
    expect(dropTargetFor(200, FRAMES)).toBe('lunch');
    expect(dropTargetFor(300, FRAMES)).toBe('dinner');
  });

  it('is null above, below and between the cards — never "the nearest"', () => {
    expect(dropTargetFor(50, FRAMES)).toBeNull();
    expect(dropTargetFor(500, FRAMES)).toBeNull();
    expect(dropTargetFor(250, [FRAMES[0], FRAMES[2]])).toBeNull();
  });

  it('is null with nothing measured', () => {
    expect(dropTargetFor(250, [])).toBeNull();
  });
});

function setup(over: { enabled?: boolean; frames?: SectionFrame[] } = {}) {
  const onDrop = jest.fn();
  const measure = jest.fn(async () => over.frames ?? FRAMES);
  const hook = renderHook(
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

describe('useEntryDrag', () => {
  it('a drop on a DIFFERENT section reports a move, then clears', async () => {
    const { result, onDrop } = setup();
    act(() => result.current.start('e1', 'breakfast'));
    await settle();
    act(() => result.current.move(250));
    expect(result.current.target).toBe('lunch');
    act(() => result.current.end(250));
    expect(onDrop).toHaveBeenCalledWith('e1', 'breakfast', 'lunch');
    expect(result.current.active).toBeNull();
    expect(result.current.target).toBeNull();
  });

  it('a drop on the section it started in reports nothing', async () => {
    const { result, onDrop } = setup();
    act(() => result.current.start('e1', 'breakfast'));
    await settle();
    act(() => result.current.move(150));
    act(() => result.current.end(150));
    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.active).toBeNull();
  });

  it('a drop OUTSIDE every section — the day pill, the summary — reports nothing', async () => {
    const { result, onDrop } = setup();
    act(() => result.current.start('e1', 'lunch'));
    await settle();
    act(() => result.current.move(20));
    expect(result.current.target).toBeNull();
    act(() => result.current.end(20));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('is inert while disabled (combine-select mode): start does nothing, so end cannot drop', async () => {
    const { result, onDrop, measure } = setup({ enabled: false });
    act(() => result.current.start('e1', 'breakfast'));
    await settle();
    expect(result.current.active).toBeNull();
    expect(measure).not.toHaveBeenCalled();
    act(() => result.current.move(250));
    act(() => result.current.end(250));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('lifting marks the entry active and lights its OWN section first', () => {
    const { result } = setup();
    act(() => result.current.start('e1', 'dinner'));
    expect(result.current.active).toEqual({ id: 'e1', meal: 'dinner' });
    expect(result.current.target).toBe('dinner');
  });

  it('measures at START, not at mount — frames are fresh for the drag they serve', async () => {
    const { result, measure } = setup();
    expect(measure).not.toHaveBeenCalled();
    act(() => result.current.start('e1', 'breakfast'));
    expect(measure).toHaveBeenCalledTimes(1);
    await settle();
  });

  it('a release before the measurement lands is a cancel, never a guessed move', async () => {
    // One resolver PER measure call, so the test can land the first drag's
    // measurement while the second's is still pending — the first draft of
    // this test kept one variable, resolved the SECOND drag's own frames, and
    // failed on a move that was in fact correct.
    const resolvers: ((f: SectionFrame[]) => void)[] = [];
    const onDrop = jest.fn();
    const measure = jest.fn(() => new Promise<SectionFrame[]>((r) => resolvers.push(r)));
    const { result } = renderHook(() => useEntryDrag({ enabled: true, measure, onDrop }));
    act(() => result.current.start('e1', 'breakfast'));
    act(() => result.current.end(250)); // lunch, had the frames arrived
    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.active).toBeNull();
    // The late measurement must not arm the NEXT drag with stale frames:
    // start a second drag whose own measure is still pending, then let the
    // FIRST one resolve.
    act(() => result.current.start('e2', 'snack'));
    expect(resolvers).toHaveLength(2);
    await act(async () => {
      resolvers[0](FRAMES);
      await Promise.resolve();
    });
    act(() => result.current.end(250));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('cancel clears without dropping', async () => {
    const { result, onDrop } = setup();
    act(() => result.current.start('e1', 'breakfast'));
    await settle();
    act(() => result.current.move(250));
    act(() => result.current.cancel());
    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.active).toBeNull();
    expect(result.current.target).toBeNull();
  });

  it('move and end are no-ops with nothing lifted', () => {
    const { result, onDrop } = setup();
    act(() => result.current.move(250));
    expect(result.current.target).toBeNull();
    act(() => result.current.end(250));
    expect(onDrop).not.toHaveBeenCalled();
  });
});
