import { awardingPromotion, formatAwardDate, type Promotion, type Standing } from '../bjj';
import { formatRecord, type PersonalRecord, type RecordKind } from '../records';

/**
 * The facts the You screen's belt masthead and record rows assert.
 *
 * Both of these say something *about the athlete* — where they were promoted,
 * and what they lifted — so being wrong here is worse than being ugly. A
 * masthead attributing a belt to the wrong academy, or a modelled 1RM rendered
 * to two decimals as if it were measured, are the two failures this covers.
 */

function promo(over: Partial<Promotion> = {}): Promotion {
  return {
    id: 'p1',
    belt: 'purple',
    stripes: 2,
    degree: 0,
    promoted_on: '2024-03-12',
    academy: 'Gracie Barra Kyiv',
    instructor: '',
    note: '',
    created_at: '2024-03-12T00:00:00Z',
    updated_at: '2024-03-12T00:00:00Z',
    ...over,
  };
}

function standing(promotions: Promotion[], current = { belt: 'purple' as const, stripes: 2, degree: 0 }): Standing {
  return { current, time_at_current_days: 800, promotions };
}

describe('awardingPromotion', () => {
  it('finds the promotion that granted the held rank', () => {
    const held = promo({ id: 'held' });
    const older = promo({ id: 'older', belt: 'blue', stripes: 4, academy: 'Somewhere else' });
    expect(awardingPromotion(standing([older, held]))?.id).toBe('held');
  });

  it('matches on stripes and degree, not just the belt colour', () => {
    // Purple with 2 stripes and purple with 4 are the same colour and a
    // different rank; taking the first purple would put the wrong date and
    // the wrong school under a belt the athlete can see is theirs.
    const twoStripe = promo({ id: 'two', stripes: 2 });
    const fourStripe = promo({ id: 'four', stripes: 4, academy: 'Later gym' });
    expect(awardingPromotion(standing([fourStripe, twoStripe]))?.id).toBe('two');
  });

  it('prefers the latest date when the same rank was recorded twice', () => {
    // A correction or a re-entry. The date the athlete stated most recently is
    // the one they mean.
    const first = promo({ id: 'first', promoted_on: '2023-01-01' });
    const corrected = promo({ id: 'corrected', promoted_on: '2024-03-12' });
    expect(awardingPromotion(standing([first, corrected]))?.id).toBe('corrected');
    expect(awardingPromotion(standing([corrected, first]))?.id).toBe('corrected');
  });

  it('prefers a dated promotion over an undated one, whichever was typed first', () => {
    const dated = promo({ id: 'dated', promoted_on: '2024-03-12' });
    const undated = promo({ id: 'undated', promoted_on: null });
    expect(awardingPromotion(standing([undated, dated]))?.id).toBe('dated');
    expect(awardingPromotion(standing([dated, undated]))?.id).toBe('dated');
  });

  it('still answers when every candidate is undated', () => {
    const a = promo({ id: 'a', promoted_on: null });
    expect(awardingPromotion(standing([a]))?.id).toBe('a');
  });

  it('returns null rather than inventing a school when nothing matches', () => {
    // Reachable: the rank is derived server-side from the highest promotion,
    // and the athlete can then edit that promotion.
    const other = promo({ id: 'other', belt: 'blue', stripes: 0 });
    expect(awardingPromotion(standing([other]))).toBeNull();
    expect(awardingPromotion(standing([]))).toBeNull();
  });

  it('returns null when no rank is held at all', () => {
    expect(awardingPromotion({ current: null, time_at_current_days: null, promotions: [promo()] })).toBeNull();
  });
});

describe('formatAwardDate', () => {
  it('runs west of Greenwich, or the next test proves nothing', () => {
    // The whole bug is invisible in UTC, so this suite sets
    // `TZ=America/Los_Angeles` on the jest command in package.json — at
    // process launch, which is the only place it takes.
    //
    // **Assigning `process.env.TZ` from inside the test does not work.** Jest
    // hands the sandbox a copied `process`, so the write never reaches the
    // runtime and V8 is never notified; the zone silently stays UTC and the
    // buggy implementation passes. That is exactly what the first version of
    // this file did. This assertion exists so the guard cannot rot back into
    // a no-op without going red.
    expect(new Date().getTimezoneOffset()).toBeGreaterThan(0);
  });

  it('renders the day that was typed, not the day before it', () => {
    // `new Date('2024-03-12')` is UTC midnight, which renders as 11 March
    // in the zone above. Parsing from parts is the whole point.
    const out = formatAwardDate('2024-03-12');
    expect(out).toContain('12');
    expect(out).toContain('2024');
    expect(out).not.toContain('11');
  });

  it('keeps the year, which is the part anyone quotes', () => {
    expect(formatAwardDate('2019-11-01')).toContain('2019');
  });

  it('falls back to the raw value rather than rendering Invalid Date', () => {
    expect(formatAwardDate('not-a-date')).toBe('not-a-date');
    expect(formatAwardDate('')).toBe('');
  });
});

function record(kind: RecordKind, value: number, over: Partial<PersonalRecord> = {}): PersonalRecord {
  return {
    kind,
    value,
    reps: 8,
    weight_kg: 60,
    seconds: null,
    distance_m: null,
    rir: null,
    rpe: null,
    achieved_at: '2026-08-03T10:00:00Z',
    session_id: 's1',
    is_recent: true,
    ...over,
  };
}

describe('formatRecord', () => {
  it('keeps the decimals on a measured lift', () => {
    // 62.55kg is what was on the bar.
    expect(formatRecord(record('heaviest_weight', 62.55), 'metric')).toBe('62.55kg');
  });

  it('rounds an estimated 1RM to a whole unit', () => {
    // A rep-max curve's output is not a measurement, and "74.48kg" invites
    // reading a modelled number as one.
    expect(formatRecord(record('estimated_1rm', 74.48), 'metric')).toBe('74kg');
    expect(formatRecord(record('estimated_1rm', 74.48), 'imperial')).toBe('164lb');
  });

  it('renders each remaining kind in its own unit', () => {
    expect(formatRecord(record('most_reps', 12), 'metric')).toBe('12');
    expect(formatRecord(record('longest_time', 185), 'metric')).toBe('3m 5s');
    expect(formatRecord(record('longest_time', 45), 'metric')).toBe('45s');
    expect(formatRecord(record('furthest_distance', 5000), 'metric')).toBe('5 km');
  });

  it('covers every kind the API can send', () => {
    // A new RecordKind that falls through returns undefined and renders as
    // nothing at all, which looks like a record with no value.
    const kinds: RecordKind[] = [
      'heaviest_weight',
      'estimated_1rm',
      'most_reps',
      'longest_time',
      'furthest_distance',
    ];
    for (const k of kinds) {
      expect(typeof formatRecord(record(k, 100), 'metric')).toBe('string');
    }
  });
});
