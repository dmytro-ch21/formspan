import { useRef, useState } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View as RNView,
} from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import type { GuideEntry } from '@/lib/setGuide';

/**
 * A compact "what is this set" control — a label, its current answer, and a
 * list that opens OVER it.
 *
 * ## Why not a row that expands in place
 *
 * The first version of this collapsed each group to a header and expanded the
 * options inline, stacked one above the other. Two problems, and the second is
 * the one that matters. Stacked, `Type` and `Grip` cost two full rows of a set
 * editor that already carries four fields — and neither is a thing you read,
 * they are two short answers that belong side by side. And expanding in place
 * *pushes the rest of the editor down*, so opening `Type` moves `Grip`, the
 * remove control and everything below it under your thumb mid-tap.
 *
 * A popover costs no layout at all. The editor never reflows, the list appears
 * over the control that owns it, and the two selects sit on ONE line where they
 * read as a pair of small answers rather than a pair of sections.
 *
 * ## Anchoring
 *
 * Measured with `measureInWindow` at press time rather than laid out relative to
 * the control, because a `Modal` renders in its own window and knows nothing
 * about the tree it was opened from. The card prefers to sit below its control
 * and flips above when there is not room, which on a set editor near the bottom
 * of a long session is the common case rather than the exotic one.
 *
 * ## Hold for what it means, without a second modal
 *
 * Long-pressing an option swaps this card's CONTENT to that option's
 * definition, rather than opening a sheet on top of a sheet — stacked modals on
 * iOS are a reliable way to get one of them stuck. `Back` returns to the list,
 * so reading a definition never costs you the selection you were about to make.
 */

/**
 * The custom action that makes the definitions reachable under VoiceOver.
 *
 * Hoisted so the array identity is stable across renders. A long press is not a
 * gesture the screen reader forwards, so without this the definitions would be
 * unreachable for exactly the people most likely to want one read aloud.
 */
const INFO_ACTION = [{ name: 'info', label: 'What is this?' }];

/** Enough room to be worth opening downward; otherwise the card flips up. */
const POPOVER_MIN_SPACE = 260;
/** Never taller than this, however much room there is — a menu, not a page. */
const CARD_MAX_HEIGHT = 320;
/** Never shorter than this; below it the list is unusable and should scroll. */
const CARD_MIN_HEIGHT = 132;
/** Breathing room from the screen edge the card opens toward. */
const SCREEN_INSET = 16;
/** Gap between the card and the control it belongs to. */
const ANCHOR_GAP = 6;

export type SelectOption = { key: string; label: string };

type Anchor = { x: number; y: number; width: number; height: number };

export function OptionSelect({
  label,
  options,
  selected,
  onSelect,
  guideFor,
  clearable = false,
  emptyLabel = 'Not recorded',
  context,
  testID,
}: {
  /** Shown small above the answer — `TYPE`, `GRIP`. */
  label: string;
  options: SelectOption[];
  selected: string | null;
  /** `null` only ever arrives when `clearable`. */
  onSelect: (key: string | null) => void;
  guideFor: (key: string) => GuideEntry;
  /**
   * Whether picking the selected option again clears it.
   *
   * Per control rather than universal, and the asymmetry is real: a set ALWAYS
   * has a type (`working` is the default and there is no "no type"), while a
   * grip is genuinely optional — unrecorded is a state, and re-picking the
   * selected grip is the only route back to it.
   */
  clearable?: boolean;
  emptyLabel?: string;
  /** What this control is about, spoken — "set 2 of Back Squat". */
  context: string;
  testID?: string;
}) {
  const accent = useAccent();
  const ref = useRef<RNView>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [guide, setGuide] = useState<GuideEntry | null>(null);

  const current = options.find((o) => o.key === selected);

  function open() {
    // Measured at press time: a Modal renders in its own window, so the card
    // cannot be positioned relative to a tree it is not inside.
    ref.current?.measureInWindow((x, y, width, height) => {
      setGuide(null);
      setAnchor({ x, y, width, height });
    });
  }

  return (
    <RNView ref={ref} style={styles.field} collapsable={false}>
      <Pressable
        style={styles.control}
        onPress={open}
        accessibilityRole="button"
        // States the answer, because the control does: a VoiceOver user who
        // hears only "Type" has to open it to learn what a sighted user reads
        // without touching anything.
        accessibilityLabel={`${label} for ${context}: ${current?.label ?? emptyLabel}`}
        accessibilityHint="Opens the options"
        accessibilityState={{ expanded: anchor !== null }}
        testID={testID}
      >
        <Text style={styles.label}>{label.toUpperCase()}</Text>
        <RNView style={styles.valueRow}>
          <Text
            style={[styles.value, current ? { color: accent.ink } : styles.valueEmpty]}
            numberOfLines={1}
          >
            {current?.label ?? emptyLabel}
          </Text>
          <Text style={styles.chevron}>⌄</Text>
        </RNView>
      </Pressable>

      <Popover
        anchor={anchor}
        onClose={() => setAnchor(null)}
        title={label}
        guide={guide}
        onBack={() => setGuide(null)}
      >
        {options.map((o) => {
          const on = o.key === selected;
          return (
            <Pressable
              key={o.key}
              onPress={() => {
                onSelect(on && clearable ? null : o.key);
                // Closing is the point: a pick is a decision that ends, and a
                // list left open over the editor is a list you have to dismiss.
                setAnchor(null);
              }}
              onLongPress={() => setGuide(guideFor(o.key))}
              // Below the 500ms default: this is a reference lookup between
              // sets, not a destructive confirm, so it should not feel like one.
              delayLongPress={300}
              style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              // No ", selected" suffix: `accessibilityState` already announces
              // it, and the hint below carries what selecting again would do.
              accessibilityLabel={o.label}
              accessibilityHint={
                on && clearable ? 'Pick again to clear it' : 'Hold for what it means'
              }
              accessibilityActions={INFO_ACTION}
              onAccessibilityAction={(e) => {
                if (e.nativeEvent.actionName !== 'info') return;
                setGuide(guideFor(o.key));
              }}
              testID={testID ? `${testID}-${o.key}` : undefined}
            >
              <Text style={[styles.optionText, on && { color: accent.ink, fontWeight: '700' }]}>
                {o.label}
              </Text>
              {on && <Text style={[styles.tick, { color: accent.ink }]}>✓</Text>}
            </Pressable>
          );
        })}
        <Text style={styles.hint}>Hold one for what it means.</Text>
      </Popover>
    </RNView>
  );
}

/**
 * The card itself — anchored, dismissible, and never two modals deep.
 *
 * `guide` is what turns this from a list into a definition; the caller keeps it
 * so returning to the list costs nothing and so the card never blanks.
 */
function Popover({
  anchor,
  onClose,
  title,
  guide,
  onBack,
  children,
}: {
  anchor: Anchor | null;
  onClose: () => void;
  title: string;
  guide: GuideEntry | null;
  onBack: () => void;
  children: React.ReactNode;
}) {
  const accent = useAccent();
  const screen = Dimensions.get('window');

  /*
    Which side, and how tall — and the height half is the part that was missing.

    The first version chose a side and stopped, trusting `maxHeight: 320` to be
    small enough. It is not: the Type list is six 44pt options plus padding and
    the hint, about 305pt, so any anchor with 261–305pt below it opened DOWNWARD
    and rendered its own foot off the bottom of the screen — "To failure" clipped
    into the home-indicator zone and the hint gone entirely. A continuous band
    the athlete scrolls through on every session, not an edge case.

    Raising the threshold does not fix it, it moves it: flip up too eagerly on a
    short screen and the card clips at the TOP instead, because a mid-screen
    anchor there has less than a full card's height on either side.

    So the side is a preference and the height is a measurement. The card is
    clamped to the room it actually has, and its inner `ScrollView` takes over
    when that is less than the content — which is the one outcome that is
    correct on every screen size, at every scroll position, in both modes.
  */
  const spaceBelow = anchor
    ? screen.height - (anchor.y + anchor.height) - ANCHOR_GAP - SCREEN_INSET
    : 0;
  const spaceAbove = anchor ? anchor.y - ANCHOR_GAP - SCREEN_INSET : 0;
  // Below when it is genuinely roomy; otherwise whichever side has more, so a
  // cramped screen still picks the better of two bad options rather than a
  // fixed one.
  const below = spaceBelow >= POPOVER_MIN_SPACE || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(
    CARD_MIN_HEIGHT,
    Math.min(CARD_MAX_HEIGHT, below ? spaceBelow : spaceAbove),
  );
  const position = anchor
    ? {
        // Clamped so a control near the right edge does not push the card off.
        left: Math.max(8, Math.min(anchor.x, screen.width - CARD_WIDTH - 8)),
        maxHeight,
        ...(below
          ? { top: anchor.y + anchor.height + ANCHOR_GAP }
          : { bottom: screen.height - anchor.y + ANCHOR_GAP }),
      }
    : {};

  return (
    <Modal
      visible={anchor !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      {/*
        `accessible={false}` and no role or label. A `Pressable` is accessible by
        default, and on iOS an accessible view collapses its whole subtree into
        ONE element — which would announce this entire card as "Close, button"
        and make the options and the definitions unreachable, defeating the
        custom action that exists for exactly those users. Tap-to-dismiss does
        not need the view to be accessible.
      */}
      <Pressable style={styles.scrim} onPress={onClose} accessible={false}>
        <View
          style={[styles.card, position]}
          lightColor={vola.surfaceRaised}
          darkColor={vola.surfaceRaised}
          // Swallows the press so a tap on the card does not dismiss what it is
          // trying to read. Not a Pressable: this must not announce as a control.
          onStartShouldSetResponder={() => true}
          /*
            The screen-reader exit, and without it this card had none that did
            not CHANGE something.

            The scrim is `accessible={false}` — correctly, or it would collapse
            the whole card into one element — but that also removes it as a
            dismiss target, and there is no close button. `onRequestClose` is
            Android's back gesture only. So a VoiceOver user's every way out ran
            through an option, and on the clearable Grip control the one that
            looks least destructive — re-picking the grip already selected — is
            the one that CLEARS it. Two-finger Z now closes with nothing
            recorded. Raised in review; VoiceOver is the part of this component
            that has never been exercised on a device.
          */
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
        >
          {/*
            The title renders in BOTH modes, not just for a definition. In list
            mode it is the only thing saying whether this menu is Type or Grip —
            a sighted user carries that over from the control they just tapped,
            and a screen-reader user landing inside a modal has nothing.
          */}
          {guide ? (
            <>
              <Text style={styles.cardTitle}>{guide.title}</Text>
              <ScrollView>
                <Text style={styles.cardBody}>{guide.body}</Text>
              </ScrollView>
              <Pressable
                onPress={onBack}
                style={styles.back}
                accessibilityRole="button"
                accessibilityLabel={`Back to ${title.toLowerCase()} options`}
                testID="guide-back"
              >
                <Text style={[styles.backText, { color: accent.ink }]}>‹ Back</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.cardLabel}>{title.toUpperCase()}</Text>
              <ScrollView>{children}</ScrollView>
            </>
          )}
        </View>
      </Pressable>
    </Modal>
  );
}

/** Wide enough for the longest option, narrow enough to read as a menu. */
const CARD_WIDTH = 200;

const styles = StyleSheet.create({
  // Both selects share the row evenly. `minWidth: 0` is what lets a long value
  // ellipsize instead of forcing the pair wider than the screen.
  field: { flex: 1, minWidth: 0 },
  control: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 48,
    justifyContent: 'center',
    gap: 2,
  },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, color: vola.textDim },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  value: { flex: 1, fontSize: 14, fontWeight: '600' },
  valueEmpty: { color: vola.textDim, fontWeight: '500' },
  chevron: { fontSize: 12, color: vola.textDim },
  scrim: { flex: 1, backgroundColor: 'rgba(8,11,18,0.45)' },
  card: {
    position: 'absolute',
    width: CARD_WIDTH,
    maxHeight: 320,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
    paddingVertical: 6,
    paddingHorizontal: 6,
    // A menu floating over content needs to read as floating; the border alone
    // does not do it on a dark ground.
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  optionPressed: { backgroundColor: vola.surface },
  optionText: { flex: 1, fontSize: 14, fontWeight: '600', color: vola.text },
  tick: { fontSize: 14, fontWeight: '700' },
  hint: { fontSize: 11, color: vola.textDim, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 4 },
  cardTitle: { fontSize: 15, fontWeight: '700', paddingHorizontal: 10, paddingTop: 8 },
  cardLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: vola.textDim,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 2,
  },
  cardBody: { fontSize: 13, lineHeight: 19, color: vola.textMuted, paddingHorizontal: 10, paddingTop: 6 },
  back: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 },
  backText: { fontSize: 14, fontWeight: '700' },
});
