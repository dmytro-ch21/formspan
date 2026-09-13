import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import Vo2MaxTrendScreen from '../../app/vo2max/trend';
import { shiftDate } from '@/lib/anthropometry';
import { dayString, shortDate } from '@/lib/calendar';

/**
 * N546 (#989) on the real VO₂max screen: the band, the latest reading, and the
 * named period. The real hook, the real `buildTrend` and the real classifier
 * run; only the network (samples, profile) and the platform bridges are mocked.
 *
 * `vo2MaxSource.ts`'s header notes that no test used to render this screen,
 * which is how an earlier copy change shipped naming the wrong vendor. This
 * file is the first that does.
 */
const mockUseEffect = useEffect;
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
  useFocusEffect: (cb: () => void | (() => void)) => mockUseEffect(() => cb(), [cb]),
}));
jest.mock('@clerk/clerk-expo', () => ({ useAuth: () => ({ userId: 'user_1' }) }));
// A STABLE token function, as the real hook returns; a fresh one per render
// re-runs every focus effect on every render.
const mockGetToken = async () => 'token';
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockGetToken }));
jest.mock('@/lib/AccentProvider', () => ({ useAccent: () => ({ accent: '#8BC34A', on: '#000', ink: '#8BC34A' }) }));
jest.mock('@/lib/healthkit', () => ({
  ...jest.requireActual('@/lib/healthkit'),
  isHealthKitSupported: () => true,
}));
jest.mock('@/lib/healthkitSync', () => ({ readHealthKitImportEnabled: async () => true }));

const mockListSamples = jest.fn();
jest.mock('@/lib/biometric', () => ({
  ...jest.requireActual('@/lib/biometric'),
  listBiometricSamples: (...a: unknown[]) => mockListSamples(...a),
}));

const mockGetProfile = jest.fn();
jest.mock('@/lib/profile', () => ({
  ...jest.requireActual('@/lib/profile'),
  getProfile: (...a: unknown[]) => mockGetProfile(...a),
}));

const TODAY = dayString(new Date());

/** A date of birth that makes the athlete `years` old on every reading below:
 *  mid-year, far from both a birthday and a decade edge. */
function bornYearsAgo(years: number): string {
  return shiftDate(TODAY, -Math.round((years + 0.5) * 365.25));
}

function sample(daysAgo: number, value: number) {
  return {
    id: `s${daysAgo}`,
    metric_type: 'vo2_max',
    source: 'healthkit',
    source_platform: 'ios',
    value,
    unit: 'mL/min·kg',
    measured_at: `${shiftDate(TODAY, -daysAgo)}T12:00:00Z`,
  };
}

beforeEach(() => {
  mockListSamples.mockReset().mockResolvedValue([sample(40, 29.4), sample(10, 31.0)]);
  mockGetProfile.mockReset().mockResolvedValue({ date_of_birth: bornYearsAgo(36), sex: 'female' });
});

/** The first render of this screen pulls in the chart and the trend layer, and
 *  measured over a second on its own — past `waitFor`'s default. */
const SETTLE = { timeout: 8000 };

async function settled() {
  await waitFor(() => expect(screen.getByTestId('vo2max-latest')).toBeTruthy(), SETTLE);
  await waitFor(() => expect(mockGetProfile).toHaveBeenCalled(), SETTLE);
  await act(async () => {});
}

describe('the latest reading and its band', () => {
  it('shows the newest value, how old it is, and its band with the reference', async () => {
    render(<Vo2MaxTrendScreen />);
    await settled();
    expect(screen.getByTestId('vo2max-latest-value')).toHaveTextContent('31.0 mL/kg/min');
    expect(screen.getByTestId('vo2max-latest-age')).toHaveTextContent(`Latest reading from ${shortDate(shiftDate(TODAY, -10))}, 10 days ago`);
    // 31.0 for a woman of 36: above her 50th percentile (30.2), below her 75th (36.1).
    expect(screen.getByTestId('vo2max-band')).toHaveTextContent('Above average for women aged 30–39');
    expect(screen.getByTestId('vo2max-band-reference')).toHaveTextContent(/FRIEND/);
  });

  it('asks for the missing detail rather than guessing, and shows no reference line', async () => {
    mockGetProfile.mockResolvedValue({ date_of_birth: bornYearsAgo(36), sex: null });
    render(<Vo2MaxTrendScreen />);
    await settled();
    expect(screen.getByTestId('vo2max-band')).toHaveTextContent(
      'Add your sex in your profile to see how this compares with others your age.',
    );
    expect(screen.queryByTestId('vo2max-band-reference')).toBeNull();
  });

  it('says nothing about a band when the profile could not be read, rather than claiming details are missing', async () => {
    mockGetProfile.mockRejectedValue(new Error('offline'));
    render(<Vo2MaxTrendScreen />);
    await settled();
    expect(screen.getByTestId('vo2max-latest-value')).toHaveTextContent('31.0 mL/kg/min');
    expect(screen.queryByTestId('vo2max-band')).toBeNull();
    expect(screen.queryByText(/Add your/)).toBeNull();
  });

  it('says plainly when the age is outside the reference', async () => {
    mockGetProfile.mockResolvedValue({ date_of_birth: bornYearsAgo(82), sex: 'male' });
    render(<Vo2MaxTrendScreen />);
    await settled();
    expect(screen.getByTestId('vo2max-band')).toHaveTextContent(
      "The reference covers ages 20 to 79, so there's no band for your age.",
    );
  });
});

describe('the change line names its period', () => {
  it('reads "in the past 6 months" by default and follows the chosen range', async () => {
    render(<Vo2MaxTrendScreen />);
    await settled();
    expect(screen.getByTestId('vo2max-delta')).toHaveTextContent('↑ 1.6 mL/kg/min in the past 6 months');
    expect(screen.getByTestId('vo2max-evidence')).toHaveTextContent(`since ${shortDate(shiftDate(TODAY, -40))} · 2 readings`);

    fireEvent.press(screen.getByTestId('vo2max-range-1Y'));
    await waitFor(() => expect(screen.getByTestId('vo2max-delta')).toHaveTextContent('↑ 1.6 mL/kg/min in the past year'), SETTLE);
  });
});
