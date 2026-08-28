import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { SelectAllTextInput } from '@/components/SelectAllTextInput';
import { Text } from '@/components/Themed';
import {
  TRACKER_COLOR_LABELS,
  trackerColors,
  trackerFill,
  vola,
  type TrackerColor,
} from '@/constants/Colors';
import {
  formatCutoff,
  inputUnitLabel,
  parseCutoff,
  pluralise,
  suggestedNoun,
  type RenderStyle,
  type Tracker,
  type TrackerUnit,
} from '@/lib/trackerModel';
import { fromDisplayFluid, toDisplayFluid, type UnitSystem } from '@/lib/units';

/**
 * The fields of a tracker, as one form.
 *
 * `keyboard-container: provided by parent` — this renders a FRAGMENT, never a
 * screen. Both call sites (`app/trackers/new.tsx` and `app/trackers/[id].tsx`)
 * wrap it in `KeyboardAwareScrollView`, and adding a second scroll container
 * here would nest one inside the other. The claim is checked at the two places
 * that can honour it rather than here, which is the limit
 * `keyboardCoverage.test.ts` states about itself: it proves the import, not the
 * wrapping. **If a third screen renders this, it needs that container too.**
 *
 * **Shared by creating and editing on purpose.** Two copies of a nine-field
 * form is two places for the colour picker to fall out of step with the
 * palette, and #392 in this repo is exactly that shape — two image-upload paths
 * that each learned the same downscale independently, the second from a device
 * report rather than from review.
 *
 * ## The colour picker is a FIXED SET, and that is the whole design
 *
 * There is no hex field and there will not be one. `scripts/validate_palette.mjs`
 * measures contrast on both card grounds, contrast for the ground written on the
 * fill, and CIEDE2000 separation from the app's categorical blue and from every
 * other tracker colour — under normal vision and three colour-blindness
 * simulations. **None of that can run on a phone at the moment an athlete drags
 * a colour wheel.** So the gate runs in CI over a closed set, and the athlete
 * picks a member of it.
 *
 * That is not a limitation being apologised for. #406 measured the obvious
 * water-cyan at ΔE 8.0 from `info` under tritanopia — a colour that looks
 * excellent and is unreadable for a real fraction of the people this app is
 * for. A free picker ships that to the athlete's own phone with nothing in the
 * way.
 *
 * ## What the athlete types, versus what is stored
 *
 * - The TARGET is entered in taps ("eight glasses"), because that is the
 *   sentence a person says; the stored value is taps × increment.
 * - The INCREMENT is entered in the athlete's display unit (`ml` or `fl oz`),
 *   because that is the one number where the actual volume is what you know —
 *   a bottle says 500 ml on the side of it.
 * - The NOUN is prefilled from the unit and then left alone. See `onUnitChange`.
 */

export type TrackerDraft = {
  name: string;
  icon: string;
  color_key: string;
  unit: TrackerUnit;
  /** In `unit`, already converted out of the display unit. */
  increment: number;
  /** In `unit`. `null` is a count with no ceiling. */
  target: number | null;
  render_style: RenderStyle;
  count_noun: string;
  /** Minutes since local midnight. `null` is no cutoff — see `cutoffLine`. */
  cutoff_minutes: number | null;
};

const UNITS: { key: TrackerUnit; label: string }[] = [
  { key: '', label: 'Just count' },
  { key: 'ml', label: 'ml' },
  { key: 'g', label: 'g' },
  { key: 'mg', label: 'mg' },
  { key: 'cup', label: 'cups' },
  { key: 'dose', label: 'doses' },
  { key: 'count', label: 'count' },
];

const SHAPES: { key: RenderStyle; label: string; hint: string }[] = [
  { key: 'auto', label: 'Automatic', hint: 'Chosen from your target' },
  { key: 'dose', label: 'One dose', hint: 'A single glyph you tap once' },
  { key: 'glyphs', label: 'A row', hint: 'One glyph per tap' },
  { key: 'bar', label: 'A bar', hint: 'A bar with the number' },
];

/**
 * What the form holds while it is being typed into.
 *
 * Strings, not numbers, and that is deliberate: a half-typed "2." is not a
 * number, and coercing on every keystroke makes the field fight the athlete.
 * Parsed once, on submit, by `readDraft`.
 */
export type TrackerFormState = {
  name: string;
  icon: string;
  colorKey: string;
  unit: TrackerUnit;
  noun: string;
  /** Whether the athlete has touched the noun field. See `setUnit`. */
  nounTouched: boolean;
  incrementText: string;
  countText: string;
  shape: RenderStyle;
  /** "16:00", or empty for no cutoff. Parsed once, on submit, by `readDraft`. */
  cutoffText: string;
};

/** A blank form: one dose, once a day — N78's own motivating example. */
export function emptyForm(): TrackerFormState {
  return {
    name: '',
    icon: '',
    colorKey: 'mint',
    unit: 'g',
    noun: suggestedNoun('g'),
    nounTouched: false,
    incrementText: '',
    countText: '1',
    shape: 'auto',
    cutoffText: '',
  };
}

/**
 * How an increment is WRITTEN in the field, given the athlete's unit preference.
 *
 * Shared by `formFor` and `readDraft` so the two agree by construction. They did
 * not, and the drift was visible: `toDisplayFluid` rounds to 0.1 fl oz, so an
 * imperial athlete opening the edit screen and pressing Save with no edits sent
 * 250 ml → "8.5" → 251.37 ml, and the target was recomputed as count ×
 * increment, turning water's 2000 into 2010.98. A no-op save that marks a row
 * dirty and pushes a patch is the kind of thing that later reads as sync
 * corruption.
 */
function displayIncrement(t: { unit: TrackerUnit; increment: number }, units: UnitSystem): string {
  return t.unit === 'ml' ? String(toDisplayFluid(t.increment, units)) : String(t.increment);
}

/** How many taps make up a stored target. `null` when there is no target. */
function storedCount(t: { target: number | null; increment: number }): number | null {
  return t.target != null && t.increment > 0 ? Math.ceil(t.target / t.increment) : null;
}

/** The form, filled from a tracker that already exists. */
export function formFor(t: Tracker, units: UnitSystem): TrackerFormState {
  const count = storedCount(t);
  return {
    name: t.name,
    icon: t.icon,
    colorKey: t.color_key,
    unit: t.unit,
    noun: t.count_noun,
    // TOUCHED, always, for an existing tracker. Whatever is stored is the
    // athlete's answer — even an empty one — and changing the unit on an edit
    // screen must not quietly overwrite a word they chose months ago.
    nounTouched: true,
    incrementText: displayIncrement(t, units),
    countText: count == null ? '' : String(count),
    shape: t.render_style,
    cutoffText: t.cutoff_minutes == null ? '' : formatCutoff(t.cutoff_minutes),
  };
}

/**
 * Parse a form into a draft, or say what is wrong with it.
 *
 * One place, so create and edit reject the same things with the same words.
 */
export function readDraft(
  f: TrackerFormState,
  units: UnitSystem,
  /**
   * The tracker being EDITED, when there is one.
   *
   * Present so an untouched field can be written back byte-for-byte instead of
   * round-tripped through the display unit — see `displayIncrement`. Absent on
   * the create screen, where there is nothing to preserve.
   */
  original?: Tracker,
): { draft: TrackerDraft } | { error: string } {
  const name = f.name.trim();
  if (!name) return { error: 'Give it a name.' };
  if (name.length > 60) return { error: 'That name is too long.' };

  const typedIncrement = Number(f.incrementText.trim());
  if (!Number.isFinite(typedIncrement) || typedIncrement <= 0) {
    return { error: 'A tap has to add something. Enter a number greater than zero.' };
  }
  // UNTOUCHED means unchanged. If the field still reads exactly what `formFor`
  // put in it, write the stored number back rather than the one that survives a
  // conversion and a rounding.
  const untouchedIncrement =
    original !== undefined &&
    original.unit === f.unit &&
    f.incrementText.trim() === displayIncrement(original, units);
  const increment = untouchedIncrement
    ? original.increment
    : f.unit === 'ml'
      ? fromDisplayFluid(typedIncrement, units)
      : typedIncrement;

  let target: number | null = null;
  const typedCount = f.countText.trim();
  if (typedCount !== '') {
    const count = Number(typedCount);
    if (!Number.isFinite(count) || count <= 0) {
      return { error: 'Enter how many you are aiming for, or leave it blank for no target.' };
    }
    // A target is entered in whole taps. `number-pad` does not stop a paste, and
    // 2.5 glasses is not a thing an athlete means.
    if (!Number.isInteger(count)) {
      return { error: 'Enter a whole number, or leave it blank for no target.' };
    }
    // Same rule for the target: unchanged count AND unchanged increment means
    // the stored target stands. Recomputing it as count × increment would round
    // any server-authored target that is not a whole multiple — `Math.ceil` in
    // `formFor` rounds UP to display it, and multiplying back bakes that in.
    const untouchedCount = original !== undefined && String(storedCount(original) ?? '') === typedCount;
    target = untouchedIncrement && untouchedCount ? original.target : count * increment;
  }

  // Trimmed here rather than rejected, because a trailing space is a typing
  // artefact and not a decision — unlike the server, which refuses one because
  // a validator that silently repairs its input is lying about what it stored.
  // The trim happens at the point the athlete's intent is still legible.
  const noun = f.noun.trim();
  if (noun.length > 24) return { error: 'That word is too long.' };

  let cutoffMinutes: number | null = null;
  const typedCutoff = f.cutoffText.trim();
  if (typedCutoff !== '') {
    cutoffMinutes = parseCutoff(typedCutoff);
    if (cutoffMinutes == null) {
      return { error: 'Enter a cutoff time as HH:MM (e.g. 16:00), or leave it blank for none.' };
    }
  }

  return {
    draft: {
      name,
      icon: f.icon.trim(),
      color_key: f.colorKey,
      unit: f.unit,
      increment,
      target,
      render_style: f.shape,
      count_noun: noun,
      cutoff_minutes: cutoffMinutes,
    },
  };
}

export function TrackerForm({
  value,
  onChange,
  units,
}: {
  value: TrackerFormState;
  onChange: (next: TrackerFormState) => void;
  units: UnitSystem;
}) {
  const set = <K extends keyof TrackerFormState>(key: K, v: TrackerFormState[K]) =>
    onChange({ ...value, [key]: v });

  /**
   * Changing the unit re-suggests the noun — but only while the athlete has
   * not typed one.
   *
   * The suggestion is N76's old derivation, demoted to what it could actually
   * do. It has to stop the moment the athlete disagrees with it, or picking
   * `g` after typing "serving" silently rewrites their word to "dose" — which
   * is the exact failure (30 g of fibre reading "6 doses") this field exists
   * to end, reintroduced one screen later.
   */
  const setUnit = (unit: TrackerUnit) =>
    onChange({
      ...value,
      unit,
      noun: value.nounTouched ? value.noun : suggestedNoun(unit),
    });

  const unitLabel = inputUnitLabel({ unit: value.unit } as Tracker, units);
  const nounPlural = pluralise(value.noun, 2);

  return (
    <>
      <Field label="Name">
        <SelectAllTextInput
          style={styles.input}
          value={value.name}
          onChangeText={(t) => set('name', t)}
          placeholder="Creatine"
          placeholderTextColor={vola.textDim}
          accessibilityLabel="Tracker name"
          testID="tracker-form-name"
        />
      </Field>

      <Field label="Icon">
        <SelectAllTextInput
          style={[styles.input, styles.iconInput]}
          value={value.icon}
          onChangeText={(t) => set('icon', t)}
          placeholder="🥄"
          placeholderTextColor={vola.textDim}
          maxLength={4}
          accessibilityLabel="Tracker icon, an emoji"
          accessibilityHint="Optional. Leave it blank for a plain coloured dot."
          testID="tracker-form-icon"
        />
      </Field>

      <Field label="Colour">
        {/* A row of the validated palette, and nothing else — see the header.
            `radio` rather than `button`: VoiceOver then announces "selected"
            for the current one, which is the only way a screen-reader user can
            tell which colour is chosen, colour being unavailable to them by
            definition. */}
        <RNView style={styles.swatches} accessibilityRole="radiogroup">
          {(Object.keys(trackerColors) as TrackerColor[]).map((key) => {
            const selected = value.colorKey === key;
            return (
              <Pressable
                key={key}
                onPress={() => set('colorKey', key)}
                hitSlop={6}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={TRACKER_COLOR_LABELS[key]}
                testID={`tracker-form-color-${key}`}
                style={[
                  styles.swatch,
                  { backgroundColor: trackerFill(key) },
                  selected && styles.swatchOn,
                ]}
              />
            );
          })}
        </RNView>
        <Text style={styles.hint}>{TRACKER_COLOR_LABELS[value.colorKey as TrackerColor] ?? ''}</Text>
      </Field>

      <Field label="Measured in">
        <Chips
          options={UNITS.map((u) => ({ key: u.key, label: u.label }))}
          selected={value.unit}
          onSelect={(k) => setUnit(k as TrackerUnit)}
          name="unit"
        />
      </Field>

      <Field label="Word for one tap">
        <SelectAllTextInput
          style={styles.input}
          value={value.noun}
          onChangeText={(t) => onChange({ ...value, noun: t, nounTouched: true })}
          placeholder="No word"
          placeholderTextColor={vola.textDim}
          maxLength={24}
          accessibilityLabel="Word for one tap"
          testID="tracker-form-noun"
        />
        <Text style={styles.hint}>
          {value.noun
            ? `Your card will read "3 of 6 ${nounPlural}".`
            : 'Leave it blank and your card reads "3 of 6".'}
        </Text>
      </Field>

      <Field label={`One tap adds${unitLabel ? ` (${unitLabel})` : ''}`}>
        <SelectAllTextInput
          style={styles.input}
          value={value.incrementText}
          onChangeText={(t) => set('incrementText', t)}
          keyboardType="decimal-pad"
          placeholder="5"
          placeholderTextColor={vola.textDim}
          accessibilityLabel={`One tap adds${unitLabel ? `, in ${unitLabel}` : ''}`}
          testID="tracker-form-increment"
        />
      </Field>

      <Field label={`Daily target${value.noun ? `, in ${nounPlural}` : ''}`}>
        <SelectAllTextInput
          style={styles.input}
          value={value.countText}
          onChangeText={(t) => set('countText', t)}
          keyboardType="number-pad"
          placeholder="No target"
          placeholderTextColor={vola.textDim}
          accessibilityLabel={`Daily target${value.noun ? `, in ${nounPlural}` : ''}`}
          testID="tracker-form-target"
        />
        <Text style={styles.hint}>Leave it blank to just count, with nothing to reach.</Text>
      </Field>

      <Field label="Cutoff">
        {/* N431: "no more after this time" — a plain clock time rather than a
            second sleep-tracking feature. An athlete who thinks in "six hours
            before my 22:00 bedtime" works that out once and types the result;
            there is no separate bedtime field to keep in sync with a sleep
            model this app does not have. */}
        <SelectAllTextInput
          style={styles.input}
          value={value.cutoffText}
          onChangeText={(t) => set('cutoffText', t)}
          keyboardType="numbers-and-punctuation"
          placeholder="No cutoff"
          placeholderTextColor={vola.textDim}
          maxLength={5}
          accessibilityLabel="Cutoff time, as hours and minutes"
          accessibilityHint="For example, sixteen colon zero zero for four in the afternoon"
          testID="tracker-form-cutoff"
        />
        <Text style={styles.hint}>
          {value.cutoffText
            ? `Your card will warn once it is ${value.cutoffText} and past — e.g. six hours ` +
              `before a ten o'clock bedtime is 16:00.`
            : 'Leave it blank for no cutoff warning.'}
        </Text>
      </Field>

      <Field label="Shape">
        <Chips
          options={SHAPES.map((s) => ({ key: s.key, label: s.label }))}
          selected={value.shape}
          onSelect={(k) => set('shape', k as RenderStyle)}
          name="shape"
        />
        <Text style={styles.hint}>
          {SHAPES.find((s) => s.key === value.shape)?.hint}
          {'. '}
          {/* Said out loud, because it is a rule the athlete's choice yields to
              and a control that silently ignores you is worse than one that
              explains itself. */}
          A row longer than twelve becomes a bar, whatever is chosen here.
        </Text>
      </Field>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <RNView style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </RNView>
  );
}

function Chips({
  options,
  selected,
  onSelect,
  name,
}: {
  options: { key: string; label: string }[];
  selected: string;
  onSelect: (key: string) => void;
  name: string;
}) {
  return (
    <RNView style={styles.chips} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.key === selected;
        return (
          <Pressable
            key={o.key || 'none'}
            onPress={() => onSelect(o.key)}
            style={[styles.chip, on && styles.chipOn]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            testID={`tracker-form-${name}-${o.key || 'none'}`}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </RNView>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6, marginTop: 14 },
  label: { fontSize: 12, fontWeight: '800', letterSpacing: 1.2, color: vola.textMuted },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    color: vola.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
    fontWeight: '700',
  },
  iconInput: { width: 96, textAlign: 'center' },
  hint: { fontSize: 12, color: vola.textDim },
  swatches: { flexDirection: 'row', gap: 12, paddingVertical: 4 },
  // 36pt drawn plus 6pt of slop each side is 48 — past the 44 iOS asks for,
  // which matters here because five of them sit in one row under a thumb.
  swatch: { width: 36, height: 36, borderRadius: 12, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: vola.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: vola.surface,
  },
  chipOn: { borderColor: vola.text, backgroundColor: vola.surfaceRaised },
  chipText: { fontSize: 13, fontWeight: '700', color: vola.textMuted },
  chipTextOn: { color: vola.text },
});
