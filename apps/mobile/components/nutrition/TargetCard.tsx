import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { ConfidenceBlock } from '@/components/nutrition/ConfidenceBlock';
import { MacroTiles } from '@/components/nutrition/MacroTiles';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import type { Confidence } from '@/lib/confidence';
import type { MacroRow } from '@/lib/macroModel';

/**
 * The authority card — what you are eating to, and how much to trust it.
 *
 * **It comes first because it is the only thing on this screen that is
 * settled.** Everything below is a proposal: a derivation, a weekly correction,
 * a number you might type. With three sources on one screen, the figure
 * actually in force has to be unmistakable and has to say where it came from —
 * a suggestion sitting under a heading like "Your target" is a number nobody
 * chose being read as the number in force.
 *
 * ## Three states, and none of them may be faked
 *
 *  - **unknown** — the read failed or has not finished. It says so. It must
 *    never render as "no target yet", which would tell an athlete who set one
 *    last week to go and set it again.
 *  - **none** — read fine, genuinely nothing set. The card inverts: the big
 *    figure becomes the *suggestion*, clearly labelled as one, because an
 *    athlete with no target is exactly who the screen is for and a card
 *    reading `—` at the top of it says nothing useful.
 *  - **set** — the number, the date it took effect, and its provenance.
 *
 * The provenance line is not decoration. A derived target has an explanation
 * below and a typed one does not, so saying which is what stops the ladder
 * being read as the working behind a number it had nothing to do with.
 *
 * ## `Edit target` is the manual path, and that is the reference's own mapping
 *
 * The reference puts a pencil pill in this card's top right. Typing your own
 * number is the one action that belongs there: it is the way to *disagree with
 * this figure*, which is what an edit affordance beside a figure means. It used
 * to live at the bottom of the screen under its own section heading, four
 * viewports below the number it argues with.
 */
export function TargetCard({
  date,
  kcal,
  /** True when `kcal` is what is in force; false when it is only a proposal. */
  inForce,
  /** "worked out below", "you typed this one" — null when nothing is in force. */
  provenance,
  /** Null while the live row is still unknown, which is NOT the same as none. */
  known,
  from,
  rows,
  confidence,
  onEdit,
}: {
  date: string;
  kcal: number | null;
  inForce: boolean;
  provenance: string | null;
  known: boolean;
  from: string | null;
  rows: readonly MacroRow[];
  /** Null when the fortnight could not be read at all. */
  confidence: Confidence | null;
  onEdit: () => void;
}) {
  const accent = useAccent();

  return (
    <RNView style={styles.card} testID="target-card">
      <RNView style={styles.head}>
        <RNView style={styles.headMain}>
          <Text style={styles.eyebrow}>{`TODAY · ${date}`}</Text>
          <Text style={styles.lead}>
            {!known
              ? 'Could not read your target'
              : inForce
                ? "You're eating to"
                : 'We suggest'}
          </Text>
          {/*
            **An em dash is not a placeholder at 38pt.** Rendered at the figure's
            own size it is a 24pt-wide solid white bar — measured on a device,
            and it reads as a loading skeleton or a redaction, not as "we do not
            have this yet". So the absent state gets its own words at its own
            size rather than the figure's typography with no figure in it.
          */}
          {kcal == null ? (
            <Text style={styles.kcalNone} testID="target-kcal">
              Not worked out yet
            </Text>
          ) : (
            <Text
              style={styles.kcal}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
              testID="target-kcal"
            >
              {`${kcal} kcal`}
            </Text>
          )}
        </RNView>

        <Pressable
          onPress={onEdit}
          style={styles.edit}
          accessibilityRole="button"
          accessibilityLabel="Edit target — type your own number"
          testID="target-edit"
        >
          <Icon name="pencil" size={13} color={accent.ink} />
          <Text style={[styles.editText, { color: accent.ink }]}>Edit target</Text>
        </Pressable>
      </RNView>

      {/*
        The one line that says whether the big number above is a decision or a
        proposal. Rendered in every state, including the unreadable one — a card
        whose provenance line is simply absent reads as a target with no
        history, which is a claim.
      */}
      {/*
        The testID names the STATE, not the element. Three states that must
        never be collapsed deserve three assertable names — one shared id would
        let "could not read it" be rendered as "you have none" with every test
        still green, which is precisely the substitution this line exists to
        prevent.
      */}
      <Text
        style={styles.note}
        testID={`target-provenance-${!known ? 'unknown' : inForce ? 'set' : 'none'}`}
      >
        {!known
          ? 'That lives on the server, and it could not be reached. The workings below still add up.'
          : inForce
            ? `In force from ${from}${provenance ? ` · ${provenance}` : ''}`
            : 'No target set yet. Nothing below is saved until you accept it.'}
      </Text>

      <MacroTiles rows={rows} testID="target-macro-tiles" />

      {confidence ? (
        <>
          <RNView style={styles.rule} />
          <ConfidenceBlock c={confidence} />
        </>
      ) : null}
    </RNView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: vola.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: vola.line,
    padding: 14,
    gap: 10,
  },
  // `flex-start` rather than `center`: the pill has to stay level with the
  // eyebrow while the figure below it grows, and centring makes it drift down
  // the card as the text size rises.
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headMain: { flex: 1, gap: 1, minWidth: 0 },
  eyebrow: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.1,
    color: vola.textDim,
  },
  lead: { fontSize: 15, fontWeight: '600', color: vola.text, marginTop: 3 },
  kcal: {
    fontSize: 38,
    fontWeight: '800',
    color: vola.text,
    fontVariant: ['tabular-nums'],
    lineHeight: 44,
  },
  kcalNone: { fontSize: 20, fontWeight: '700', color: vola.textDim, lineHeight: 26, marginTop: 2 },
  edit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
    // Without this the pill wraps its own label onto two lines at accessibility
    // sizes and pushes past the card's border — the failure #484 measured on
    // `TrendCard` (#491), avoided here rather than reproduced.
    flexShrink: 1,
  },
  editText: { fontSize: 12, fontWeight: '700', flexShrink: 1 },
  note: { fontSize: 11, color: vola.textDim, lineHeight: 16 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: vola.line, marginTop: 2 },
});
