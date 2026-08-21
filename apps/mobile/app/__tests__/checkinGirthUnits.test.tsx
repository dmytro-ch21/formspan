import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import CheckinScreen from '../checkin/[date]';
import { listCheckins, saveCheckin } from '@/lib/body';
import { getProfile } from '@/lib/profile';
import type { UnitSystem } from '@/lib/units';

/**
 * The nine girth fields, in both unit systems.
 *
 * N105 built the girth primitives and deliberately left this screen metric,
 * because relabelling nine fields "inches" while still showing centimetres is
 * worse than being consistently wrong. N112 applies them — and the interesting
 * part is not the nine fields, it is the two consumers underneath them.
 *
 * `waistToHeight` and `navyBodyFat` take CENTIMETRES. The draft now holds what
 * the athlete typed, which on an imperial profile is inches, while `checkin`
 * holds storage, which is always centimetres. A reader that took the draft
 * straight would feed inches into the Navy estimate for exactly as long as a
 * field stayed dirty, and centimetres again the moment it was saved — a body
 * fat figure that moves when nothing about the body did, with nothing on
 * screen looking wrong and no error anywhere. That is what
 * `derives from the stored centimetres` below is guarding.
 *
 * `@/lib/units` is NOT mocked: the conversion is the behaviour under test.
 */

jest.mock('@/lib/body', () => ({
  ...jest.requireActual('@/lib/body'),
  listCheckins: jest.fn(),
  saveCheckin: jest.fn(),
  deleteCheckin: jest.fn(),
  uploadCheckinPhoto: jest.fn(),
}));
jest.mock('@/lib/profile', () => ({
  ...jest.requireActual('@/lib/profile'),
  getProfile: jest.fn(),
}));

const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockTokenGetter }));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#8BC34A', on: '#000' }),
}));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ date: '2026-08-20' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useFocusEffect: (cb: () => void) => {
    const { useEffect } = jest.requireActual('react');
    useEffect(cb, [cb]);
  },
}));

let mockUnits: UnitSystem = 'metric';
jest.mock('@/lib/useUnits', () => ({
  useUnits: () => ({
    units: mockUnits,
    unitsReady: true,
    setUnits: jest.fn(),
    unsynced: false,
  }),
}));

// 83.82 cm is exactly 33.0 in; 180.34 cm is exactly 71 in (5'11").
const CHECKIN = {
  checkin_date: '2026-08-20',
  weight_kg: 80,
  waist_cm: 83.82,
  hips_cm: 101.6,
  neck_cm: 38.1,
  notes: '',
  photo_url: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUnits = 'metric';
  (listCheckins as jest.Mock).mockResolvedValue([CHECKIN]);
  (saveCheckin as jest.Mock).mockResolvedValue(CHECKIN);
  (getProfile as jest.Mock).mockResolvedValue({
    user_id: 'u1',
    sex: 'male',
    height_cm: 180.34,
    unit_system: 'metric' as UnitSystem,
  });
});

async function open() {
  render(<CheckinScreen />);
  await waitFor(() => expect(screen.getByTestId('checkin-girths-toggle')).toBeTruthy());
  // The screen opens the disclosure itself when the day already has girths, so
  // pressing unconditionally would CLOSE it — and every assertion below would
  // then fail on a missing element rather than a wrong one.
  await waitFor(() => expect(screen.getByTestId('checkin-waist_cm')).toBeTruthy());
}

describe('the girth fields ask in the athlete’s own unit', () => {
  it('shows centimetres in metric', async () => {
    mockUnits = 'metric';
    await open();
    expect(screen.getByTestId('checkin-waist_cm').props.value).toBe('83.8');
    expect(screen.getByLabelText('Waist in centimetres')).toBeTruthy();
    expect(screen.getByText(/In centimetres, tape snug/)).toBeTruthy();
  });

  it('shows inches in imperial — the stored centimetres converted, not relabelled', async () => {
    mockUnits = 'imperial';
    await open();
    // 83.82 cm is 33 in. A relabelled field would still read 83.8.
    expect(screen.getByTestId('checkin-waist_cm').props.value).toBe('33');
    expect(screen.getByTestId('checkin-waist_cm').props.value).not.toBe('83.8');
    expect(screen.getByLabelText('Waist in inches')).toBeTruthy();
    expect(screen.getByText(/In inches, tape snug/)).toBeTruthy();
  });

  it('says the unit as a word, so a screen reader pronounces it', async () => {
    mockUnits = 'imperial';
    await open();
    // "Waist in in" is what an abbreviation at the call site produces.
    expect(screen.queryByLabelText('Waist in in')).toBeNull();
  });

  it('labels every one of the nine sites with the unit', async () => {
    mockUnits = 'imperial';
    await open();
    for (const label of [
      'Neck', 'Shoulders', 'Chest', 'Waist', 'Hips',
      'Upper arm', 'Forearm', 'Thigh', 'Calf',
    ]) {
      expect(screen.getByText(`${label} (in)`)).toBeTruthy();
      expect(screen.getByLabelText(`${label} in inches`)).toBeTruthy();
    }
  });
});

describe('what is stored is centimetres, whatever was typed', () => {
  it('keeps a metric entry unchanged', async () => {
    mockUnits = 'metric';
    await open();
    fireEvent.changeText(screen.getByTestId('checkin-waist_cm'), '85');
    fireEvent.press(screen.getByTestId('checkin-save'));
    await waitFor(() => expect(saveCheckin).toHaveBeenCalled());
    expect((saveCheckin as jest.Mock).mock.calls[0][2].waist_cm).toBe(85);
  });

  it('converts a typed inches value to centimetres on the way in', async () => {
    mockUnits = 'imperial';
    await open();
    fireEvent.changeText(screen.getByTestId('checkin-waist_cm'), '34');
    fireEvent.press(screen.getByTestId('checkin-save'));
    await waitFor(() => expect(saveCheckin).toHaveBeenCalled());
    // 34 in is 86.4 cm. Storing 34 raw would redisplay as 13.4 in next week —
    // a waist that "lost" 20 inches by changing a setting.
    expect((saveCheckin as jest.Mock).mock.calls[0][2].waist_cm).toBe(86.4);
  });

  it('round-trips a typed inches value back to the same digits', async () => {
    mockUnits = 'imperial';
    await open();
    fireEvent.changeText(screen.getByTestId('checkin-waist_cm'), '32.5');
    fireEvent.press(screen.getByTestId('checkin-save'));
    await waitFor(() => expect(saveCheckin).toHaveBeenCalled());
    const stored = (saveCheckin as jest.Mock).mock.calls[0][2].waist_cm as number;
    // What comes back out of storage is what was typed.
    expect(Number((stored / 2.54).toFixed(1))).toBe(32.5);
  });
});

describe('the derived estimates read the stored centimetres', () => {
  it('gives the same waist-to-height in both systems, from the same body', async () => {
    mockUnits = 'metric';
    await open();
    const metric = screen.getByTestId('checkin-whtr').props.children.join('');
    screen.unmount();

    mockUnits = 'imperial';
    await open();
    const imperial = screen.getByTestId('checkin-whtr').props.children.join('');
    // 83.8 / 180.34 is 0.4647, which `waistToHeight` rounds to 0.465 and the
    // screen renders as 0.47 — the same body whichever unit the field is
    // labelled in. Reading the draft directly in imperial gives 33 / 180.34 =
    // 0.18, which is still "under the 0.5 guide", so the WORDS agree in both
    // readings and only the number betrays it.
    expect(imperial).toBe(metric);
    expect(imperial).toContain('0.47');
  });

  it('does not move when an imperial field is edited to the same body measurement', async () => {
    mockUnits = 'imperial';
    await open();
    const before = screen.getByTestId('checkin-whtr').props.children.join('');
    // Retyping the value already shown makes the field dirty without changing
    // the body. Stability alone is too weak an assertion here — the loaded
    // draft is already in inches, so a reader that took it raw would be
    // equally wrong before and after and this would pass. The NUMBER is the
    // guard: a raw read gives 33 / 180.34 = 0.18.
    fireEvent.changeText(screen.getByTestId('checkin-waist_cm'), '33');
    const after = screen.getByTestId('checkin-whtr').props.children.join('');
    expect(after).toBe(before);
    expect(after).toContain('0.47');
  });
});
