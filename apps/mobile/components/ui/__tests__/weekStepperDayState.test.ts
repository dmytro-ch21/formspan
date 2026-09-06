import { weekStepperDayState } from '../WeekStepper';

/**
 * `weekStepperDayState` — the pure rule behind `WeekStepper`'s four states.
 *
 * Every branch pinned individually, including the one the component's own
 * comment calls out as a deliberate trade-off: `current` beats `rest`, not
 * the other way round.
 */
describe('weekStepperDayState', () => {
  it('is "current" for today, even when today has a plan', () => {
    expect(weekStepperDayState({ isToday: true, isPast: false, hasPlan: true })).toBe('current');
  });

  it('is "current" for today with no plan — it does not fall through to "rest"', () => {
    // The one deliberate trade-off this function makes: a rest day that is
    // also today still reads as "current" from this component. See its own
    // doc comment for why.
    expect(weekStepperDayState({ isToday: true, isPast: false, hasPlan: false })).toBe('current');
  });

  it('is "rest" for a past day with nothing planned', () => {
    expect(weekStepperDayState({ isToday: false, isPast: true, hasPlan: false })).toBe('rest');
  });

  it('is "rest" for a future day with nothing planned', () => {
    expect(weekStepperDayState({ isToday: false, isPast: false, hasPlan: false })).toBe('rest');
  });

  it('is "done" for a past day that had a plan', () => {
    expect(weekStepperDayState({ isToday: false, isPast: true, hasPlan: true })).toBe('done');
  });

  it('is "upcoming" for a future day that has a plan', () => {
    expect(weekStepperDayState({ isToday: false, isPast: false, hasPlan: true })).toBe('upcoming');
  });
});
