import { apiRequest } from '../apiRequest';
import type { Exercise } from '../exercises';
import {
  bodyweightExerciseNames,
  describeBodyweight,
  getSessionBodyweight,
  parseSessionBodyweight,
} from '../sessionBodyweight';

// Hoisted above the imports by babel-jest, so `getSessionBodyweight` sees the mock.
jest.mock('../apiRequest', () => ({ apiRequest: jest.fn() }));

const request = apiRequest as jest.MockedFunction<typeof apiRequest>;
const getToken = async () => 't';

beforeEach(() => request.mockReset());

describe('parseSessionBodyweight', () => {
  test('reads both fields when the server sends both', () => {
    expect(
      parseSessionBodyweight({ bodyweight_kg: 82.4, bodyweight_measured_on: '2026-09-12' }),
    ).toEqual({ kg: 82.4, measuredOn: '2026-09-12' });
  });

  test('an explicit null is no check-in, and stays null', () => {
    expect(parseSessionBodyweight({ bodyweight_kg: null, bodyweight_measured_on: null })).toBeNull();
  });

  test('a server too old to send the fields is absent, never zero', () => {
    expect(parseSessionBodyweight({})).toBeNull();
    expect(parseSessionBodyweight(null)).toBeNull();
    expect(parseSessionBodyweight(undefined)).toBeNull();
  });

  test('half an answer is no answer', () => {
    expect(parseSessionBodyweight({ bodyweight_kg: 82.4, bodyweight_measured_on: null })).toBeNull();
    expect(parseSessionBodyweight({ bodyweight_kg: null, bodyweight_measured_on: '2026-09-12' })).toBeNull();
  });

  test('a value that cannot be a weigh-in is dropped rather than shown', () => {
    expect(parseSessionBodyweight({ bodyweight_kg: 0, bodyweight_measured_on: '2026-09-12' })).toBeNull();
    expect(parseSessionBodyweight({ bodyweight_kg: 82.4, bodyweight_measured_on: '12/09/2026' })).toBeNull();
  });
});

describe('describeBodyweight', () => {
  const bw = { kg: 82.4, measuredOn: '2026-09-12' };

  test('states the weight and the check-in it came from, in kilograms', () => {
    expect(describeBodyweight(bw, 'metric')).toBe('Bodyweight 82.4kg, from your 12 Sep check-in');
  });

  test('converts to pounds for an imperial athlete', () => {
    expect(describeBodyweight(bw, 'imperial')).toBe('Bodyweight 181.7lb, from your 12 Sep check-in');
  });

  // The suite runs in Los Angeles. A YYYY-MM-DD read with local getters
  // renames the 12th to the 11th, which would label the reading with the
  // wrong check-in.
  test('names the check-in day as stored, not shifted west of Greenwich', () => {
    expect(describeBodyweight({ kg: 70, measuredOn: '2026-01-01' }, 'metric')).toBe(
      'Bodyweight 70kg, from your 1 Jan check-in',
    );
  });

  test('nothing to say without a reading', () => {
    expect(describeBodyweight(null, 'metric')).toBeNull();
  });
});

describe('bodyweightExerciseNames', () => {
  const catalog = new Map<string, Pick<Exercise, 'load_type' | 'name'>>([
    ['pull-up', { name: 'Pull-up', load_type: 'reps' }],
    ['dip', { name: 'Dip', load_type: 'reps' }],
    ['bench-press', { name: 'Bench Press', load_type: 'weight_reps' }],
  ]);

  test('only completed reps-only exercises, once each, in the order performed', () => {
    expect(
      bodyweightExerciseNames(
        [
          { exercise_id: 'bench-press', completed: true },
          { exercise_id: 'dip', completed: false },
          { exercise_id: 'pull-up', completed: true },
          { exercise_id: 'pull-up', completed: true },
          { exercise_id: 'dip', completed: true },
        ],
        catalog,
      ),
    ).toEqual(['Pull-up', 'Dip']);
  });

  test('a planned bodyweight set nobody did is not a reason to show a bodyweight', () => {
    expect(bodyweightExerciseNames([{ exercise_id: 'pull-up', completed: false }], catalog)).toEqual([]);
  });

  test('weighted exercises alone never qualify', () => {
    expect(bodyweightExerciseNames([{ exercise_id: 'bench-press', completed: true }], catalog)).toEqual([]);
  });

  test('an exercise the catalog does not know yet is left out rather than guessed', () => {
    expect(bodyweightExerciseNames([{ exercise_id: 'mystery', completed: true }], catalog)).toEqual([]);
  });
});

describe('getSessionBodyweight', () => {
  test('asks for the session in the given zone and parses the answer', async () => {
    request.mockResolvedValue({
      session: {},
      volume: {},
      bodyweight_kg: 82.4,
      bodyweight_measured_on: '2026-09-12',
    });
    await expect(getSessionBodyweight(getToken, 'a b', undefined, 'Europe/Kyiv')).resolves.toEqual({
      kg: 82.4,
      measuredOn: '2026-09-12',
    });
    expect(request).toHaveBeenCalledWith(getToken, '/sessions/a%20b?tz=Europe%2FKyiv', { signal: undefined });
  });

  test("defaults to the phone's own zone, which is the athlete's day", async () => {
    request.mockResolvedValue({ bodyweight_kg: null, bodyweight_measured_on: null });
    await expect(getSessionBodyweight(getToken, 's1')).resolves.toBeNull();
    expect(request.mock.calls[0][1]).toBe('/sessions/s1?tz=America%2FLos_Angeles');
  });

  test('a response from before the field existed is no bodyweight', async () => {
    request.mockResolvedValue({ session: {}, volume: {} });
    await expect(getSessionBodyweight(getToken, 's1', undefined, 'UTC')).resolves.toBeNull();
  });

  test('a failed request rejects, so the caller can stay silent', async () => {
    request.mockRejectedValue(new Error('offline'));
    await expect(getSessionBodyweight(getToken, 's1', undefined, 'UTC')).rejects.toThrow('offline');
  });
});
