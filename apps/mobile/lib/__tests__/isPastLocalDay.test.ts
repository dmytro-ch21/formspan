import { isPastLocalDay } from '../sessions';

/**
 * The day-boundary guard behind "Correct this session" (N435) — a finished
 * session becomes editable only once its own calendar day is over, in the
 * device's local time. `now` is always passed explicitly so none of this
 * depends on the real clock.
 */
describe('isPastLocalDay', () => {
  it('is false for a session that started earlier today', () => {
    const now = new Date('2026-08-28T18:00:00');
    expect(isPastLocalDay('2026-08-28T07:00:00', now)).toBe(false);
  });

  it('is true for a session from yesterday', () => {
    const now = new Date('2026-08-28T09:00:00');
    expect(isPastLocalDay('2026-08-27T18:00:00', now)).toBe(true);
  });

  it('flips at midnight even minutes apart, not after some elapsed duration', () => {
    // 11:58pm yesterday, two minutes before midnight — still "today" then,
    // but "yesterday" the moment the clock crosses over, regardless of how
    // little time has actually passed. An elapsed-hours cutoff would keep
    // this false for hours; the calendar-day boundary flips it immediately.
    const justBeforeMidnight = new Date('2026-08-27T23:58:00');
    expect(isPastLocalDay('2026-08-27T23:58:00', justBeforeMidnight)).toBe(false);

    const justAfterMidnight = new Date('2026-08-28T00:01:00');
    expect(isPastLocalDay('2026-08-27T23:58:00', justAfterMidnight)).toBe(true);
  });

  it('is true for a session from a week ago', () => {
    const now = new Date('2026-08-28T12:00:00');
    expect(isPastLocalDay('2026-08-21T12:00:00', now)).toBe(true);
  });

  it('is false for a FUTURE local day, not just "any different day"', () => {
    // A rolled-back device clock, or a session synced from a device several
    // timezones east, can hand this a timestamp on a day later than `now`.
    // `!==` would call that "past" too and wrongly unlock editing on a
    // session that, locally, hasn't happened yet.
    const now = new Date('2026-08-28T12:00:00');
    expect(isPastLocalDay('2026-08-29T00:30:00', now)).toBe(false);
  });

  it('handles a real UTC (`Z`-suffixed) timestamp, not just local-time strings', () => {
    // Production `started_at` is always UTC (`toISOString()` / server
    // RFC3339), never a bare local-time string like the fixtures above. The
    // interesting case this function exists for is a `Z` timestamp that
    // falls on a different UTC day than its LOCAL day — assert against the
    // function's own local-day semantics, not a raw string comparison, so
    // this stays true regardless of the machine's timezone.
    const now = new Date('2026-08-28T12:00:00');
    const yesterdayZ = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 18, 0, 0).toISOString();
    expect(isPastLocalDay(yesterdayZ, now)).toBe(true);
  });

  it('defaults `now` to the real clock when not supplied', () => {
    // Not asserting a value — only that it runs against a real Date() and
    // returns a boolean, so the default parameter itself is exercised.
    expect(typeof isPastLocalDay(new Date().toISOString())).toBe('boolean');
  });
});
