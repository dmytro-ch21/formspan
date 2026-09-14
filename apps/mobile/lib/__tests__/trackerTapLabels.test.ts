import {
  tapAmountLabel,
  tapLabel,
  tapListToggleLabel,
  tapRemoveLabel,
  tapTimeLabel,
  type Tracker,
  type TrackerEntry,
} from '../trackerModel';

/**
 * N578: what a listed tap is called — a bar-style card's rows.
 *
 * The suite runs under `TZ=America/Los_Angeles`, so 16:05Z on 20 August is
 * 09:05 on the 20th locally, and is on the day it is filed under.
 */

const water: Tracker = {
  id: 't_water', preset: 'water', name: 'Water', icon: '💧', color_key: 'water',
  unit: 'ml', increment: 250, target: 2000, render_style: 'glyphs', sort_order: 10,
  count_noun: 'cup', provisioned: true, cutoff_minutes: null,
};
const caffeine: Tracker = {
  ...water, id: 't_caffeine', preset: 'caffeine', name: 'Caffeine', unit: 'mg', increment: 80, target: 400,
};
const coffee: Tracker = {
  ...water, id: 't_coffee', preset: 'coffee', name: 'Coffee', unit: 'cup', increment: 1, target: null,
};
const showers: Tracker = {
  ...water, id: 't_showers', preset: '', name: 'Cold showers', unit: 'count', increment: 1, target: null, count_noun: '',
};

function tap(over: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    id: 'e1',
    tracker_id: 't_water',
    logged_on: '2026-08-20',
    logged_at: '2026-08-20T16:05:00.000Z',
    amount: 250,
    ...over,
  };
}

describe('one tap\'s amount', () => {
  it('follows the fluid preference for a volume', () => {
    expect(tapAmountLabel(water, tap(), 'metric')).toBe('250 ml');
    expect(tapAmountLabel(water, tap(), 'imperial')).toBe('8.5 fl oz');
  });

  it('shows grams and milligrams as stored', () => {
    expect(tapAmountLabel(caffeine, tap({ amount: 95 }), 'imperial')).toBe('95 mg');
  });

  it('names what a cup or a dose is, because a bare number does not', () => {
    expect(tapAmountLabel(coffee, tap({ amount: 1 }), 'metric')).toBe('1 cup');
    expect(tapAmountLabel(coffee, tap({ amount: 2 }), 'metric')).toBe('2 cups');
    // No noun is a real answer, not a missing one.
    expect(tapAmountLabel(showers, tap({ amount: 1 }), 'metric')).toBe('1');
  });
});

describe('when one tap was logged', () => {
  it('is the local clock time, for a tap on its own day', () => {
    expect(tapTimeLabel(tap())).toBe('09:05');
  });

  it('is nothing for a backfilled tap, whose clock belongs to another day', () => {
    // Filed under the 18th from the 20th. "09:05" beside the 18th's taps
    // would be a time that never happened on that day.
    expect(tapTimeLabel(tap({ logged_on: '2026-08-18' }))).toBeNull();
    expect(tapLabel(water, tap({ logged_on: '2026-08-18' }), 'metric')).toBe('Water, 250 ml');
  });
});

describe('what a listed tap is called', () => {
  it('names the tracker, the amount and the time', () => {
    expect(tapLabel(water, tap(), 'metric')).toBe('Water, 250 ml at 09:05');
    expect(tapRemoveLabel(water, tap(), 'metric')).toBe('Remove 250 ml at 09:05 from Water');
  });

  it('states the count on the disclosure, and says what closing it hides', () => {
    expect(tapListToggleLabel(water, 15, false)).toBe('Show all 15 cups');
    expect(tapListToggleLabel(water, 15, true)).toBe('Hide the cups');
    expect(tapListToggleLabel(showers, 13, false)).toBe('Show all 13 entries');
  });

  it('never praises and never scolds', () => {
    const JUDGEMENTS = ['great', 'well done', 'nice', 'too much', 'too many', 'careful', 'warning', '!'];
    const strings: string[] = [];
    for (const t of [water, caffeine, coffee, showers]) {
      for (const amount of [1, 80, 250, 1200]) {
        const e = tap({ amount });
        strings.push(tapLabel(t, e, 'metric'), tapRemoveLabel(t, e, 'imperial'));
      }
      strings.push(tapListToggleLabel(t, 31, false), tapListToggleLabel(t, 31, true));
    }
    // The apparatus: an enumeration that produced nothing would pass in silence.
    expect(strings.length).toBe(40);
    for (const s of strings) {
      for (const word of JUDGEMENTS) expect(s.toLowerCase()).not.toContain(word);
    }
  });
});
