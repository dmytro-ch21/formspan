import { stepMeta, stepName, stepSummary, type Sequence, type SequenceStep } from '../sequences';

/**
 * The three pure helpers behind the sequence read-back screens (N80, #414).
 *
 * **Every expectation here is a LITERAL**, deliberately. The obvious way to
 * write these is to rebuild the expected string from the same template the
 * function uses — `` expect(stepSummary(s)).toBe(`${s.step_count} steps`) `` —
 * which is true by construction: it survives the pluralisation being inverted,
 * the separator changing and the fields being swapped. Review caught exactly
 * that shape in this repo the day before this landed, in two tests that both
 * stayed green when the constant they asserted moved.
 */

const chain = (over: Partial<Sequence> = {}): Sequence => ({
  id: 's1',
  name: 'Knee cut off the break',
  description: '',
  start_position_id: null,
  step_count: 3,
  editable: true,
  ...over,
});

const step = (over: Partial<SequenceStep> = {}): SequenceStep => ({
  technique_id: 'knee-cut',
  ends_at_position_id: null,
  notes: '',
  ...over,
});

describe('stepSummary', () => {
  it('pluralises on the count', () => {
    expect(stepSummary(chain({ step_count: 3 }))).toBe('3 steps');
    expect(stepSummary(chain({ step_count: 1 }))).toBe('1 step');
    // Zero is plural, and it is reachable: a chain whose steps were cleared on
    // web still lists, and the reflection wizard filters `step_count > 0` for
    // its chips precisely because such rows exist.
    expect(stepSummary(chain({ step_count: 0 }))).toBe('0 steps');
  });

  it('names the starting position when there is one', () => {
    expect(stepSummary(chain({ step_count: 4, start_position_name: 'Closed guard' }))).toBe(
      '4 steps · from Closed guard',
    );
  });

  it('says nothing about a position that was never recorded', () => {
    // `start_position_id` is nullable and `start_position_name` is omitted by
    // the server rather than sent empty. "from " with nothing after it is the
    // failure this arm exists for.
    expect(stepSummary(chain({ step_count: 2, start_position_name: '' }))).toBe('2 steps');
    expect(stepSummary(chain({ step_count: 2 }))).toBe('2 steps');
  });
});

describe('stepName', () => {
  it('prefers the library name the server resolved', () => {
    expect(stepName(step({ name: 'Knee cut pass' }), {})).toBe('Knee cut pass');
  });

  it('falls back to a locally resolved name', () => {
    // A row still in this device's outbox has no `name` — the server resolves
    // it on read and has never seen this chain.
    expect(stepName(step(), { 'knee-cut': 'Knee cut pass' })).toBe('Knee cut pass');
  });

  it('returns undefined rather than the id', () => {
    // The whole point. `knee-cut` is not a name, and a screen rendering it as
    // one makes a false claim that looks exactly like a working fallback.
    expect(stepName(step(), {})).toBeUndefined();
    expect(stepName(step(), { 'other-technique': 'Something else' })).toBeUndefined();
  });

  it('does not let an empty server name mask a resolvable one', () => {
    // An older server sends `""` rather than omitting the field.
    expect(stepName(step({ name: '' }), { 'knee-cut': 'Knee cut pass' })).toBe('Knee cut pass');
  });
});

describe('stepMeta', () => {
  it('joins position and category', () => {
    expect(stepMeta(step({ position: 'combat base', category: 'pass' }))).toBe(
      'combat base · pass',
    );
  });

  it('drops whichever half is missing, without a dangling separator', () => {
    expect(stepMeta(step({ position: 'combat base' }))).toBe('combat base');
    expect(stepMeta(step({ category: 'pass' }))).toBe('pass');
  });

  it('is empty for a local capture, which has neither', () => {
    // Empty rather than ' · ' — the caller skips the line on empty, and a
    // whitespace-plus-separator string is truthy.
    expect(stepMeta(step())).toBe('');
    expect(stepMeta(step({ position: '', category: '' }))).toBe('');
  });
});
