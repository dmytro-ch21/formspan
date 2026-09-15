import { act, render, screen } from '@testing-library/react-native';

import { SessionBodyweight } from '../SessionBodyweight';

const mockGetToken = async () => 't';
let mockUnits: 'metric' | 'imperial' = 'metric';
let mockUnitsReady = true;

jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockGetToken }));
jest.mock('@/lib/useUnits', () => ({
  useUnits: () => ({ units: mockUnits, unitsReady: mockUnitsReady }),
}));
jest.mock('@/lib/sessionBodyweight', () => ({
  ...jest.requireActual('@/lib/sessionBodyweight'),
  getSessionBodyweight: jest.fn(),
}));

const { getSessionBodyweight } = jest.requireMock('@/lib/sessionBodyweight') as {
  getSessionBodyweight: jest.Mock;
};

const catalog = new Map([
  ['pull-up', { name: 'Pull-up', load_type: 'reps' as const }],
  ['bench-press', { name: 'Bench Press', load_type: 'weight_reps' as const }],
]);
const pullUps = [
  { exercise_id: 'pull-up', completed: true },
  { exercise_id: 'pull-up', completed: true },
];

type Props = Parameters<typeof SessionBodyweight>[0];

function element(over: Partial<Props> = {}) {
  return (
    <SessionBodyweight
      sessionID="s1"
      startedAt="2026-09-12T18:00:00Z"
      finished
      sets={pullUps}
      catalog={catalog}
      {...over}
    />
  );
}

/** Let the fetch's promise settle and its state land. */
async function settle() {
  await act(async () => {});
}

async function renderIt(over: Partial<Props> = {}) {
  const view = await render(element(over));
  await settle();
  return view;
}

beforeEach(() => {
  mockUnits = 'metric';
  mockUnitsReady = true;
  getSessionBodyweight.mockReset();
});

test('a finished bodyweight session shows the weight and the check-in it came from', async () => {
  getSessionBodyweight.mockResolvedValue({ kg: 82.4, measuredOn: '2026-09-12' });
  await renderIt();
  expect(screen.getByText('Bodyweight 82.4kg, from your 12 Sep check-in')).toBeTruthy();
  expect(screen.getByText('Bodyweight exercises: Pull-up')).toBeTruthy();
  expect(getSessionBodyweight).toHaveBeenCalledWith(mockGetToken, 's1', expect.anything());
});

test("in the athlete's own unit", async () => {
  mockUnits = 'imperial';
  getSessionBodyweight.mockResolvedValue({ kg: 82.4, measuredOn: '2026-09-12' });
  await renderIt();
  expect(screen.getByText('Bodyweight 181.7lb, from your 12 Sep check-in')).toBeTruthy();
});

test('waits for the unit preference rather than flashing kilograms at an imperial athlete', async () => {
  mockUnitsReady = false;
  getSessionBodyweight.mockResolvedValue({ kg: 82.4, measuredOn: '2026-09-12' });
  await renderIt();
  expect(screen.queryByTestId('session-bodyweight')).toBeNull();
});

test('with no weigh-in on or before that day it shows nothing, exactly as before', async () => {
  getSessionBodyweight.mockResolvedValue(null);
  await renderIt();
  expect(getSessionBodyweight).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('session-bodyweight')).toBeNull();
  expect(screen.queryByText(/check-in/)).toBeNull();
});

test('offline it stays silent: no invented number, and no claim that there is no check-in', async () => {
  getSessionBodyweight.mockRejectedValue(new Error('Network request failed'));
  await renderIt();
  expect(screen.queryByTestId('session-bodyweight')).toBeNull();
});

test('never on a session still being logged: no fetch and no line', async () => {
  getSessionBodyweight.mockResolvedValue({ kg: 82.4, measuredOn: '2026-09-12' });
  await renderIt({ finished: false });
  expect(getSessionBodyweight).not.toHaveBeenCalled();
  expect(screen.queryByTestId('session-bodyweight')).toBeNull();
});

test('a session with only weighted work never asks', async () => {
  getSessionBodyweight.mockResolvedValue({ kg: 82.4, measuredOn: '2026-09-12' });
  await renderIt({ sets: [{ exercise_id: 'bench-press', completed: true }] });
  expect(getSessionBodyweight).not.toHaveBeenCalled();
  expect(screen.queryByTestId('session-bodyweight')).toBeNull();
});

test("another session never shows the previous session's reading while its own is in flight", async () => {
  getSessionBodyweight.mockResolvedValueOnce({ kg: 82.4, measuredOn: '2026-09-12' });
  const view = await renderIt();
  expect(screen.getByTestId('session-bodyweight')).toBeTruthy();

  // The second session's answer never arrives.
  getSessionBodyweight.mockReturnValueOnce(new Promise(() => {}));
  await view.rerender(element({ sessionID: 's2', startedAt: '2026-09-13T18:00:00Z' }));
  await settle();
  expect(getSessionBodyweight).toHaveBeenCalledTimes(2);
  expect(screen.queryByTestId('session-bodyweight')).toBeNull();
});
