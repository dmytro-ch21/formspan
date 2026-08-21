import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import EditProfileScreen from '../profile/edit';
import { getProfile, updateProfile } from '@/lib/profile';
import type { UnitSystem } from '@/lib/units';

/**
 * Height on the profile editor, in both unit systems.
 *
 * **Height had no unit support anywhere before N105.** `height_cm` ran from the
 * Postgres column through `profile.go` and `lib/profile.ts` onto a box labelled
 * "Height (cm)", whatever the athlete's profile said — so an imperial athlete
 * entered and read their height in centimetres with no way to change it. BMR
 * derives from height, so this is the same class as the phase-screen bug one
 * step removed: a wrong number reaching the calorie target with nothing on
 * screen looking wrong.
 *
 * `@/lib/units` is NOT mocked — the conversion is the behaviour under test.
 * Only the preference and the network are stubbed.
 */

jest.mock('@/lib/profile', () => ({
  ...jest.requireActual('@/lib/profile'),
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
}));

const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockTokenGetter }));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#8BC34A', on: '#000' }),
}));
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: [], known: true, apply: jest.fn() }),
}));
jest.mock('@/lib/modules', () => ({
  ...jest.requireActual('@/lib/modules'),
  setModules: jest.fn(),
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

const PROFILE = {
  user_id: 'u1',
  username: 'me',
  display_name: 'Me',
  date_of_birth: '1996-01-01',
  sex: 'male',
  // 180.3 cm is exactly 71 inches, i.e. 5'11".
  height_cm: 180.3,
  unit_system: 'metric' as UnitSystem,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUnits = 'metric';
  (getProfile as jest.Mock).mockResolvedValue(PROFILE);
  (updateProfile as jest.Mock).mockResolvedValue(PROFILE);
});

describe('the height field asks in the athlete’s own units', () => {
  it('shows one centimetre box in metric', async () => {
    mockUnits = 'metric';
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-height')).toBeTruthy());
    expect(screen.getByTestId('profile-height').props.value).toBe('180.3');
    expect(screen.getByText(/Height \(cm\)/)).toBeTruthy();
    expect(screen.queryByTestId('profile-height-feet')).toBeNull();
  });

  it('shows feet and inches in imperial, not decimal inches', async () => {
    mockUnits = 'imperial';
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-height-feet')).toBeTruthy());
    // 180.3 cm reads back as 5'11" — NOT "70.9", which would be a faithful
    // conversion nobody says out loud.
    expect(screen.getByTestId('profile-height-feet').props.value).toBe('5');
    expect(screen.getByTestId('profile-height-inches').props.value).toBe('11');
    expect(screen.queryByTestId('profile-height')).toBeNull();
  });
});

/**
 * The screen's Save lives in `Stack.Screen`'s `headerRight`, which RNTL does not
 * render, so the saved payload is not reachable from here. What IS reachable is
 * stronger than it first looks: both boxes are DERIVED from `patch.height_cm`,
 * so typing a value and reading the boxes back exercises
 * `fromFeetInches` → stored centimetres → `toFeetInches` in one go.
 *
 * That catches the failure that matters. If the stored value were the typed
 * feet number rather than centimetres, 6 would redisplay as 0'2"; if the
 * conversion ran the wrong way, 6'11" (83 in) would store 32.7 and redisplay as
 * 2'8". Only a correct round trip shows the digits back unchanged.
 *
 * The exact arithmetic is covered independently and exhaustively in
 * `lib/__tests__/units.test.ts`, across every whole-inch height the column's
 * CHECK admits.
 */
describe('what is stored is centimetres, whatever was typed', () => {
  it('keeps a metric entry unchanged', async () => {
    mockUnits = 'metric';
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-height')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('profile-height'), '175');
    expect(screen.getByTestId('profile-height').props.value).toBe('175');
  });

  it('round-trips feet and inches through centimetres', async () => {
    mockUnits = 'imperial';
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-height-feet')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('profile-height-feet'), '6');
    // 6'11" is 83 in = 210.8 cm, which reads back as 6'11".
    expect(screen.getByTestId('profile-height-feet').props.value).toBe('6');
    expect(screen.getByTestId('profile-height-inches').props.value).toBe('11');
  });

  it('round-trips a changed inches value too', async () => {
    mockUnits = 'imperial';
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-height-inches')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('profile-height-inches'), '3');
    // 5'3" is 63 in = 160 cm.
    expect(screen.getByTestId('profile-height-feet').props.value).toBe('5');
    expect(screen.getByTestId('profile-height-inches').props.value).toBe('3');
  });

  it('does not store the typed feet number as centimetres', async () => {
    mockUnits = 'imperial';
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-height-feet')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('profile-height-feet'), '6');
    // Storing 6 raw would redisplay as 0 feet 2 inches.
    expect(screen.getByTestId('profile-height-feet').props.value).not.toBe('0');
  });

  it('clears the value when both boxes are emptied', async () => {
    mockUnits = 'imperial';
    render(<EditProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-height-feet')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('profile-height-inches'), '');
    fireEvent.changeText(screen.getByTestId('profile-height-feet'), '');
    // Not "0 tall" — unsaid. The column rejects 0 anyway.
    expect(screen.getByTestId('profile-height-feet').props.value).toBe('');
    expect(screen.getByTestId('profile-height-inches').props.value).toBe('');
  });
});
