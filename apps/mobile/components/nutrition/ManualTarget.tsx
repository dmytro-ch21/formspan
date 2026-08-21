/**
 * Type your own target.
 *
 * The action that answers the derivation above it. An athlete working with a
 * coach has a number from a person and no interest in our arithmetic; an
 * athlete who simply disagrees with 2,700 needs somewhere to say 2,400. Until
 * this existed, both had to open a laptop.
 *
 * ## Prefilled, because five fields on a number pad is not "manageable on a
 * phone"
 *
 * The form opens on whatever is already in force — or on the suggestion when
 * nothing is — so the common act is EDITING ONE NUMBER rather than authoring
 * five. That is the difference between disagreeing with a target and
 * re-deriving one by hand, and it is the whole reason this reads as a phone
 * screen rather than a port of a desk form.
 *
 * The seed is taken at MOUNT and never after. The parent remounts this
 * component when the form is opened, which is what picks up a target that
 * landed while it was closed — and equally what stops a late fetch overwriting
 * digits somebody is in the middle of typing. Doing it with an effect instead
 * would be a setState-in-effect and a clobber, in that order.
 *
 * ## Where the keyboard handling comes from
 *
 * Five `TextInput`s and deliberately **no scroll container of its own** — the
 * one call site, `app/(tabs)/goals.tsx`, already renders this inside its
 * `KeyboardAwareScrollView`, and nesting a second vertical scroller inside it
 * would be worse than the bug the rule prevents.
 *
 * What it does take from that module is `useEnsureVisible`, and that is not
 * ceremony — see `Field` below. The first version of this component claimed the
 * exemption marker `keyboardCoverage.test.ts` offers and imported nothing,
 * which passed the check and left the lower fields sitting behind the number
 * pad the moment focus moved between two of them. The marker would have been a
 * true statement about the container and a false one about the outcome.
 */

import { useCallback, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useEnsureVisible } from '@/components/KeyboardAwareScroll';
import { formatDayLong } from '@/lib/history';
import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import {
  EMPTY_DRAFT,
  parseManualTarget,
  targetMacrosLookOff,
  type ManualDraft,
  type ManualTargetInput,
} from '@/lib/manualTarget';

const FIELDS: { key: keyof ManualDraft; label: string; suffix: string; optional?: boolean }[] = [
  { key: 'kcal', label: 'Calories', suffix: 'kcal' },
  { key: 'protein_g', label: 'Protein', suffix: 'g' },
  { key: 'carb_g', label: 'Carbs', suffix: 'g' },
  { key: 'fat_g', label: 'Fat', suffix: 'g' },
  { key: 'fibre_g', label: 'Fibre', suffix: 'g', optional: true },
];

export function ManualTarget({
  seed,
  on,
  effect,
  saving,
  failed,
  onSave,
}: {
  /** What to open on. Null opens blank — which is honest when there is neither
   *  a live target nor a derivable one. */
  seed: ManualDraft | null;
  /**
   * The day it takes effect.
   *
   * Shown rather than chosen HERE — Goals writes for today and the history
   * screen chooses the day outside this component, so a date control inside it
   * would be a second way to answer a question already answered.
   */
  on: string;
  /**
   * What the save does to days already gone, and it is a REQUIRED choice.
   *
   * The footnote used to be a constant: *"It takes effect from today forward.
   * Past days keep the target they were judged against."* True on Goals, which
   * only ever writes today. **Flatly false on the history screen**, which
   * exists to write past dates — and the sentence sat directly under the Save
   * button, contradicting that screen's own intro and its spoken receipt at
   * the exact moment of a backdated write. Found in review.
   *
   * Not defaulted, deliberately: a default is what let one call site inherit
   * the other's claim without anybody deciding, and a third caller should have
   * to answer the question rather than get the older answer for free.
   */
  effect: 'from_today' | 'restates_past_days';
  saving: boolean;
  /**
   * Why the last save failed, or null.
   *
   * A MESSAGE rather than a boolean, because the two failures need different
   * sentences: the server refusing a number permanently, and the phone not
   * reaching the server at all. A boolean here is what made every failure share
   * the offline copy, which sent an athlete with a mis-keyed 700 kcal off to
   * find better signal for a request that would fail identically forever.
   */
  failed: string | null;
  onSave: (input: ManualTargetInput) => void;
}) {
  const accent = useAccent();
  const [draft, setDraft] = useState<ManualDraft>(seed ?? EMPTY_DRAFT);
  // Only after a submit is attempted. Showing "Calories need to be a number"
  // over an empty form the athlete has not touched is scolding them for not
  // having typed yet.
  const [tried, setTried] = useState(false);

  const parsed = parseManualTarget(draft);
  const problem = !parsed.ok && tried ? parsed : null;

  const submit = useCallback(() => {
    setTried(true);
    const result = parseManualTarget(draft);
    if (!result.ok) {
      // Spoken, because the message renders below a button that keeps focus.
      // iOS has no live regions, so a VoiceOver user pressing Save on an
      // invalid form would otherwise hear nothing at all and conclude it
      // saved — the same reason the accept path announces its receipt.
      AccessibilityInfo.announceForAccessibility(result.problem);
      return;
    }
    onSave(result.input);
  }, [draft, onSave]);

  const odd = parsed.ok && targetMacrosLookOff(parsed.input);

  return (
    <View style={styles.wrap} testID="manual-form">
      <Text style={styles.note}>
        A number from a coach, or one you simply disagree with. Saved without an explanation,
        because there is none to save — the app will say you typed it rather than inventing
        arithmetic for it.
      </Text>

      <View style={styles.fields}>
        {FIELDS.map((f) => (
          <Field
            key={f.key}
            spec={f}
            value={draft[f.key]}
            bad={problem?.field === f.key}
            onChange={(t) => setDraft((d) => ({ ...d, [f.key]: t }))}
          />
        ))}
      </View>

      {/* A NUDGE, never a block. A target is a plan rather than a measurement,
          so its macros should add up to its calories — but a coach's numbers
          are the athlete's to enter as given, and refusing them puts us back
          where this screen started. */}
      {odd ? (
        <Text style={styles.note} testID="manual-odd">
          Those macros do not add up to those calories. Worth a look — it will save either way.
        </Text>
      ) : null}

      {problem ? (
        <Text style={styles.problem} testID="manual-problem">
          {problem.problem}
        </Text>
      ) : null}

      <Pressable
        onPress={submit}
        disabled={saving}
        style={[styles.primary, { borderColor: accent.accent }, saving && styles.off]}
        accessibilityRole="button"
        accessibilityState={{ disabled: saving }}
        // A readable date rather than the raw `YYYY-MM-DD`, which VoiceOver
        // reads as three numbers. It matters more here than it did when this
        // was always today: on the history screen the date IS the thing being
        // confirmed.
        accessibilityLabel={`Save this as your target from ${formatDayLong(on)}`}
        testID="manual-save"
      >
        <Text style={[styles.primaryText, { color: accent.ink }]}>
          {saving ? 'Saving…' : `Use this from ${formatDayLong(on)}`}
        </Text>
      </Pressable>

      {failed ? (
        <Text style={styles.problem} testID="manual-failed" accessibilityLiveRegion="polite">
          {failed}
        </Text>
      ) : null}

      <Text style={styles.footnote} testID="manual-footnote">
        {effect === 'from_today'
          ? 'It takes effect from today forward. Past days keep the target they were judged against.'
          : 'It applies from that day onward, so the days it covers are restated — a target is the yardstick they were measured against. Later targets are untouched.'}
      </Text>
    </View>
  );
}

/**
 * One numeric field, and the reason it is its own component.
 *
 * It needs a **ref of its own** to hand to `ensureVisible`, and five refs held
 * by the parent would be five more things to keep in step. More importantly,
 * `onFocus` is not decoration here: five fields of the SAME HEIGHT, tapped
 * between with the keyboard already up, is precisely the case the platform's
 * own inset adjustment does not cover — moving focus between same-height
 * inputs posts no keyboard event, so nothing scrolls and the lower fields stay
 * behind the number pad. `keyboardCoverage.test.ts` cannot see this: it checks
 * that the module is imported, which is a claim about reach and not about this.
 */
function Field({
  spec,
  value,
  bad,
  onChange,
}: {
  spec: (typeof FIELDS)[number];
  value: string;
  bad: boolean;
  onChange: (t: string) => void;
}) {
  const ensureVisible = useEnsureVisible();
  const ref = useRef<TextInput>(null);

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>
        {spec.label} ({spec.suffix}){spec.optional ? ' — optional' : ''}
      </Text>
      <TextInput
        ref={ref}
        style={[styles.input, bad && styles.inputBad]}
        value={value}
        onChangeText={onChange}
        onFocus={() => ensureVisible(ref.current)}
        keyboardType="decimal-pad"
        inputMode="decimal"
        placeholder="—"
        placeholderTextColor={vola.textDim}
        // The visible label says "— optional" and an `accessibilityLabel`
        // REPLACES it rather than adding to it, so without this a VoiceOver
        // user is the only one who cannot tell fibre is skippable.
        accessibilityLabel={`${spec.label} in ${spec.suffix}${spec.optional ? ', optional' : ''}`}
        testID={`manual-${spec.key}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, paddingTop: 4 },
  fields: { gap: 8 },
  field: { gap: 4 },
  fieldLabel: { fontSize: 12, color: vola.textMuted },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 44,
    fontSize: 16,
    color: vola.text,
  },
  inputBad: { borderColor: vola.danger },
  note: { fontSize: 12, color: vola.textMuted, lineHeight: 17 },
  problem: { fontSize: 12, color: vola.danger, lineHeight: 17 },
  footnote: { fontSize: 11, color: vola.textDim, lineHeight: 16 },
  primary: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontWeight: '700', fontSize: 15 },
  off: { opacity: 0.5 },
});
