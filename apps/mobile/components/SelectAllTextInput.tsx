import { useCallback, useState } from 'react';
import {
  TextInput,
  type NativeSyntheticEvent,
  type TextInputProps,
  type TextInputSelectionChangeEventData,
} from 'react-native';

/**
 * A `TextInput` that really does select its text when it opens.
 *
 * **`selectTextOnFocus` does not work alongside `autoFocus` on iOS, and it
 * fails silently.** Both rename fields in this app carried the pair, and both
 * opened with an unselected caret parked at the END of the existing name — so
 * typing appended instead of replacing. The user's own workout list carries the
 * evidence: a template called `Maestro Push DayPush A`, which is "Maestro Push
 * Day" with "Push A" typed onto the end by someone who believed they were
 * replacing it. Reproduced on an iPhone 15 Pro: tap the title, screenshot, no
 * selection highlight anywhere.
 *
 * The mechanism is an ordering race, which is why it reads as flaky rather than
 * broken: `selectTextOnFocus` is honoured in the native
 * `textFieldDidBeginEditing` callback, `autoFocus` begins editing during the
 * first mount, and RN then applies the `text`/`selection` props on the commit
 * that follows — collapsing the selection it just made.
 *
 * So the selection is stated as a prop instead of asked for as a behaviour.
 * A controlled `selection` is not racing anything: it is part of the same
 * commit as the text.
 *
 * **Control is handed back at the first sign the athlete wants the caret.**
 * A permanently controlled `selection` would fight every subsequent tap and
 * keystroke — the field would keep snapping back to select-all, which is worse
 * than the bug. `onChangeText` releases it (the common path: open, type,
 * replaced), and so does any selection change that is not the one we asked for
 * (tap to place the caret, drag to select a word). The one we asked for is
 * ignored, because RN reports our own selection back to us and treating that as
 * user intent would release before the selection ever took effect.
 *
 * Deliberately not a hook: the state has to be created when the field OPENS,
 * and both callers render the field only while renaming, so mounting is that
 * moment. A hook called from the screen would live across every open and close
 * and would need its own "was it open" bookkeeping to notice.
 *
 * keyboard-container: provided by parent — this is a leaf input with no scroll
 * container of its own, and it has no business acquiring one. Both call sites
 * are already inside a `KeyboardAwareScrollView` (`app/workout/[id].tsx` and
 * `app/bjj/session/[id].tsx`), which is where the container belongs: it has to
 * wrap the whole screen to scroll it, and a container around one field would
 * scroll nothing. Stated here rather than in an exemption list, per
 * `keyboardCoverage.test.ts` — an exemption nobody can see is how a rule
 * quietly stops applying.
 */

type Range = { start: number; end: number };

/** The whole of a value, as a selection range. */
export function selectAllRange(value: string): Range {
  return { start: 0, end: value.length };
}

/**
 * Is this selection still the one we asked for?
 *
 * The guard that stops the field releasing control the instant it takes it —
 * RN echoes a controlled `selection` back through `onSelectionChange`, so
 * "anything reported means the user moved it" would defeat the whole component
 * on its first frame.
 */
export function isAskedFor(asked: Range, reported: Range): boolean {
  return asked.start === reported.start && asked.end === reported.end;
}

export function SelectAllTextInput({
  value,
  onChangeText,
  onSelectionChange,
  ...props
}: /* `selection` omitted: this component owns it, and a caller passing one
      would be silently discarded by the explicit prop below. A compile error
      is the honest answer — the whole point here is that the selection is
      stated in exactly one place. */
Omit<TextInputProps, 'selection'>) {
  // Lazy initialiser, so the range is the value the field opened with rather
  // than whatever it holds on a later render.
  const [selection, setSelection] = useState<Range | undefined>(() => selectAllRange(value ?? ''));

  const handleSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      const reported = e.nativeEvent.selection;
      setSelection((asked) => (asked && isAskedFor(asked, reported) ? asked : undefined));
      onSelectionChange?.(e);
    },
    [onSelectionChange],
  );

  const handleChangeText = useCallback(
    (text: string) => {
      setSelection(undefined);
      onChangeText?.(text);
    },
    [onChangeText],
  );

  return (
    <TextInput
      {...props}
      value={value}
      selection={selection}
      onChangeText={handleChangeText}
      onSelectionChange={handleSelectionChange}
    />
  );
}
