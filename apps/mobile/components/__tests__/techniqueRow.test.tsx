import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { TechniqueRow, type Criterion } from '@/components/ui/TechniqueRow';
import { vola } from '@/constants/Colors';

/**
 * The roadmap row's state column and its spoken form.
 *
 * **Both of these shipped broken and were caught in review, not by looking at
 * the screen** — which is why they are worth a test rather than another
 * screenshot. Each was invisible to the eye in the exact case that mattered:
 *
 * 1. `started` was derived from `criteria.some((c) => c.met)`. A criterion
 *    turns `met` only when fully *cleared*, so an athlete at 24/25 landed and
 *    14/15 sessions had none met and drew the untouched rule — identical to a
 *    technique never trained. `lineSoft` on `surface` is 1.14:1, which
 *    `Colors.ts` documents as invisible, so the wrong state was also the state
 *    you cannot see. A screenshot of a mastered row and a fresh row looks
 *    perfect and proves nothing about the middle.
 * 2. Mastery was announced nowhere. It is carried by a check glyph, the rule
 *    colour and a chip tint; `Icon` sets `accessible={false}` on every glyph,
 *    so all three are invisible to VoiceOver. The row this replaced had
 *    `MASTERED` as visible text and got the announcement for free.
 *
 * ## Mutation record
 *
 * Measured, not estimated — each mutation was applied to `TechniqueRow.tsx`,
 * the suite run, and the file restored. All seven die.
 *
 * | Mutation                                         | Result |
 * | ------------------------------------------------ | ------ |
 * | `started` back to `some(c => c.met) \|\| mastered` * | 1 red  |
 * | drop the disc's `accessibilityLabel`              | 2 red  |
 * | drop `accessible` from the disc †                 | 2 red  |
 * | `rule`'s untouched branch → `textMuted`           | 2 red  |
 * | `rule`'s mastered branch → `textMuted`            | 1 red  |
 * | chip text ignores `met`                           | 1 red  |
 * | re-clamp `notes` to `numberOfLines={2}`           | 1 red  |
 *
 * \* The shipped bug, and the row that matters: a suite green against it would
 * be worthless, since that is the version this file exists to keep out.
 *
 * † **This one survived the first draft**, and the reason generalises: RNTL's
 * `getByLabelText` matches the `accessibilityLabel` prop whether or not the
 * element is an accessibility element at all. So every label query stayed
 * green while VoiceOver — where a `View` defaults to non-accessible and reads
 * the children instead — would have heard nothing. Asserting the label is not
 * the same as asserting it is announced; `accessible` needed its own line.
 */

const TONE = '#C8FF00';

function crit(over: Partial<Criterion> = {}): Criterion {
  return { icon: 'goal', value: '0/25', met: false, label: 'Landed, 0 of 25', ...over };
}

function renderRow(over: Partial<Parameters<typeof TechniqueRow>[0]> = {}) {
  return render(
    <TechniqueRow
      step={3}
      name="Armbar from closed guard"
      position="Closed guard"
      category="Submission"
      notes=""
      criteria={[crit()]}
      mastered={false}
      started={false}
      reading={false}
      tone={TONE}
      {...over}
    />,
  );
}

function ruleColour(): string | undefined {
  const flat = StyleSheet.flatten(screen.getByTestId('technique-rule').props.style) as {
    backgroundColor?: string;
  };
  return flat.backgroundColor;
}

describe('the state rule', () => {
  it('draws untouched when there is no evidence', () => {
    renderRow({ started: false, mastered: false });
    expect(ruleColour()).toBe(vola.lineSoft);
  });

  it('draws started for a near-miss, where NOTHING is met', () => {
    // The case the shipped bug got wrong, and the whole reason for the prop:
    // three criteria, real progress against every one, not one of them cleared.
    renderRow({
      started: true,
      mastered: false,
      criteria: [
        crit({ icon: 'goal', value: '24/25', met: false, label: 'Landed, 24 of 25' }),
        crit({ icon: 'calendar', value: '14/15', met: false, label: 'Sessions, 14 of 15' }),
        crit({ icon: 'chart', value: '38%/40%', met: false, label: 'Hit rate, 38 percent of 40 needed' }),
      ],
    });
    expect(ruleColour()).toBe(vola.textMuted);
    // Stated the other way round too, because "not lineSoft" is the claim the
    // athlete actually cares about: this row must not look untrained.
    expect(ruleColour()).not.toBe(vola.lineSoft);
  });

  it('draws mastered over started', () => {
    renderRow({ started: true, mastered: true });
    expect(ruleColour()).toBe(TONE);
  });

  it('draws untouched for someone browsing, however high the targets', () => {
    // Not enrolled: no progress is being counted, so no state is claimed.
    renderRow({
      started: false,
      mastered: false,
      criteria: [crit({ value: '25', met: false, label: 'Landed, 25 needed' })],
    });
    expect(ruleColour()).toBe(vola.lineSoft);
  });
});

describe('what a screen reader hears', () => {
  it('says "Mastered" when the check replaces the number', () => {
    renderRow({ mastered: true, started: true });
    const disc = screen.getByLabelText('Mastered');
    expect(disc).toBeTruthy();
    // The ordinal is gone from the announcement as well as from the screen.
    expect(screen.queryByLabelText('Step 3')).toBeNull();

    // `accessible` asserted on the prop, deliberately. RNTL's `getByLabelText`
    // matches `accessibilityLabel` whether or not the element is an
    // accessibility element at all — so removing `accessible` leaves every
    // query above green while VoiceOver, where a View defaults to
    // non-accessible and would read the children instead, hears nothing. That
    // mutation survived until this line existed.
    expect(disc.props.accessible).toBe(true);
  });

  it('says "Step 3" rather than a bare "3" otherwise', () => {
    renderRow({ step: 3, mastered: false });
    const disc = screen.getByLabelText('Step 3');
    expect(disc).toBeTruthy();
    expect(disc.props.accessible).toBe(true);
    expect(screen.queryByLabelText('Mastered')).toBeNull();
  });

  it('gives every chip a spoken form, not its raw digits', () => {
    renderRow({
      criteria: [
        crit({ icon: 'goal', value: '12/25', met: false, label: 'Landed, 12 of 25' }),
        crit({ icon: 'chart', value: '43%/40%', met: true, label: 'Hit rate, 43 percent of 40 needed' }),
      ],
    });
    expect(screen.getByLabelText('Landed, 12 of 25')).toBeTruthy();
    expect(screen.getByLabelText('Hit rate, 43 percent of 40 needed')).toBeTruthy();
  });

  it('announces the label it was given rather than the digits beside it', () => {
    // Deliberately NOT asserting `queryByLabelText(/0 of 25/)` is null here.
    // That would read as the honest-numbers guard and cover nothing: whether a
    // browsing row says "25 needed" or "0 of 25" is decided in
    // `criteriaChips`, which this file does not import, so the assertion could
    // never go red from any change to this component. It is covered for real
    // in `lib/__tests__/curriculumRow.test.ts`.
    renderRow({ criteria: [crit({ value: '25', label: 'Landed, 25 needed' })] });
    expect(screen.getByLabelText('Landed, 25 needed')).toBeTruthy();
    expect(screen.queryByText('Landed, 25 needed')).toBeNull();
  });
});

describe('the chips', () => {
  it('tints exactly the met ones', () => {
    renderRow({
      criteria: [
        crit({ icon: 'goal', value: '32/25', met: true, label: 'Landed, 32 of 25' }),
        crit({ icon: 'calendar', value: '9/15', met: false, label: 'Sessions, 9 of 15' }),
      ],
    });
    const tinted = screen.getByText('32/25');
    const plain = screen.getByText('9/15');
    expect((StyleSheet.flatten(tinted.props.style) as { color?: string }).color).toBe(TONE);
    expect((StyleSheet.flatten(plain.props.style) as { color?: string }).color).toBe(vola.textMuted);
  });

  it('says a reading item is to study, and draws no chips at all', () => {
    // Chips passed alongside `reading` must be ignored, not merged — the same
    // reason the old row printed a sentence instead of an empty measure block.
    renderRow({ reading: true, criteria: [crit({ value: '0/25' })] });
    expect(screen.getByText('Something to study')).toBeTruthy();
    expect(screen.queryByText('0/25')).toBeNull();
  });

  it('renders a note in full rather than clipping it', () => {
    // 103 characters is the longest in curricula.json — about three lines here.
    // A clamp hid the sentence explaining why the step sits where it does.
    const note =
      'You learned the early escape at white and the late one at blue — now the strangle simply does not land.';
    renderRow({ notes: note });
    expect(screen.getByText(note).props.numberOfLines).toBeUndefined();
  });
});
