import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import PhaseScreen from '../../app/phase/index';
import { createPhase, listPhases } from '@/lib/body';
import type { UnitSystem } from '@/lib/units';

/**
 * The phase screen's target weight, in both unit systems.
 *
 * **This is a data-corruption regression, not a label one.** The screen never
 * called `useUnits` at all: it took the typed number and passed it straight to
 * `createPhase` as `target_weight_kg`, while the field said "(kg)" whatever the
 * athlete's profile said. So an imperial athlete typing `175` — meaning 175 lb,
 * ~79 kg — stored a goal of **175 kilograms**, and every number derived from
 * the phase afterwards (the rate band, the calorie target, the "kg to go"
 * line) was computed from it. Nothing on any screen looked wrong.
 *
 * `@/lib/units` is deliberately NOT mocked. The conversion is the behaviour
 * under test, and a mock returning whatever the test handed it would supply
 * exactly the thing being verified — the mistake `goalsScreen.test.tsx`
 * documents for `targetOn`. Only the unit *preference* is stubbed, because
 * that is an input to the screen rather than part of the arithmetic.
 */
configure({ asyncUtilTimeout: 10_000 });

jest.mock('@/lib/body', () => ({
  ...jest.requireActual('@/lib/body'),
  listPhases: jest.fn(),
  createPhase: jest.fn(),
  endPhase: jest.fn(),
}));

const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({
  useAuthToken: () => mockTokenGetter,
}));

jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#8BC34A', on: '#000' }),
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'phase-id' }));

let mockUnits: UnitSystem = 'metric';
let mockReady = true;
jest.mock('@/lib/useUnits', () => ({
  useUnits: () => ({
    units: mockUnits,
    unitsReady: mockReady,
    setUnits: jest.fn(),
    unsynced: false,
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockUnits = 'metric';
  mockReady = true;
  (listPhases as jest.Mock).mockResolvedValue([]);
  (createPhase as jest.Mock).mockResolvedValue({ id: 'phase-id' });
});

/** Types a target weight and starts the phase; returns what was sent. */
async function startWithWeight(typed: string): Promise<Record<string, unknown>> {
  render(<PhaseScreen />);
  await waitFor(() => expect(screen.getByTestId('phase-weight')).toBeTruthy());
  fireEvent.changeText(screen.getByTestId('phase-weight'), typed);
  fireEvent.press(screen.getByTestId('phase-start'));
  await waitFor(() => expect(createPhase).toHaveBeenCalled());
  return (createPhase as jest.Mock).mock.calls[0][1];
}

describe('the target weight is stored in kilograms whatever the athlete types', () => {
  it('sends metric input through unchanged', async () => {
    mockUnits = 'metric';
    const sent = await startWithWeight('79.4');
    expect(sent.target_weight_kg).toBe(79.4);
  });

  it('converts imperial input to kilograms before sending', async () => {
    mockUnits = 'imperial';
    const sent = await startWithWeight('175');
    // 175 lb = 79.379 kg. The assertion is the CONVERTED value, not merely
    // "not 175" — a conversion applied in the wrong direction (385.8) would
    // satisfy a not-equal check while being just as wrong.
    expect(sent.target_weight_kg).toBeCloseTo(79.379, 3);
  });

  it('never sends the typed number as-is when the athlete is imperial', async () => {
    mockUnits = 'imperial';
    const sent = await startWithWeight('175');
    expect(sent.target_weight_kg).not.toBe(175);
  });
});

describe('the field says which unit it wants', () => {
  it('asks for kg in metric', async () => {
    mockUnits = 'metric';
    render(<PhaseScreen />);
    await waitFor(() => expect(screen.getByText(/Target weight \(kg\)/)).toBeTruthy());
  });

  it('asks for lb in imperial', async () => {
    mockUnits = 'imperial';
    render(<PhaseScreen />);
    await waitFor(() => expect(screen.getByText(/Target weight \(lb\)/)).toBeTruthy());
    // The spoken label matters separately: VoiceOver reads "lb" as two
    // letters, so the accessible name carries the word.
    expect(screen.getByLabelText('Target weight in pounds')).toBeTruthy();
  });
});

describe('the write waits for the preference to be known', () => {
  it('does not submit while the unit system is still unresolved', async () => {
    // Before the cache is read `units` reads 'metric'. Submitting in that
    // window would store a pounds figure as kilograms — the original bug,
    // narrowed to one frame rather than fixed.
    mockUnits = 'imperial';
    mockReady = false;
    render(<PhaseScreen />);
    await waitFor(() => expect(screen.getByTestId('phase-weight')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('phase-weight'), '175');
    fireEvent.press(screen.getByTestId('phase-start'));
    expect(createPhase).not.toHaveBeenCalled();
  });
});
