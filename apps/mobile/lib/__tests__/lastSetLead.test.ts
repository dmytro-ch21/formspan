import { lastRepsStat, lastSetLead, type Suggestion } from '../sessions';
import { formatWeight } from '../units';

/**
 * F62/#1165 — a suggestion's last top set said nothing about spotted reps.
 *
 * `last_reps` is the full count, assisted included, and the progression is
 * measured against the solo count. The session screen's "Last 8 × 100kg" hint,
 * its VoiceOver label and the exercise screen's Reps tile all read it bare.
 */
const top = (over: Partial<Suggestion> = {}): Pick<Suggestion, 'last_reps' | 'last_weight_kg' | 'last_assisted_reps'> => ({
  last_reps: 8,
  last_weight_kg: 100,
  ...over,
});
const w = formatWeight(100, 'metric');

describe('the session hint says when the last top set had help', () => {
  it('in the visible text', () => {
    expect(lastSetLead(top({ last_assisted_reps: 3 }), 'metric').visible).toBe(`Last 8 × ${w} (3 assisted)`);
  });

  it('in the VoiceOver label, which says "by" rather than ×', () => {
    expect(lastSetLead(top({ last_assisted_reps: 3 }), 'metric').spoken).toBe(`Last 8 by ${w} (3 assisted)`);
  });

  it.each([
    ['unrecorded (null)', null],
    ['absent, an older response', undefined],
    ['none of them (0)', 0],
  ] as const)('adds nothing when assistance is %s', (_label, assisted) => {
    const s = assisted === undefined ? top() : top({ last_assisted_reps: assisted });
    expect(lastSetLead(s, 'metric')).toEqual({ visible: `Last 8 × ${w}`, spoken: `Last 8 by ${w}` });
  });

  it('says nothing about assistance when there is no rep count to qualify', () => {
    expect(lastSetLead(top({ last_reps: null, last_assisted_reps: 3 }), 'metric')).toEqual({
      visible: `Last ${w}`,
      spoken: `Last ${w}`,
    });
  });

  it('is empty with no weight, which the screen already gates on', () => {
    expect(lastSetLead(top({ last_weight_kg: null }), 'metric')).toEqual({ visible: '', spoken: '' });
  });
});

describe("the exercise screen's Reps tile says so too", () => {
  it('keeps the count as the value and puts the help on a line of its own', () => {
    expect(lastRepsStat({ last_reps: 8, last_assisted_reps: 3 })).toEqual({ value: '8', note: '3 assisted' });
  });

  it.each([null, undefined, 0])('adds no line when the assisted count is %p', (assisted) => {
    expect(lastRepsStat({ last_reps: 8, last_assisted_reps: assisted })).toEqual({ value: '8', note: null });
  });

  it('shows a dash and no line with no rep count to qualify', () => {
    expect(lastRepsStat({ last_reps: null, last_assisted_reps: 3 })).toEqual({ value: '—', note: null });
    expect(lastRepsStat(null)).toEqual({ value: '—', note: null });
  });
});
