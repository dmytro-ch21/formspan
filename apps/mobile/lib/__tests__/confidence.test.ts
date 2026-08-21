import {
  CONFIDENCE_DAYS,
  CONFIDENCE_TARGET_DAYS,
  PARTIAL_BELOW,
  readConfidence,
  stateFor,
} from '../confidence';

/**
 * The fortnight behind the Goals screen's confidence block.
 *
 * The acceptance criterion this covers is behavioural rather than visual: *"the
 * confidence dots reflect real logged days, and a partial day renders
 * distinctly from a logged one and from an empty one"*. The rendering is
 * `ConfidenceBlock`'s; the three-way rule is here, and it is the half that can
 * be wrong without anybody noticing — a partial day silently counted as logged
 * inflates the evidence behind a target, which is the direction that actually
 * hurts.
 *
 * Every assertion here fails when the line it covers is deleted; the count and
 * the window arithmetic were both mutation-checked.
 */

const TODAY = '2026-08-20';

/** A target of 2000 on every day, which is the ordinary case. */
const flat = (kcal: number | null) => () => kcal;

describe('stateFor — the three-way rule', () => {
  it('calls a day with no rows empty, not zero', () => {
    expect(stateFor(undefined, 2000)).toBe('empty');
  });

  it('does not fold a zero-calorie day into "empty" — it has rows, so it is partial', () => {
    // The distinction a falsy check (`if (!kcal)`) would destroy. `0` is a day
    // with real entries in it that plainly is not a day's eating, so it is
    // partial; `undefined` is no entries at all, which is empty. Collapsing
    // them loses the fact that the athlete opened the app and logged something.
    expect(stateFor(0, 2000)).toBe('partial');
    expect(stateFor(undefined, 2000)).toBe('empty');
  });

  it('calls a zero-calorie day logged when there is no target to judge it against', () => {
    // Same rule as everywhere else here: with no yardstick we do not claim it
    // fell short. This is also the case that proves the `=== undefined` check
    // is doing work — a falsy test would report 'empty' here.
    expect(stateFor(0, null)).toBe('logged');
  });

  it('calls a day under half its target partial', () => {
    expect(stateFor(999, 2000)).toBe('partial');
  });

  it('calls a day exactly on the threshold logged, not partial', () => {
    // `<` rather than `<=`, so the boundary belongs to the generous side. An
    // athlete who logs exactly half is not told their day did not count.
    expect(stateFor(1000, 2000)).toBe('logged');
    expect(PARTIAL_BELOW).toBe(0.5);
  });

  it('calls a day logged when there is no target to judge it against', () => {
    // Absence is not an answer: with no yardstick we do not know it was
    // partial, so we do not say it was.
    expect(stateFor(300, null)).toBe('logged');
  });

  it('treats a nonsensical zero target as no yardstick rather than dividing by it', () => {
    expect(stateFor(1, 0)).toBe('logged');
  });
});

describe('readConfidence — the window', () => {
  it('returns exactly the window, oldest first, ending today', () => {
    const c = readConfidence([], TODAY, flat(2000));
    expect(c.days).toHaveLength(CONFIDENCE_DAYS);
    expect(c.days[0].day).toBe('2026-08-07');
    expect(c.days[CONFIDENCE_DAYS - 1].day).toBe(TODAY);
  });

  it('crosses a month boundary without inventing a day', () => {
    const c = readConfidence([], '2026-03-05', flat(null));
    expect(c.days[0].day).toBe('2026-02-20');
    expect(c.days).toHaveLength(14);
    // No duplicates — an off-by-one in the date arithmetic shows up here before
    // it shows up as a fifteenth dot.
    expect(new Set(c.days.map((d) => d.day)).size).toBe(14);
  });

  it('crosses a leap day', () => {
    const c = readConfidence([], '2028-03-01', flat(null));
    expect(c.days.map((d) => d.day)).toContain('2028-02-29');
  });

  it('ignores logged days outside the window', () => {
    const c = readConfidence(
      [
        { day: '2026-07-01', kcal: 2200 },
        { day: TODAY, kcal: 2200 },
      ],
      TODAY,
      flat(2000),
    );
    expect(c.logged).toBe(1);
  });

  it('does NOT count partial days toward the total', () => {
    // The load-bearing one. Seven full days and seven half days is seven, not
    // fourteen — otherwise a fortnight of breakfasts satisfies the bar.
    const totals = [
      ...Array.from({ length: 7 }, (_, i) => ({ day: dayBefore(TODAY, i), kcal: 2200 })),
      ...Array.from({ length: 7 }, (_, i) => ({ day: dayBefore(TODAY, i + 7), kcal: 400 })),
    ];
    const c = readConfidence(totals, TODAY, flat(2000));
    expect(c.logged).toBe(7);
    expect(c.days.filter((d) => d.state === 'partial')).toHaveLength(7);
    expect(c.days.filter((d) => d.state === 'empty')).toHaveLength(0);
  });

  it('carries the denominator with the count', () => {
    const c = readConfidence([], TODAY, flat(2000));
    expect(c).toMatchObject({ logged: 0, considered: CONFIDENCE_DAYS });
  });

  it('judges each day against the target that was in force THAT day', () => {
    // 1,200 kcal is a full day against a 2,000 target and half a day against a
    // 3,000 one. A fixed floor cannot tell those apart, which is the whole
    // reason the yardstick is a function.
    const totals = [
      { day: TODAY, kcal: 1200 },
      { day: dayBefore(TODAY, 1), kcal: 1200 },
    ];
    const c = readConfidence(totals, TODAY, (day) => (day === TODAY ? 2000 : 3000));
    const byDay = Object.fromEntries(c.days.map((d) => [d.day, d.state]));
    expect(byDay[TODAY]).toBe('logged');
    expect(byDay[dayBefore(TODAY, 1)]).toBe('partial');
  });

  it('is enough at the stated bar and not one below it', () => {
    const full = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ day: dayBefore(TODAY, i), kcal: 2200 }));
    expect(readConfidence(full(CONFIDENCE_TARGET_DAYS - 1), TODAY, flat(2000)).enough).toBe(false);
    expect(readConfidence(full(CONFIDENCE_TARGET_DAYS), TODAY, flat(2000)).enough).toBe(true);
  });

  it('is never enough on an empty fortnight, and reports the zero rather than hiding it', () => {
    const c = readConfidence([], TODAY, flat(2000));
    expect(c.enough).toBe(false);
    expect(c.logged).toBe(0);
    expect(c.days.every((d) => d.state === 'empty')).toBe(true);
  });
});

function dayBefore(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() - n);
  return at.toISOString().slice(0, 10);
}
