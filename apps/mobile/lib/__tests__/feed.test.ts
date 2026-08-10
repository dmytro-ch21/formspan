import { agoLabel, cardFromFeedItem, feedMetrics, type FeedItem } from '../feed';

/**
 * The two pure pieces of the feed, which is all of it that can be pinned here.
 *
 * `agoLabel` takes `now` as an argument rather than reading the clock, and
 * that is the only reason it is testable at all: a relative formatter that
 * calls `Date.now()` itself produces different output while you are asserting
 * on it, and the screen would have no way to make a list agree with itself
 * across a re-render.
 */

const item = (over: Partial<FeedItem> = {}): FeedItem => ({
  id: 'f1',
  from: 'rhonda',
  display_name: 'Rhonda',
  sport: 'strength',
  name: 'Push day',
  started_at: '2026-08-07T10:00:00Z',
  ended_at: '2026-08-07T11:00:00Z',
  working_sets: 12,
  tonnage_kg: 4200,
  ...over,
});

describe('how long ago', () => {
  const now = Date.parse('2026-08-07T12:00:00Z');

  it('rounds DOWN, so nothing is reported before it happened', () => {
    // A feed that rounds up says a session finished earlier than it did, which
    // is the one direction that cannot be excused as approximation.
    //
    // THE HALFWAY CASES ARE THE TEST. 55m and 61m read the same under `floor`
    // and `round`, so a version of this test using only those passes against
    // `Math.round` — which is exactly the mutation it exists to catch. These
    // are the ones that separate them: 90 minutes is "1h ago", not "2h ago".
    expect(agoLabel('2026-08-07T10:30:00Z', now)).toBe('1h ago'); // 90 min
    expect(agoLabel('2026-08-07T11:58:30Z', now)).toBe('1m ago'); // 90 sec
    expect(agoLabel('2026-08-06T00:00:00Z', now)).toBe('1d ago'); // 36 hours
    // EVERY unit, not just the first three. Review mutated `floor` to `round`
    // on the weeks and months lines alone and the whole suite stayed green:
    // 7 days and 61 days happen to land where the two agree, so the cases
    // above cover minutes, hours and days and nothing else.
    expect(agoLabel('2026-07-26T12:00:00Z', now)).toBe('1w ago'); // 12 days
    expect(agoLabel('2026-06-22T12:00:00Z', now)).toBe('1mo ago'); // 46 days
    // And the ordinary cases, which should also hold.
    expect(agoLabel('2026-08-07T11:05:00Z', now)).toBe('55m ago');
    expect(agoLabel('2026-08-07T11:00:00Z', now)).toBe('1h ago');
    expect(agoLabel('2026-08-07T10:59:00Z', now)).toBe('1h ago');
  });

  it('crosses from "just now" to a count at exactly a minute', () => {
    // `< 60` versus `<= 60` — the boundary nothing else here touches.
    expect(agoLabel('2026-08-07T11:59:01Z', now)).toBe('just now');
    expect(agoLabel('2026-08-07T11:59:00Z', now)).toBe('1m ago');
  });

  it('climbs through the units', () => {
    expect(agoLabel('2026-08-07T11:59:30Z', now)).toBe('just now');
    expect(agoLabel('2026-08-07T11:58:00Z', now)).toBe('2m ago');
    expect(agoLabel('2026-08-06T12:00:00Z', now)).toBe('1d ago');
    expect(agoLabel('2026-07-31T12:00:00Z', now)).toBe('1w ago');
    expect(agoLabel('2026-06-07T12:00:00Z', now)).toBe('2mo ago');
    expect(agoLabel('2024-06-07T12:00:00Z', now)).toBe('over a year ago');
  });

  it('says "just now" rather than a time in the future', () => {
    // Phone and server clocks disagree, and a session can arrive stamped a few
    // seconds ahead. "in 3 minutes" on a finished session reads as a bug.
    expect(agoLabel('2026-08-07T12:00:30Z', now)).toBe('just now');
    expect(agoLabel('2026-08-07T12:05:00Z', now)).toBe('just now');
  });

  it('renders nothing for an unparseable date rather than "NaN ago"', () => {
    expect(agoLabel('not a date', now)).toBe('');
    expect(agoLabel('', now)).toBe('');
  });
});

describe('the chips under a row', () => {
  it('omits a measure rather than showing a zero', () => {
    // The rule the Today tab's cards already follow: "0 sets" on a BJJ session
    // reads as abandoned, when the truth is that sets are not how that
    // discipline is measured. A missing chip says nothing; a zero says
    // something false.
    const bjj = item({ sport: 'bjj', working_sets: 0, tonnage_kg: 0 });
    const labels = feedMetrics(bjj, 'metric').map((m) => m.label);
    expect(labels).toEqual(['time']);
    expect(labels).not.toContain('sets');
    expect(labels).not.toContain('volume');
  });

  it('shows what there is to show', () => {
    const chips = feedMetrics(item(), 'metric');
    // Through the SHARED formatters, not local arithmetic: `formatDuration`
    // renders a whole hour as "1h", and `formatVolume` abbreviates past a
    // tonne. Reimplemented here first, and both diverged.
    expect(chips).toEqual([
      { label: 'time', value: '1h' },
      { label: 'sets', value: '12' },
      { label: 'volume', value: '4.2t' },
    ]);
  });

  it('reads a long session in hours and minutes', () => {
    const long = item({ started_at: '2026-08-07T09:00:00Z', ended_at: '2026-08-07T11:45:00Z' });
    expect(feedMetrics(long, 'metric')[0]).toEqual({ label: 'time', value: '2h 45m' });
  });

  it('drops the time chip when the session has no measurable length', () => {
    // A session finished at the instant it started is a sync artefact, not a
    // workout of zero minutes — and "0m" beside a real set count is the kind
    // of number that makes people distrust the rest of the row.
    const instant = item({ started_at: '2026-08-07T11:00:00Z', ended_at: '2026-08-07T11:00:00Z' });
    expect(feedMetrics(instant, 'metric').map((m) => m.label)).toEqual(['sets', 'volume']);
  });
});

describe('volume speaks the athlete’s units', () => {
  it('renders pounds for an imperial athlete', () => {
    // Storage is kilograms and conversion happens at the last possible moment
    // on the way out — `units.ts` states the rule. This was hardcoded `kg`
    // first, which would have shown friends' training in a unit an imperial
    // athlete never uses, on the one surface where the numbers are somebody
    // else's and hardest to sanity-check.
    const metric = feedMetrics(item(), 'metric').find((m) => m.label === 'volume');
    const imperial = feedMetrics(item(), 'imperial').find((m) => m.label === 'volume');
    expect(metric?.value).toBe('4.2t');
    expect(imperial?.value).toBe('9,259lb');
    expect(imperial?.value).not.toContain('kg');
  });
});

describe("a friend's card", () => {
  const now = Date.parse('2026-08-07T13:00:00Z');

  it('carries no badge, because a PR is derived from a history you cannot see', () => {
    // The completion card earns badges from `summary.records` and a streak,
    // both of which are the OWNER's data. A feed row carries neither, so the
    // only honest number of badges is none — inferring one from volume would
    // be the card claiming something the server never said.
    const card = cardFromFeedItem(item(), 'metric', now);
    expect(card.badges).toEqual([]);
    expect(card.highlight).toBeUndefined();
  });

  it('shows no handle, so the foot reads as the wordmark and not a signature', () => {
    // The attribution sits above the card in the feed. Passing the handle too
    // would print the person twice on every post, six inches apart.
    expect(cardFromFeedItem(item(), 'metric', now).handle).toBeUndefined();
  });

  it('never invents calories or a score for somebody else', () => {
    // Both exist on your own card and neither may cross to a reader: the
    // calorie estimate is computed from the owner's bodyweight, height, age
    // and sex, and the score is a percentile against a history the reader
    // cannot see. The strip is time, sets and volume — the three things a
    // feed row has always carried.
    const labels = cardFromFeedItem(item(), 'metric', now).stats.map((s) => s.label);
    expect(labels).toEqual(['time', 'sets', 'volume']);
    expect(labels).not.toContain('Calories');
    expect(labels).not.toContain('VOLA score');
  });

  it('passes the detail through, and survives a server that never sends it', () => {
    // `detail` is absent on an older response shape and empty when the owner
    // has not opted in. Both must land on an empty array rather than
    // undefined — the card maps over it without a guard.
    const withDetail = cardFromFeedItem(
      item({ detail: [{ name: 'Back Squat', figure: '140 kg × 5' }], more: 2 }),
      'metric',
      now,
    );
    expect(withDetail.detail).toEqual([{ name: 'Back Squat', figure: '140 kg × 5' }]);
    expect(withDetail.more).toBe(2);

    const without = cardFromFeedItem(item(), 'metric', now);
    expect(without.detail).toEqual([]);
    expect(without.more).toBe(0);
  });

  it('leads with how recent it is, not with the date', () => {
    // A feed is scanned for recency. Your own card records a day; this one
    // answers "how long ago", which is the question being asked here.
    expect(cardFromFeedItem(item(), 'metric', now).dateLabel).toBe('2H AGO');
  });

  it('reads volume in the athlete’s own units', () => {
    // The one surface where the numbers are somebody else's and therefore
    // hardest to sanity-check — an imperial athlete reading kilograms would
    // have no way to notice. `feedMetrics` already had this bug once.
    const imperial = cardFromFeedItem(item(), 'imperial', now).stats.find(
      (s) => s.label === 'volume',
    );
    expect(imperial?.value).not.toMatch(/kg/);
  });

  it('names an unnamed session after its sport rather than leaving it blank', () => {
    expect(cardFromFeedItem(item({ name: '', sport: 'bjj' }), 'metric', now).title).toBe(
      'BJJ session',
    );
  });
});
