import {
  adjustStepFor,
  defaultDurationUnit,
  durationInputUnit,
  durationUnitKey,
  formatDuration,
  fromDisplayDuration,
  parseDurationUnit,
  toDisplayDuration,
} from '../duration';

/**
 * Seconds and minutes, with the same discipline `units.test.ts` holds weight to:
 * **storage never changes**, so every conversion has to round-trip.
 */
describe('display conversion', () => {
  it('leaves seconds alone', () => {
    expect(toDisplayDuration(45, 'seconds')).toBe(45);
    expect(fromDisplayDuration(45, 'seconds')).toBe(45);
  });

  it('round-trips a duration that is not a whole minute', () => {
    // 45s through a minutes field is the case two decimals exist for: at one
    // decimal it renders 0.8 and comes back as 48 seconds, silently lengthening
    // a set nobody edited.
    expect(toDisplayDuration(45, 'minutes')).toBe(0.75);
    expect(fromDisplayDuration(0.75, 'minutes')).toBe(45);
  });

  it('round-trips whole minutes', () => {
    expect(toDisplayDuration(240, 'minutes')).toBe(4);
    expect(fromDisplayDuration(4, 'minutes')).toBe(240);
  });

  it('always stores an integer number of seconds', () => {
    // `seconds` is an integer on the wire; a fractional one fails Go's decode
    // and comes back as a generic "invalid JSON body" naming no field.
    expect(Number.isInteger(fromDisplayDuration(1.51, 'minutes'))).toBe(true);
    expect(fromDisplayDuration(1.51, 'minutes')).toBe(91);
  });
});

describe('how the number reads', () => {
  it('writes seconds the way a whiteboard does', () => {
    expect(formatDuration(45, 'seconds')).toBe('45s');
    expect(formatDuration(180, 'seconds')).toBe('180s');
  });

  it('writes minutes as a clock face, not as a decimal', () => {
    // The athlete is about to watch this count down; the summary and the clock
    // should say the same thing. "1.5min" and "1:30" do not.
    expect(formatDuration(90, 'minutes')).toBe('1:30');
    expect(formatDuration(240, 'minutes')).toBe('4:00');
    expect(formatDuration(45, 'minutes')).toBe('0:45');
  });

  it('renders nothing as an em dash rather than as zero', () => {
    expect(formatDuration(null, 'seconds')).toBe('—');
    expect(formatDuration(undefined, 'minutes')).toBe('—');
  });

  it('never renders a negative duration', () => {
    expect(formatDuration(-30, 'seconds')).toBe('0s');
    expect(formatDuration(-30, 'minutes')).toBe('0:00');
  });
});

describe('the ± step follows the unit', () => {
  it('nudges by fifteen seconds on a plank and thirty on a round', () => {
    // The whole reason the unit reaches the timer rather than stopping at the
    // input: ±15 on a five-minute round is a rounding error, and the button has
    // to say a number that means something at the scale you are working at.
    expect(adjustStepFor('seconds')).toBe(15);
    expect(adjustStepFor('minutes')).toBe(30);
  });
});

describe('which unit a duration is read in when nobody has said', () => {
  it('reads short holds in seconds and long rounds in minutes', () => {
    expect(defaultDurationUnit(45)).toBe('seconds');
    expect(defaultDurationUnit(90)).toBe('seconds');
    expect(defaultDurationUnit(120)).toBe('minutes');
    expect(defaultDurationUnit(300)).toBe('minutes');
  });

  it('falls back to seconds for a set with no prescription', () => {
    expect(defaultDurationUnit(null)).toBe('seconds');
    expect(defaultDurationUnit(undefined)).toBe('seconds');
  });
});

describe('the stored preference', () => {
  it('is scoped per exercise', () => {
    expect(durationUnitKey('plank')).toBe('dur:plank');
    expect(durationUnitKey('plank')).not.toBe(durationUnitKey('burpee'));
  });

  it('answers null for anything it does not recognise', () => {
    // Null, not the default, so the session screen can tell "never chosen" from
    // "chosen, and it happens to be seconds" — the map holds only genuine
    // overrides, and everything else falls through to the prescription's scale.
    expect(parseDurationUnit(null)).toBeNull();
    expect(parseDurationUnit('')).toBeNull();
    expect(parseDurationUnit('hours')).toBeNull();
    expect(parseDurationUnit('seconds')).toBe('seconds');
    expect(parseDurationUnit('minutes')).toBe('minutes');
  });
});

describe('the input suffix', () => {
  it('names the unit the field takes', () => {
    expect(durationInputUnit('seconds')).toBe('s');
    expect(durationInputUnit('minutes')).toBe('min');
  });
});
