import { StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon, type IconName } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';

/**
 * One technique on a roadmap, built on `SessionCard`'s bones.
 *
 * The first version of this row was a stack of labelled text — "Landed 0 / 25",
 * "Sessions 0 / 15", "Hit rate — / 40%" — three lines of it per technique,
 * fourteen techniques deep. Correct and unreadable: every row the same shape,
 * so finding the one you are close to finishing meant reading all of them.
 *
 * So it borrows what already works on Today and You. A rule down the left, a
 * disc, a name that leads, and the measures as chips with a glyph apiece —
 * which is exactly the argument `SessionCard`'s own comment makes about turning
 * a dot-separated string into separate slots.
 *
 * **Two deliberate departures from SessionCard, both because the list is
 * different:**
 *
 * 1. **The rule carries STATE, not discipline.** SessionCard moved the other
 *    way on purpose — its list is mixed, so "which of these was BJJ" is the
 *    question and completion is already marked elsewhere. Every row here is
 *    BJJ, so the rule is free, and "how far through am I" is the only question
 *    a roadmap raises.
 * 2. **The disc holds the step number, not a sport glyph.** A BJJ icon on
 *    fourteen consecutive BJJ rows is decoration. The ordinal is not: order is
 *    the content of a syllabus — someone put the retention before the sweep on
 *    purpose — and it is otherwise invisible.
 */

export type Criterion = {
  icon: IconName;
  /** Short: "12/25", "—/40%". Reads in a column, so keep the shape constant. */
  value: string;
  /** Cleared. Tints the chip rather than adding a second marker. */
  met: boolean;
  /** Spoken form, since "12/25" alone tells a screen reader nothing. */
  label: string;
};

export function TechniqueRow({
  step,
  name,
  position,
  category,
  notes,
  criteria,
  mastered,
  /**
   * Any evidence at all, from the caller's `progress` — NOT derived here.
   *
   * This started life as `criteria.some((c) => c.met)`, which is wrong in the
   * one case the column exists for: a criterion only turns `met` when it is
   * fully *cleared*, so an athlete at 24/25 landed and 14/15 sessions had none
   * met and drew the untouched rule — identical to a technique they had never
   * trained. That is a false claim about their record for the whole span from
   * first rep to first completed target, which is most of the journey, and it
   * left "which am I close to finishing?" unanswered exactly where the answer
   * was "this one".
   *
   * It cannot be fixed inside this component: chips carry only a `met`
   * boolean, so the partial counts are not here to read. Hence a prop.
   */
  started,
  /** Nothing to measure — an item that is reading rather than a roadmap step. */
  reading,
  tone,
  testID,
}: {
  step: number;
  name: string;
  position: string;
  category: string;
  notes: string;
  criteria: Criterion[];
  mastered: boolean;
  started: boolean;
  reading: boolean;
  /** The accent, passed in so this stays a dumb component. */
  tone: string;
  testID?: string;
}) {
  // Not started, in progress, done. `lineSoft` for untouched rather than the
  // accent at low opacity, because a faded accent reads as "done, dimly" and
  // the distinction between not-yet and nearly is the whole point of the
  // column.
  const rule = mastered ? tone : started ? vola.textMuted : vola.lineSoft;

  return (
    <RNView style={styles.card} testID={testID}>
      {/* testID unconditional: the rule is a pure-colour element with no text
          and no role, so a test has no other handle on the one thing it most
          needs to assert. */}
      <RNView style={[styles.rule, { backgroundColor: rule }]} testID="technique-rule" />

      {/*
        Labelled, and it has to be. `Icon` sets `accessible={false}` on every
        glyph by design, so the check is invisible to VoiceOver — and mastery
        is otherwise carried only by the rule colour and the chip tint, both
        equally invisible. The row this replaced had `MASTERED` as visible
        text, which was an accessibility element for free; dropping it for a
        glyph silently removed the only statement of the row's state. The
        unmastered branch needs the label too: a bare "3" announces as "3".
      */}
      <RNView
        style={[
          styles.disc,
          mastered && { backgroundColor: tone, borderColor: tone },
        ]}
        accessible
        accessibilityLabel={mastered ? 'Mastered' : `Step ${step}`}
      >
        {mastered ? (
          <Icon name="check" size={13} color={vola.bg} />
        ) : (
          <Text style={styles.discText}>{step}</Text>
        )}
      </RNView>

      <RNView style={styles.body}>
        <RNView style={styles.head}>
          <Text style={styles.eyebrow} numberOfLines={1}>
            {[position, category].filter(Boolean).join(' · ').toUpperCase()}
          </Text>
          <Text style={styles.name} numberOfLines={2}>
            {name}
          </Text>
        </RNView>

        {/*
          Unclamped. A two-line clamp looked tidy and cut real content: the
          longest curator note in `curricula.json` is 103 characters, roughly
          three lines at this width, and there is no expansion affordance to
          reach the rest. These are the one place the syllabus explains WHY a
          step is where it is — "you learned the early escape at white and the
          late one at blue" — so a clipped one is the sentence that made the
          order make sense, hidden.
        */}
        {notes !== '' && <Text style={styles.notes}>{notes}</Text>}

        {reading ? (
          <RNView style={styles.chipRow}>
            <RNView style={styles.chip}>
              <Icon name="search" size={12} color={vola.textDim} />
              <Text style={styles.chipText}>Something to study</Text>
            </RNView>
          </RNView>
        ) : (
          <RNView style={styles.chipRow}>
            {/* Keyed on position, not content. Today each of the four icons
                appears at most once, so `icon + value` cannot collide — but
                this row advertises reuse by anything with thresholds, and the
                first caller with two same-icon chips would get a silent
                collision. The list never reorders within a render. */}
            {criteria.map((c, i) => (
              <RNView key={`${c.icon}-${i}`} style={styles.chip}>
                <Icon
                  name={c.icon}
                  size={12}
                  color={c.met ? tone : vola.textDim}
                />
                <Text
                  style={[styles.chipText, c.met && { color: tone }]}
                  accessibilityLabel={c.label}
                >
                  {c.value}
                </Text>
              </RNView>
            ))}
          </RNView>
        )}
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.lineSoft,
    overflow: 'hidden',
  },
  rule: { width: 3, alignSelf: 'stretch' },
  disc: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
    marginTop: 13,
  },
  discText: {
    fontSize: 12,
    fontWeight: '700',
    color: vola.textMuted,
    fontVariant: ['tabular-nums'],
  },
  body: { flex: 1, paddingHorizontal: 12, paddingVertical: 11, gap: 7 },
  head: { gap: 1 },
  eyebrow: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.9,
    color: vola.textDim,
  },
  name: { fontSize: 15, fontWeight: '700' },
  notes: { fontSize: 12, lineHeight: 16, color: vola.textMuted },
  // Wraps rather than scrolls: four chips will not fit one line at large text
  // sizes, and a clipped criterion is a number the athlete cannot check.
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: vola.textMuted,
    fontVariant: ['tabular-nums'],
  },
});
