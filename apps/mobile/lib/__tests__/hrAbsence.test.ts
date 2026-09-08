import { RETRY_WINDOW_DAYS } from '../biometric';
import { hrAbsenceCopy, hrAbsenceState, syncNowButtonVisible, syncNowOutcomeCopy } from '../hrAbsence';

/**
 * W18/#957 — the no-HR card's state machine and its copy, proven apart from
 * the component (`components/__tests__/HRSessionReport.test.tsx` proves the
 * component renders whichever state this hands it).
 */

const now = new Date('2026-09-10T12:00:00.000Z');
const endedHoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();

describe('hrAbsenceState', () => {
  it("is 'loading' until the sync-toggle read answers", () => {
    expect(hrAbsenceState({ syncOn: null, endedAt: endedHoursAgo(1), now })).toBe('loading');
  });

  it("is 'sync_off' when sync is off, whatever the session's age", () => {
    expect(hrAbsenceState({ syncOn: false, endedAt: endedHoursAgo(1), now })).toBe('sync_off');
    expect(hrAbsenceState({ syncOn: false, endedAt: endedHoursAgo(24 * 30), now })).toBe('sync_off');
  });

  it("is 'checking' for a fresh session with sync on — the orchestrator is still on it", () => {
    expect(hrAbsenceState({ syncOn: true, endedAt: endedHoursAgo(0.1), now })).toBe('checking');
    expect(hrAbsenceState({ syncOn: true, endedAt: endedHoursAgo(24), now })).toBe('checking');
  });

  it("flips to 'gave_up' exactly where needsEnrichmentAttempt's window closes (inclusive bound)", () => {
    expect(hrAbsenceState({ syncOn: true, endedAt: endedHoursAgo(RETRY_WINDOW_DAYS * 24), now })).toBe('checking');
    const justPast = new Date(now.getTime() - RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000 - 1).toISOString();
    expect(hrAbsenceState({ syncOn: true, endedAt: justPast, now })).toBe('gave_up');
  });

  it("is 'loading' for a missing or unparseable end — never a confident sentence about nothing", () => {
    expect(hrAbsenceState({ syncOn: true, endedAt: null, now })).toBe('loading');
    expect(hrAbsenceState({ syncOn: true, endedAt: undefined, now })).toBe('loading');
    expect(hrAbsenceState({ syncOn: true, endedAt: 'not-a-date', now })).toBe('loading');
  });
});

describe('syncNowButtonVisible', () => {
  it('shows only when sync is on — checking or gave_up', () => {
    expect(syncNowButtonVisible('checking')).toBe(true);
    expect(syncNowButtonVisible('gave_up')).toBe(true);
    expect(syncNowButtonVisible('sync_off')).toBe(false);
    expect(syncNowButtonVisible('loading')).toBe(false);
  });
});

describe('hrAbsenceCopy', () => {
  it('names the platform source in every state that mentions Health', () => {
    for (const state of ['sync_off', 'checking', 'gave_up'] as const) {
      expect(hrAbsenceCopy(state, 'Apple Health')).toContain('Apple Health');
      expect(hrAbsenceCopy(state, 'Health Connect')).toContain('Health Connect');
    }
  });

  it("'checking' says the data is not there YET and that VOLA keeps checking — the sentence #957 was missing", () => {
    const copy = hrAbsenceCopy('checking', 'Apple Health');
    expect(copy).toMatch(/yet/);
    expect(copy).toMatch(/keeps checking/);
    expect(copy).toContain(`${RETRY_WINDOW_DAYS} days`);
  });

  it("'gave_up' says the checking has stopped, and does not promise more automatic checks", () => {
    const copy = hrAbsenceCopy('gave_up', 'Apple Health');
    expect(copy).toMatch(/checked .* for/);
    expect(copy).not.toMatch(/keeps checking/);
  });

  it("'sync_off' points at Settings and nowhere else", () => {
    expect(hrAbsenceCopy('sync_off', 'Health Connect')).toMatch(/Settings/);
    expect(hrAbsenceCopy('sync_off', 'Health Connect')).not.toMatch(/yet/);
  });
});

describe('syncNowOutcomeCopy', () => {
  it("'found' says how many, in words — the sentence #957 asks for, shown until the report replaces the card", () => {
    expect(syncNowOutcomeCopy({ status: 'found', sampleCount: 12 }, 'Apple Health')).toMatch(/^Found 12 heart-rate samples/);
    expect(syncNowOutcomeCopy({ status: 'found', sampleCount: 1 }, 'Apple Health')).toMatch(/^Found 1 heart-rate sample /);
  });

  it('every other outcome is a sentence, and the Health ones name the source', () => {
    expect(syncNowOutcomeCopy({ status: 'none' }, 'Apple Health')).toContain('Apple Health');
    expect(syncNowOutcomeCopy({ status: 'sync_off' }, 'Health Connect')).toContain('Health Connect');
    expect(syncNowOutcomeCopy({ status: 'no_hrmax' }, 'Apple Health')).toMatch(/date of birth/);
    expect(syncNowOutcomeCopy({ status: 'error' }, 'Apple Health')).toMatch(/Try again/);
  });
});
