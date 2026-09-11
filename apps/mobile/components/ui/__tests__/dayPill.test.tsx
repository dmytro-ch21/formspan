import fs from 'fs';
import path from 'path';

import { render, screen } from '@testing-library/react-native';

import { DayPill } from '../DayPill';

/**
 * The day pill — N493 part 3 (#858 item 5).
 *
 * The athlete reported that Food's day pill and Today's were not the same
 * thing. Part 1 of this ticket (#861) shared the first LINE of their text and
 * left everything else assembled per screen, and they still differed. So the
 * coverage that matters here is in two halves:
 *
 * 1. **What the pill says**, on today and on any other day — the rule that
 *    used to live in a comment on one of the two call sites.
 * 2. **That there is only one pill.** A render test cannot see a second
 *    screen quietly growing its own `PeriodSwitcher` back; the source check
 *    at the bottom can, and it is the only thing standing between this fix
 *    and the drift it undoes.
 */

const noop = () => {};
/** A Thursday, chosen so the weekday is unambiguous in the expectations. */
const DAY = new Date(2026, 8, 10, 12, 0, 0);

describe('what the day pill says', () => {
  it('on today, states TODAY and the long date under it', async () => {
    await render(<DayPill viewDay={DAY} isToday onPrev={noop} onNext={noop} testID="pill" />);

    expect(screen.getByText('TODAY')).toBeTruthy();
    // Both lines, one pill — this is the half Food did not have, and it is on
    // the day either tab is most often showing.
    expect(screen.getByText(/Thursday/)).toBeTruthy();
  });

  it('on any other day, states that day and does NOT repeat it underneath', async () => {
    await render(
      <DayPill viewDay={DAY} isToday={false} onPrev={noop} onNext={noop} testID="pill" />,
    );

    // The short form carries the date already (W14/#694) …
    expect(screen.getByTestId('pill-label').props.accessibilityLabel).toContain('SEP');
    // … so the long form would be the same fact twice, and is omitted.
    expect(screen.queryByText(/Thursday, 10 September/)).toBeNull();
  });

  it('names its arrows for a screen reader', async () => {
    await render(<DayPill viewDay={DAY} isToday onPrev={noop} onNext={noop} testID="pill" />);

    expect(screen.getByLabelText('Previous day')).toBeTruthy();
    expect(screen.getByLabelText('Next day')).toBeTruthy();
  });
});

/**
 * What stops the two pills drifting apart again.
 *
 * Both tabs rendered `PeriodSwitcher` directly and assembled its props
 * themselves; that is *why* they diverged, and nothing in a render test can
 * notice a screen going back to it. This reads the two files.
 *
 * It is deliberately narrow: `PeriodSwitcher` is shared with the week and
 * month steppers (`WeekPlanner`, and Food's own month grid inside its jump
 * sheet), which are not day pills and are none of this ticket's business. The
 * signature of a DAY stepper is its arrow labels, so that is what this looks
 * for.
 */
describe('there is exactly one day pill', () => {
  const tabs = path.join(__dirname, '..', '..', '..', 'app', '(tabs)');

  it.each([['index.tsx'], ['food.tsx']])(
    '%s builds its day pill from DayPill, not from PeriodSwitcher directly',
    (file) => {
      const src = fs.readFileSync(path.join(tabs, file), 'utf8');

      expect(src).toContain('<DayPill');
      // `prevLabel="Previous day"` is what a hand-assembled day stepper looks
      // like. Its absence is the assertion; `<DayPill` above is what makes a
      // pass mean "it moved" rather than "the pill vanished".
      expect(src).not.toContain('prevLabel="Previous day"');
    },
  );
});
