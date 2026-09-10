import { render, screen, waitFor } from '@testing-library/react-native';

import HRZonesScreen from '../../app/hr-zones';

/**
 * The zones screen — N535/#966.
 *
 * `lib/__tests__/hrMax.test.ts` pins the resolution and
 * `lib/__tests__/hrZones.test.ts` pins the arithmetic. This file pins the
 * three things that only exist once the screen renders, each of which is a
 * silent failure rather than a crash:
 *
 *  1. **The source badge.** Design doc §3 step 3 is "never silently switch",
 *     and the badge IS that promise. A screen that dropped it would show a
 *     number that means two different things with nothing to tell them apart.
 *  2. **The beats.** The whole point: a zone an athlete cannot act on is not
 *     a zone. A screen rendering the words with no numbers looks finished.
 *  3. **The empty state showing NO number.** The failure mode this repo keeps
 *     naming is confident-and-wrong, so the assertion is that nothing
 *     bpm-shaped appears at all — not merely that a message does.
 */
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => jest.fn(async () => 'token') }));

const mockGetObservedHRMax = jest.fn();
const mockGetProfile = jest.fn();
jest.mock('@/lib/biometric', () => ({
  ...jest.requireActual<typeof import('@/lib/biometric')>('@/lib/biometric'),
  getObservedHRMax: (...args: unknown[]) => mockGetObservedHRMax(...args),
}));
jest.mock('@/lib/profile', () => ({ getProfile: (...args: unknown[]) => mockGetProfile(...args) }));

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Link: Text,
    useFocusEffect: (cb: () => void | (() => void)) => {
      useEffect(() => {
        const cleanup = cb();
        return () => {
          if (typeof cleanup === 'function') cleanup();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('an observed maximum', () => {
  beforeEach(() => {
    mockGetObservedHRMax.mockResolvedValue({
      bpm: 191,
      measured_at: '2026-08-20T09:00:00Z',
      sample_count: 12_400,
    });
    mockGetProfile.mockResolvedValue({ date_of_birth: '1990-03-01' });
  });

  it('says which maximum is in force, and does not call it estimated', async () => {
    await render(<HRZonesScreen />);
    await waitFor(() => expect(screen.getByTestId('hr-zones-hrmax')).toBeTruthy());
    expect(screen.getByTestId('hr-zones-hrmax')).toHaveTextContent('191 bpm');
    expect(screen.getByTestId('hr-zones-source')).toHaveTextContent(
      'Measured from your own sessions',
    );
    expect(screen.queryByText(/Estimated from your age/)).toBeNull();
  });

  it('shows all five zones in beats, not just in words', async () => {
    await render(<HRZonesScreen />);
    await waitFor(() => expect(screen.getByTestId('hr-zones-zone-1')).toBeTruthy());
    // 191 bpm: floors at ceil(0.5..0.9 x 191) = 96 / 115 / 134 / 153 / 172.
    expect(screen.getByTestId('hr-zones-zone-1')).toHaveTextContent(/96-114 bpm/);
    expect(screen.getByTestId('hr-zones-zone-3')).toHaveTextContent(/134-152 bpm/);
    expect(screen.getByTestId('hr-zones-zone-5')).toHaveTextContent(/172\+ bpm/);
  });

  it('shows when it was recorded and how much evidence is behind it', async () => {
    await render(<HRZonesScreen />);
    await waitFor(() => expect(screen.getByTestId('hr-zones')).toBeTruthy());
    // The date is formatted for the DEVICE's locale (`toLocaleDateString`
    // with no locale argument), so this asserts the parts rather than one
    // machine's ordering of them — pinning "20 August 2026" would go red on a
    // US-locale runner while the screen was perfectly correct.
    expect(screen.getByText(/August.*2026|2026.*August/)).toBeTruthy();
    expect(screen.getByText('12,400 heart-rate samples')).toBeTruthy();
  });

  it('does not nag an athlete who already has a measured maximum', async () => {
    await render(<HRZonesScreen />);
    await waitFor(() => expect(screen.getByTestId('hr-zones')).toBeTruthy());
    expect(screen.queryByTestId('hr-zones-upgrade-note')).toBeNull();
  });
});

describe('an age-estimated maximum', () => {
  beforeEach(() => {
    mockGetObservedHRMax.mockResolvedValue(null);
    mockGetProfile.mockResolvedValue({ date_of_birth: '1990-03-01' });
  });

  it('says so, and shows the arithmetic rather than only the answer', async () => {
    await render(<HRZonesScreen />);
    await waitFor(() => expect(screen.getByTestId('hr-zones-source')).toBeTruthy());
    expect(screen.getByTestId('hr-zones-source')).toHaveTextContent('Estimated from your age');
    expect(screen.getByText(/^220 − \d+ = \d+$/)).toBeTruthy();
  });

  it('says how to replace it with a measured one', async () => {
    await render(<HRZonesScreen />);
    await waitFor(() => expect(screen.getByTestId('hr-zones-upgrade-note')).toBeTruthy());
  });
});

describe('nothing to go on', () => {
  it('names what is missing and shows no number at all', async () => {
    mockGetObservedHRMax.mockResolvedValue(null);
    mockGetProfile.mockResolvedValue({ date_of_birth: null });
    await render(<HRZonesScreen />);
    await waitFor(() => expect(screen.getByTestId('hr-zones-unresolved')).toBeTruthy());

    expect(screen.getByText('We cannot work out your zones yet')).toBeTruthy();
    expect(screen.queryByTestId('hr-zones-hrmax')).toBeNull();
    expect(screen.queryByTestId('hr-zones-zone-1')).toBeNull();
    // The clamp N485 rejected would have rendered "100 bpm" here and looked
    // entirely reasonable. Nothing bpm-shaped is allowed on this screen.
    expect(screen.queryByText(/\d+ bpm/)).toBeNull();
  });

  it('an unreachable profile is a different sentence from an empty one', async () => {
    mockGetObservedHRMax.mockResolvedValue(null);
    mockGetProfile.mockRejectedValue(new Error('offline'));
    await render(<HRZonesScreen />);
    await waitFor(() => expect(screen.getByTestId('hr-zones-error')).toBeTruthy());
    expect(screen.queryByTestId('hr-zones-unresolved')).toBeNull();
  });

  it('an unreachable hr-max endpoint still yields the age estimate', async () => {
    // The tolerant half of `fetchHRMax`: an older API that has never heard of
    // this endpoint must not cost the athlete the zones they already had.
    mockGetObservedHRMax.mockRejectedValue(new Error('404'));
    mockGetProfile.mockResolvedValue({ date_of_birth: '1990-03-01' });
    await render(<HRZonesScreen />);
    await waitFor(() => expect(screen.getByTestId('hr-zones-source')).toBeTruthy());
    expect(screen.getByTestId('hr-zones-source')).toHaveTextContent('Estimated from your age');
  });
});
