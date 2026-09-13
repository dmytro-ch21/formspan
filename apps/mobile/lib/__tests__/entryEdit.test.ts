import { displayAmount, readAmount } from '../entryEdit';
import { toDisplayFluid } from '../units';

/**
 * N437: the correction screen's field. The round trip is the thing to pin: a
 * conversion that rounds must not turn "opened it and pressed Save" into a
 * different stored amount and a push the athlete never asked for.
 */
describe('an untouched field writes nothing', () => {
  it('hands back the stored millilitres for an imperial athlete, not the rounded fl oz', () => {
    const shown = displayAmount('ml', 250, 'imperial');
    // Not vacuous: the display really is rounded away from the stored value.
    expect(Number(shown)).toBe(toDisplayFluid(250, 'imperial'));
    expect(readAmount(shown, 'ml', 250, 'imperial')).toEqual({ amount: 250, changed: false });
  });

  it('treats surrounding spaces as untouched too', () => {
    expect(readAmount(' 250 ', 'ml', 250, 'metric')).toEqual({ amount: 250, changed: false });
  });
});

describe('a typed amount is stored in the tracker unit', () => {
  it('converts fl oz back to millilitres', () => {
    const read = readAmount('16.9', 'ml', 250, 'imperial');
    expect('amount' in read && read.changed).toBe(true);
    expect('amount' in read && Math.round(read.amount)).toBe(500);
  });

  it('keeps millilitres as typed for a metric athlete', () => {
    expect(readAmount('500', 'ml', 250, 'metric')).toEqual({ amount: 500, changed: true });
  });

  it('does not convert cups, doses, grams or milligrams', () => {
    expect(readAmount('2', 'cup', 1, 'imperial')).toEqual({ amount: 2, changed: true });
    expect(readAmount('10', 'g', 5, 'imperial')).toEqual({ amount: 10, changed: true });
    expect(readAmount('95', 'mg', 63, 'imperial')).toEqual({ amount: 95, changed: true });
  });

  it('typing the same number again is not a change', () => {
    expect(readAmount('1.0', 'cup', 1, 'metric')).toEqual({ amount: 1, changed: false });
  });
});

describe('an amount that cannot be stored is refused before anything is written', () => {
  it.each(['', '0', '-250', 'abc', 'Infinity'])('refuses %p', (typed) => {
    expect(readAmount(typed, 'ml', 250, 'metric')).toEqual({ error: 'Enter an amount greater than zero.' });
  });
});
