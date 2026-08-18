import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import type { GuideEntry } from '@/lib/setGuide';

/**
 * The set editor's option rows — collapsed to their answer, opened to change it.
 *
 * ## Why they collapse
 *
 * Expanding one set used to drop twelve chips onto the screen at once: six set
 * types and up to six grips, both permanently open, both flat. Two problems,
 * and the second is the real one.
 *
 * The first is height — twelve targets is most of a phone screen, so the fields
 * you actually came to edit get pushed under the keyboard.
 *
 * The second is that **an always-open list of equal-weight chips does not say
 * what is currently true.** The answer is in there, tinted, among eleven
 * alternatives. Collapsed, the row reads `TYPE  Working` — a statement — and
 * opening it is the deliberate act of changing that statement. This is the same
 * reason the set row itself collapses to `12 × 100lb`.
 *
 * Closed by default, including after a change: picking a type is a
 * decision that ends, and leaving the list open afterwards would put the
 * screen back in the state this exists to avoid. The selection is visible in
 * the header, so nothing is hidden by closing.
 *
 * ## Hold for what it means
 *
 * "Back-off", "AMRAP", "Hook" and "Angled" are jargon, and an athlete who does
 * not know them has no way to find out from inside the app — so the field goes
 * unrecorded, or worse, recorded wrongly. A long press on any pill opens its
 * entry from `lib/setGuide.ts`.
 *
 * **Long press is invisible, so it is announced twice.** Sighted athletes get
 * the hint line under an opened group. VoiceOver users get an
 * `accessibilityActions` entry on every pill, because a long press is not a
 * gesture the screen reader forwards — without the custom action the info
 * panel would be unreachable for exactly the people most likely to want a
 * definition read to them.
 *
 * ## Clearing
 *
 * `clearable` is per group rather than universal, and the asymmetry is real
 * rather than an oversight. A set ALWAYS has a type — `working` is the
 * default and there is no "no type" — so tapping the selected type again does
 * nothing. A grip is genuinely optional: unrecorded is a state, tapping the
 * selected grip returns to it, and that is the only route back.
 */

/**
 * The custom action that makes the info panel reachable under VoiceOver.
 *
 * Hoisted to a module constant rather than an inline literal so the array
 * identity is stable across renders — an inline one is a new prop on every
 * keystroke in the set's weight field, and this sits inside a row that
 * re-renders on every one of them.
 */
const INFO_ACTION = [{ name: 'info', label: 'What is this?' }];

export type PillOption = { key: string; label: string };

export function PillGroup({
  label,
  options,
  selected,
  onSelect,
  guideFor,
  clearable = false,
  emptyLabel = 'Not recorded',
  describe,
  context,
  testID,
}: {
  /** Shown in small caps at the head of the row — `TYPE`, `GRIP`. */
  label: string;
  options: PillOption[];
  selected: string | null;
  /** `null` only ever arrives when `clearable` — see the module note. */
  onSelect: (key: string | null) => void;
  guideFor: (key: string) => GuideEntry;
  clearable?: boolean;
  /** What the header says when nothing is selected. */
  emptyLabel?: string;
  /** The full spoken label for one pill — the screen knows the set and exercise. */
  describe: (option: PillOption) => string;
  /**
   * What this group is ABOUT, spoken — "set 2 of Back Squat".
   *
   * The header is the always-visible control, and it is identical on every set
   * of every exercise. Without this a VoiceOver user swiping a three-set
   * session hears "Type: Working" six times with nothing to tell the rows
   * apart, while the pills inside each group are fully labelled. Sighted users
   * get the context from position on screen; this is the equivalent.
   */
  context: string;
  testID?: string;
}) {
  const accent = useAccent();
  const [open, setOpen] = useState(false);
  // The entry survives the close so the card does not blank mid-fade;
  // `guideOpen` is what the modal's visibility keys on. See `GuideSheet`.
  const [guide, setGuide] = useState<GuideEntry | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const current = options.find((o) => o.key === selected);

  return (
    <RNView style={styles.group}>
      <Pressable
        style={styles.head}
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        // The header states the answer, so it has to SAY the answer — a
        // VoiceOver user who hears only "Type" has to open the group to learn
        // something a sighted user reads without touching anything.
        accessibilityLabel={`${label} for ${context}: ${current?.label ?? emptyLabel}`}
        accessibilityHint={open ? 'Collapses the options' : 'Opens the options'}
        accessibilityState={{ expanded: open }}
        hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
        testID={testID}
      >
        <Text style={styles.headLabel}>{label.toUpperCase()}</Text>
        <Text
          style={[
            styles.headValue,
            current ? { color: accent.ink } : styles.headValueEmpty,
          ]}
          numberOfLines={1}
        >
          {current?.label ?? emptyLabel}
        </Text>
        <Text style={styles.headChevron}>{open ? '⌃' : '⌄'}</Text>
      </Pressable>

      {open && (
        <RNView style={styles.pills}>
          {options.map((o) => {
            const on = o.key === selected;
            return (
              <Pressable
                key={o.key}
                onPress={() => {
                  onSelect(on && clearable ? null : o.key);
                  // Closing is the documented behaviour and was missing: the
                  // pick is a decision that ends, and a group left open puts
                  // the screen back into the wall of chips this replaced.
                  setOpen(false);
                }}
                onLongPress={() => {
                  setGuide(guideFor(o.key));
                  setGuideOpen(true);
                }}
                // Below the 500ms default: this is a reference lookup between
                // sets, not a destructive confirm, so it should not feel like
                // one. `HoldToConfirm` is the component that earns a long hold.
                delayLongPress={300}
                style={[
                  styles.pill,
                  on && { backgroundColor: accent.accent, borderColor: accent.accent },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={describe(o)}
                accessibilityHint={
                  on && clearable ? 'Tap again to clear it' : 'Hold for what it means'
                }
                accessibilityActions={INFO_ACTION}
                onAccessibilityAction={(e) => {
                  if (e.nativeEvent.actionName !== 'info') return;
                  setGuide(guideFor(o.key));
                  setGuideOpen(true);
                }}
                hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
                testID={testID ? `${testID}-${o.key}` : undefined}
              >
                <Text style={[styles.pillText, on && styles.pillTextOn]}>{o.label}</Text>
              </Pressable>
            );
          })}
          <Text style={styles.hint}>Hold one for what it means.</Text>
        </RNView>
      )}

      <GuideSheet entry={guide} visible={guideOpen} onClose={() => setGuideOpen(false)} />
    </RNView>
  );
}

/**
 * One pill that is simply on or off, with the same hold-for-info contract.
 *
 * Separate from `PillGroup` rather than a group of one, because a group of one
 * would render a header stating the answer above a single pill repeating it —
 * and it would collapse, hiding a switch behind a disclosure for no gain.
 */
export function TogglePill({
  label,
  on,
  onToggle,
  guide,
  accessibilityLabel,
  testID,
}: {
  label: string;
  on: boolean;
  onToggle: (next: boolean) => void;
  guide: GuideEntry;
  accessibilityLabel: string;
  testID?: string;
}) {
  const accent = useAccent();
  const [open, setOpen] = useState(false);

  return (
    <RNView style={styles.group}>
      <Pressable
        onPress={() => onToggle(!on)}
        onLongPress={() => setOpen(true)}
        delayLongPress={300}
        style={[
          styles.pill,
          styles.togglePill,
          on && { backgroundColor: accent.accent, borderColor: accent.accent },
        ]}
        // `switch`, not `button`: it has two states and VoiceOver should say
        // which one it is in rather than making the athlete infer it.
        accessibilityRole="switch"
        accessibilityState={{ checked: on }}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint="Hold for what it means"
        accessibilityActions={INFO_ACTION}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'info') setOpen(true);
        }}
        hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
        testID={testID}
      >
        <Text style={[styles.pillText, on && styles.pillTextOn]}>{label}</Text>
      </Pressable>

      <GuideSheet entry={guide} visible={open} onClose={() => setOpen(false)} />
    </RNView>
  );
}

/**
 * The definition itself — a panel, not a page.
 *
 * `transparent` and centred rather than the `pageSheet` the app uses elsewhere
 * (`PickSessionSheet`, `ShareToFriend`): those present a task with choices to
 * make, and this is two sentences you read and dismiss. A full sheet for a
 * definition loses the set you were editing behind it, mid-workout, for no
 * gain.
 *
 * The scrim is pressable, so the reflexive tap-outside dismisses it. `Done` is
 * kept as well, because a scrim is not a discoverable control and VoiceOver
 * has nothing to land on otherwise.
 */
function GuideSheet({
  entry,
  visible,
  onClose,
}: {
  /**
   * The definition to show — kept by the CALLER across a close.
   *
   * Visibility and content are two props rather than one nullable one, and
   * that separation fixes a real glitch: nulling the entry to close blanks the
   * card for the length of the fade, so the definition looks snatched away as
   * it leaves. The caller drops `visible` and holds `entry`, and the card
   * fades out still showing what it said.
   *
   * Kept in the caller's state rather than in a ref here: reading or writing a
   * ref during render is what `react-hooks/refs` forbids, and this app holds a
   * warning ratchet that the ref version broke by five.
   */
  entry: GuideEntry | null;
  visible: boolean;
  onClose: () => void;
}) {
  const accent = useAccent();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      {/*
        `accessible={false}` and NO role or label, and this is the finding that
        made the whole hold-for-info contract worth having.

        A `Pressable` is accessible by default, and on iOS an accessible view
        collapses its entire subtree into ONE element. With a role and a label
        on the scrim, a VoiceOver user who invoked "What is this?" got a sheet
        that announced itself as "Close, button" — the title, the definition and
        the Done button were not reachable, so the one control added FOR screen
        readers opened a panel screen readers could not read.

        Tap-outside survives for sighted users, because `onPress` does not need
        the view to be accessible. `Done` is the screen-reader dismissal and
        `onRequestClose` covers the system back gesture, so nothing is lost.
      */}
      <Pressable style={styles.scrim} onPress={onClose} accessible={false}>
        {/* Swallows the press, so a tap on the card itself does not dismiss
            what it is trying to read. `onStartShouldSetResponder` rather than a
            nested Pressable: this View must not announce itself as a control.
            No `accessibilityViewIsModal` — it hides a receiver's SIBLINGS, and
            this card has none; `Modal` already scopes VoiceOver to its window. */}
        <View
          style={styles.card}
          lightColor={vola.surfaceRaised}
          darkColor={vola.surfaceRaised}
          onStartShouldSetResponder={() => true}
        >
          <Text style={styles.cardTitle}>{entry?.title}</Text>
          <ScrollView>
            <Text style={styles.cardBody}>{entry?.body}</Text>
          </ScrollView>
          <Pressable
            onPress={onClose}
            style={styles.cardDone}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID="guide-close"
          >
            <Text style={[styles.cardDoneText, { color: accent.ink }]}>Done</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  group: { gap: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  headLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: vola.textDim,
    width: 38,
  },
  // Takes the slack so the chevron pins right and the two groups' chevrons
  // line up under each other.
  headValue: { flex: 1, fontSize: 13, fontWeight: '600' },
  headValueEmpty: { color: vola.textDim, fontWeight: '500' },
  headChevron: { fontSize: 13, color: vola.textDim },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  /*
    Smaller than the chips these replace — 12pt in a 999 pill rather than 13pt
    in a 10pt-radius box. They are secondary to the numbers above them and used
    once a set, so they should not compete with the weight field for attention.
    The pill shape is what distinguishes a value you pick from a value you type.
  */
  pill: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    minHeight: 32,
    justifyContent: 'center',
  },
  // A switch reads as heavier than one option among several, and it has no
  // header row to sit under.
  togglePill: { alignSelf: 'flex-start', paddingHorizontal: 14 },
  pillText: { fontSize: 12, fontWeight: '600', color: vola.textMuted },
  pillTextOn: { color: vola.navy },
  // Its own line under the wrap rather than beside the pills: `flexWrap` would
  // otherwise tuck it into whatever gap the last row happens to leave.
  hint: { width: '100%', fontSize: 11, color: vola.textDim },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(8,11,18,0.72)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: vola.line,
    padding: 20,
    gap: 12,
    maxHeight: '70%',
  },
  cardTitle: { fontSize: 18, fontWeight: '700' },
  cardBody: { fontSize: 14, lineHeight: 21, color: vola.textMuted },
  cardDone: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  cardDoneText: { fontSize: 15, fontWeight: '700' },
});
