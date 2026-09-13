import {
  DAILY_NARRATIONS,
  NARRATION_DEBOUNCE_MS,
  NARRATION_WINDOW_MS,
  narrationSchedule,
  type NarrationEvent,
} from '../narrationTrigger';

/**
 * N570 (#1131): the owner's cadence as a pure function. Every boundary is
 * asserted from both sides, because an off-by-one here is either a
 * generation mid-entry or one the ceiling should have refused.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 8, 12, 19, 0, 0);
const meal = (at: number): NarrationEvent => ({ kind: 'meal-logged', at });

describe('the debounce', () => {
  it('is idle when nothing has happened', () => {
    expect(narrationSchedule({ events: [], generations: [], now: NOW })).toEqual({ kind: 'idle' });
  });

  it('waits until a full debounce has passed since the input, and is due exactly then', () => {
    const events = [meal(NOW)];
    expect(narrationSchedule({ events, generations: [], now: NOW + NARRATION_DEBOUNCE_MS - 1 })).toEqual({
      kind: 'waiting',
      dueAt: NOW + NARRATION_DEBOUNCE_MS,
    });
    expect(narrationSchedule({ events, generations: [], now: NOW + NARRATION_DEBOUNCE_MS })).toEqual({
      kind: 'due',
    });
  });

  it('turns a burst of logging into one generation, timed from the LAST input', () => {
    const events = [meal(NOW), meal(NOW + 4 * MIN), { kind: 'meal-changed', at: NOW + 9 * MIN } as NarrationEvent];
    const last = NOW + 9 * MIN;
    // Twelve minutes after the FIRST entry, the burst is still settling.
    expect(narrationSchedule({ events, generations: [], now: NOW + NARRATION_DEBOUNCE_MS })).toEqual({
      kind: 'waiting',
      dueAt: last + NARRATION_DEBOUNCE_MS,
    });
    expect(narrationSchedule({ events, generations: [], now: last + NARRATION_DEBOUNCE_MS })).toEqual({
      kind: 'due',
    });
  });

  it('is idle again once a generation has covered every input', () => {
    const events = [meal(NOW), meal(NOW + 9 * MIN)];
    expect(narrationSchedule({ events, generations: [NOW + 30 * MIN], now: NOW + 40 * MIN })).toEqual({
      kind: 'idle',
    });
  });

  it('starts a new wait for an input that lands after the last generation', () => {
    const events = [meal(NOW), { kind: 'workout-finished', at: NOW + 50 * MIN } as NarrationEvent];
    expect(narrationSchedule({ events, generations: [NOW + 30 * MIN], now: NOW + 50 * MIN + 1 })).toEqual({
      kind: 'waiting',
      dueAt: NOW + 50 * MIN + NARRATION_DEBOUNCE_MS,
    });
  });

  it('ignores an event stamped in the future, rather than waiting for it', () => {
    expect(narrationSchedule({ events: [meal(NOW + HOUR)], generations: [], now: NOW })).toEqual({
      kind: 'idle',
    });
  });

  it("keeps the debounce inside the owner's 10–15 minutes", () => {
    expect(NARRATION_DEBOUNCE_MS).toBeGreaterThanOrEqual(10 * MIN);
    expect(NARRATION_DEBOUNCE_MS).toBeLessThanOrEqual(15 * MIN);
  });
});

describe('the daily ceiling', () => {
  // Five earlier generations across the last day, the newest an hour ago, and
  // a meal logged half an hour ago: quiet long enough to be due.
  const fiveBefore = (oldest: number) => [oldest, NOW - 18 * HOUR, NOW - 12 * HOUR, NOW - 6 * HOUR, NOW - HOUR];
  const event = [meal(NOW - 30 * MIN)];

  it('refuses a generation the window has no room for, and says when room opens', () => {
    const generations = fiveBefore(NOW - 23 * HOUR);
    expect(generations).toHaveLength(DAILY_NARRATIONS);
    expect(narrationSchedule({ events: event, generations, now: NOW })).toEqual({
      kind: 'capped',
      resetsAt: NOW - 23 * HOUR + NARRATION_WINDOW_MS,
    });
  });

  it('frees a slot the moment the oldest generation leaves the window, and not a millisecond before', () => {
    expect(
      narrationSchedule({ events: event, generations: fiveBefore(NOW - NARRATION_WINDOW_MS), now: NOW }),
    ).toEqual({ kind: 'due' });
    expect(
      narrationSchedule({ events: event, generations: fiveBefore(NOW - NARRATION_WINDOW_MS + 1), now: NOW }),
    ).toEqual({ kind: 'capped', resetsAt: NOW + 1 });
  });

  it('allows the last slot under the ceiling', () => {
    const four = fiveBefore(NOW - 23 * HOUR).slice(1);
    expect(narrationSchedule({ events: event, generations: four, now: NOW })).toEqual({ kind: 'due' });
  });

  it('reports waiting, not capped, while input is still settling', () => {
    const generations = fiveBefore(NOW - 23 * HOUR);
    expect(narrationSchedule({ events: [meal(NOW - MIN)], generations, now: NOW })).toEqual({
      kind: 'waiting',
      dueAt: NOW - MIN + NARRATION_DEBOUNCE_MS,
    });
  });

  it("keeps the ceiling at the owner's 4–5 a day", () => {
    expect(DAILY_NARRATIONS).toBeGreaterThanOrEqual(4);
    expect(DAILY_NARRATIONS).toBeLessThanOrEqual(5);
  });
});
