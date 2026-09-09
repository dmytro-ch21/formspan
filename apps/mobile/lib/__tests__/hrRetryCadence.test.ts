import {
  needsEnrichmentAttempt,
  retryCooldownMs,
  RETRY_COOLDOWN_HOURS,
  RETRY_HOURLY_UNDER_HOURS,
  RETRY_IMMEDIATE_UNDER_HOURS,
  RETRY_SHORT_COOLDOWN_HOURS,
  RETRY_WINDOW_DAYS,
  type EnrichmentLedgerEntry,
} from '../biometric';

/**
 * W18/#957 — the age-based retry cadence. `biometric.test.ts`'s own
 * `needsEnrichmentAttempt` block still proves the window/terminal rules;
 * this file proves the part that changed: how soon a fresh `'none'` is
 * re-asked, as a function of how old the session is.
 */

const HOUR = 60 * 60 * 1000;

describe('retryCooldownMs — the schedule itself', () => {
  it('is zero (every pass) while the session is under the immediate bound', () => {
    expect(retryCooldownMs(0)).toBe(0);
    expect(retryCooldownMs(1 * HOUR)).toBe(0);
    expect(retryCooldownMs(RETRY_IMMEDIATE_UNDER_HOURS * HOUR - 1)).toBe(0);
  });

  it('is the short cooldown from the immediate bound up to the hourly bound', () => {
    expect(retryCooldownMs(RETRY_IMMEDIATE_UNDER_HOURS * HOUR)).toBe(RETRY_SHORT_COOLDOWN_HOURS * HOUR);
    expect(retryCooldownMs(5 * HOUR)).toBe(RETRY_SHORT_COOLDOWN_HOURS * HOUR);
    expect(retryCooldownMs(RETRY_HOURLY_UNDER_HOURS * HOUR - 1)).toBe(RETRY_SHORT_COOLDOWN_HOURS * HOUR);
  });

  it('is the long-tail cooldown from the hourly bound onward', () => {
    expect(retryCooldownMs(RETRY_HOURLY_UNDER_HOURS * HOUR)).toBe(RETRY_COOLDOWN_HOURS * HOUR);
    expect(retryCooldownMs(48 * HOUR)).toBe(RETRY_COOLDOWN_HOURS * HOUR);
  });

  it('the three tiers are ordered — each is strictly longer than the one before', () => {
    // A schedule that got slower for FRESHER sessions would be the original
    // bug with extra steps; pin the shape, not just the numbers.
    expect(0).toBeLessThan(RETRY_SHORT_COOLDOWN_HOURS);
    expect(RETRY_SHORT_COOLDOWN_HOURS).toBeLessThan(RETRY_COOLDOWN_HOURS);
    expect(RETRY_IMMEDIATE_UNDER_HOURS).toBeLessThan(RETRY_HOURLY_UNDER_HOURS);
    expect(RETRY_HOURLY_UNDER_HOURS).toBeLessThan(RETRY_WINDOW_DAYS * 24);
  });
});

describe('needsEnrichmentAttempt — cadence by session age', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const ended = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR).toISOString();
  const none = (attemptedMinutesAgo: number): EnrichmentLedgerEntry => ({
    hrSource: 'none',
    attemptedAt: new Date(now.getTime() - attemptedMinutesAgo * 60 * 1000).toISOString(),
  });

  it('a session that ended an hour ago, checked one minute ago, is asked AGAIN — the user-visible fix', () => {
    // This is the exact shape of #957: workout done, first pass found
    // nothing because the watch had not pushed yet, athlete reopens the app
    // a minute later. Pre-W18 this was false for the next 12 hours.
    expect(needsEnrichmentAttempt({ endedAt: ended(1) }, none(1), now)).toBe(true);
  });

  it('a session that ended 5 hours ago waits the short cooldown between checks', () => {
    expect(needsEnrichmentAttempt({ endedAt: ended(5) }, none(30), now)).toBe(false);
    expect(needsEnrichmentAttempt({ endedAt: ended(5) }, none(RETRY_SHORT_COOLDOWN_HOURS * 60), now)).toBe(true);
  });

  it('exactly at the immediate bound the short cooldown already applies (bound is exclusive)', () => {
    expect(needsEnrichmentAttempt({ endedAt: ended(RETRY_IMMEDIATE_UNDER_HOURS) }, none(1), now)).toBe(false);
  });

  it('a day-old session is back on the long-tail cadence', () => {
    expect(needsEnrichmentAttempt({ endedAt: ended(30) }, none(11 * 60), now)).toBe(false);
    expect(needsEnrichmentAttempt({ endedAt: ended(30) }, none(RETRY_COOLDOWN_HOURS * 60), now)).toBe(true);
  });

  it('exactly at the hourly bound the long-tail cooldown already applies (bound is exclusive)', () => {
    expect(needsEnrichmentAttempt({ endedAt: ended(RETRY_HOURLY_UNDER_HOURS) }, none(2 * 60), now)).toBe(false);
  });

  it('the retry window still ends everything — a fresh attempt on an old session is never asked', () => {
    // Cooldown long elapsed; the window is the only thing saying no.
    expect(needsEnrichmentAttempt({ endedAt: ended(RETRY_WINDOW_DAYS * 24 + 1) }, none(24 * 60), now)).toBe(
      false,
    );
  });

  it("a COVERED 'window' stays terminal at every age — real evidence is never re-asked, even a minute old", () => {
    const found: EnrichmentLedgerEntry = { hrSource: 'window', coverage: 'plausible', attemptedAt: ended(0) };
    expect(needsEnrichmentAttempt({ endedAt: ended(0.5) }, found, now)).toBe(false);
  });

  it("W19/#985: a THIN 'window' rides this same cadence rather than being terminal", () => {
    // The whole point of W19 is that "we found something" stopped meaning
    // "there is nothing left to find". A thin result is not exempt from the
    // ladder either — it gets exactly the ladder, which is what the two
    // assertions here are: the 5-hour tier's short cooldown, both sides.
    const thin = (minutesAgo: number): EnrichmentLedgerEntry => ({
      hrSource: 'window',
      coverage: 'thin',
      attemptedAt: ended(minutesAgo / 60),
    });
    expect(needsEnrichmentAttempt({ endedAt: ended(5) }, thin(30), now)).toBe(false);
    expect(needsEnrichmentAttempt({ endedAt: ended(5) }, thin(RETRY_SHORT_COOLDOWN_HOURS * 60), now)).toBe(true);
  });
});
