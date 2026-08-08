import { configure, fireEvent, render, screen } from '@testing-library/react-native';

import { SelectAllTextInput, isAskedFor, selectAllRange } from '../SelectAllTextInput';

/**
 * Renaming replaces the name instead of appending to it.
 *
 * The bug: `selectTextOnFocus` alongside `autoFocus` silently does nothing on
 * iOS, so both rename fields opened with an unselected caret at the END of the
 * existing name and typing appended. The evidence is in the user's own data —
 * a template called `Maestro Push DayPush A`, which is "Maestro Push Day" with
 * "Push A" typed onto the end by someone who meant to replace it.
 *
 * ## What this file proves, precisely
 *
 * That the field **opens** with the whole value selected, and that it hands
 * control back the moment the athlete does anything that implies a caret.
 * Those are the two ways this component can be wrong, and they pull against
 * each other: never releasing makes the field snap back to select-all on every
 * keystroke, which is worse than the bug it fixes.
 *
 * **What it cannot prove:** that iOS honours a controlled `selection` where it
 * ignored `selectTextOnFocus`. There is no native text engine here — RNTL
 * records the prop and never applies it — so the *fix's premise* is only
 * checkable on a device. The regression this file guards is a future edit that
 * stops asking, or starts releasing too eagerly, and either would ship
 * invisibly without it.
 */

jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 10_000 });

const ID = 'rename';

/** The selection prop as the native side would receive it. */
function selectionOn(testID: string): unknown {
  return screen.getByTestId(testID).props.selection;
}

/** RNTL has no selection engine, so the native echo is synthesised. */
function reportSelection(testID: string, start: number, end: number) {
  fireEvent(screen.getByTestId(testID), 'selectionChange', {
    nativeEvent: { selection: { start, end } },
  });
}

describe('selectAllRange', () => {
  it('covers the whole value', () => {
    expect(selectAllRange('Maestro Push Day')).toEqual({ start: 0, end: 16 });
  });

  it('is an empty range for an empty value, not a null', () => {
    // A new workout opens its rename field on a blank name. Selecting nothing
    // is correct; returning undefined would make the field uncontrolled and
    // quietly reintroduce the caret-at-end behaviour for that one case.
    expect(selectAllRange('')).toEqual({ start: 0, end: 0 });
  });
});

describe('isAskedFor', () => {
  it('recognises the selection we set', () => {
    expect(isAskedFor({ start: 0, end: 16 }, { start: 0, end: 16 })).toBe(true);
  });

  it('rejects a caret the athlete placed', () => {
    expect(isAskedFor({ start: 0, end: 16 }, { start: 4, end: 4 })).toBe(false);
  });

  it('rejects a shorter selection that shares its start', () => {
    // A drag from the same origin. Comparing only `start` would call this ours
    // and keep fighting the athlete's drag.
    expect(isAskedFor({ start: 0, end: 16 }, { start: 0, end: 7 })).toBe(false);
  });
});

describe('the rename field', () => {
  it('opens with the whole name selected', () => {
    render(<SelectAllTextInput testID={ID} value="Maestro Push Day" />);

    expect(selectionOn(ID)).toEqual({ start: 0, end: 16 });
  });

  /**
   * The failure mode that would defeat the fix on its first frame.
   *
   * RN echoes a controlled `selection` back through `onSelectionChange`. A
   * component that treated any reported selection as user intent would release
   * control before the selection ever took effect — and would do it invisibly,
   * because the prop was still set for one render.
   */
  it('keeps the selection when the platform echoes it back', () => {
    render(<SelectAllTextInput testID={ID} value="Maestro Push Day" />);

    reportSelection(ID, 0, 16);

    expect(selectionOn(ID)).toEqual({ start: 0, end: 16 });
  });

  it('hands control back when the athlete places a caret', () => {
    render(<SelectAllTextInput testID={ID} value="Maestro Push Day" />);

    reportSelection(ID, 4, 4);

    expect(selectionOn(ID)).toBeUndefined();
  });

  it('hands control back on the first keystroke', () => {
    render(<SelectAllTextInput testID={ID} value="Maestro Push Day" />);

    fireEvent.changeText(screen.getByTestId(ID), 'Push A');

    expect(selectionOn(ID)).toBeUndefined();
  });

  it('stays released once released', () => {
    // Guards the obvious wrong shape — recomputing the range from `value` on
    // every render, which would re-select everything after each keystroke.
    const view = render(<SelectAllTextInput testID={ID} value="Maestro Push Day" />);

    fireEvent.changeText(screen.getByTestId(ID), 'P');
    view.rerender(<SelectAllTextInput testID={ID} value="P" />);

    expect(selectionOn(ID)).toBeUndefined();
  });

  it('still forwards the caller and its props through', () => {
    const onChangeText = jest.fn();
    render(
      <SelectAllTextInput
        testID={ID}
        value="Maestro Push Day"
        onChangeText={onChangeText}
        accessibilityLabel="Workout name"
        maxLength={120}
      />,
    );

    fireEvent.changeText(screen.getByTestId(ID), 'Push A');

    expect(onChangeText).toHaveBeenCalledWith('Push A');
    expect(screen.getByTestId(ID).props.maxLength).toBe(120);
    expect(screen.getByTestId(ID).props.accessibilityLabel).toBe('Workout name');
  });
});
