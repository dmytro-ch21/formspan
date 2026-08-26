import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import EditProfileScreen from '../profile/edit';

/**
 * N12's picker/remove flow on the profile edit screen — the one place an
 * athlete manages their own avatar. `lib/__tests__/profileApi.test.ts`
 * covers the request shape; `components/__tests__/Avatar.test.tsx` covers
 * the fallback. This is the wiring between the picker and the screen's own
 * state: does a successful upload/remove actually update what's on screen,
 * and does a failure leave `avatarUrl` where it was rather than silently
 * clearing it.
 */

jest.setTimeout(30_000);

const mockGetProfile = jest.fn();
const mockUpdateProfile = jest.fn();
const mockUploadAvatar = jest.fn();
const mockRemoveAvatar = jest.fn();
jest.mock('@/lib/profile', () => ({
  getProfile: (...a: unknown[]) => mockGetProfile(...a),
  updateProfile: (...a: unknown[]) => mockUpdateProfile(...a),
  uploadAvatar: (...a: unknown[]) => mockUploadAvatar(...a),
  removeAvatar: (...a: unknown[]) => mockRemoveAvatar(...a),
}));

jest.mock('@/lib/modules', () => ({ setModules: jest.fn() }));

const mockUseModules = jest.fn(() => ({
  modules: [] as unknown[],
  ready: true,
  stale: false,
  apply: jest.fn(),
}));
jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => mockUseModules() }));

const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockTokenGetter }));

jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ label: 'VOLA', accent: '#D3EC52', ink: '#D3EC52', on: '#080B12' }),
}));

jest.mock('@/lib/useUnits', () => ({
  useUnits: () => ({ units: 'metric', unitsReady: true, setUnits: jest.fn(), unsynced: false }),
}));

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    // Renders `headerRight`, unlike a bare `() => null` — this screen's Save
    // button lives there (Stack.Screen's `options`), not in the scrolling
    // body, so a mock that drops it entirely makes Save unreachable to any
    // test.
    Stack: {
      Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) =>
        options?.headerRight ? options.headerRight() : null,
    },
    useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
    // KeyboardAwareScrollView (used by this screen) calls this internally.
    useFocusEffect: (cb: () => void | (() => void)) => {
      React.useEffect(() => {
        const cleanup = cb();
        return () => {
          if (typeof cleanup === 'function') cleanup();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
    },
  };
});

const mockManipulate = jest.fn();
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  manipulateAsync: (...a: unknown[]) => mockManipulate(...a),
}));

const mockRequestCamera = jest.fn();
const mockLaunchCamera = jest.fn();
const mockRequestLibrary = jest.fn();
const mockLaunchLibrary = jest.fn();
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: (...a: unknown[]) => mockRequestCamera(...a),
  launchCameraAsync: (...a: unknown[]) => mockLaunchCamera(...a),
  requestMediaLibraryPermissionsAsync: (...a: unknown[]) => mockRequestLibrary(...a),
  launchImageLibraryAsync: (...a: unknown[]) => mockLaunchLibrary(...a),
}));

const PROFILE = {
  user_id: 'u1',
  username: 'dmytro_bjj',
  display_name: 'Dmytro',
  date_of_birth: null,
  sex: null,
  height_cm: null,
  unit_system: 'metric' as const,
  food_unit: null,
  track_effort: true,
  share_training_with_friends: false,
  share_training_details: false,
  activity_level: null,
  avatar_url: undefined as string | undefined,
};

beforeEach(() => {
  mockGetProfile.mockReset().mockResolvedValue({ ...PROFILE });
  mockUpdateProfile.mockReset();
  mockUploadAvatar.mockReset();
  mockRemoveAvatar.mockReset();
  mockManipulate.mockReset().mockResolvedValue({ uri: 'file:///shrunk.jpg' });
  mockRequestCamera.mockReset().mockResolvedValue({ granted: true });
  mockRequestLibrary.mockReset().mockResolvedValue({ granted: true });
  mockLaunchCamera.mockReset();
  mockLaunchLibrary
    .mockReset()
    .mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///picked.jpg' }] });
});

it('shows the monogram (no photo) before any avatar is uploaded', async () => {
  render(<EditProfileScreen />);
  await screen.findByTestId('profile-avatar-row');
  expect(
    screen.getByTestId('avatar-monogram', { includeHiddenElements: true }),
  ).toBeTruthy();
  expect(screen.queryByTestId('avatar-photo')).toBeNull();
});

it('picking a photo from the library uploads it and shows the result', async () => {
  mockUploadAvatar.mockResolvedValue({ ...PROFILE, avatar_url: 'https://cdn.test/new.jpg' });
  render(<EditProfileScreen />);
  await screen.findByTestId('profile-avatar-row');

  await act(async () => {
    fireEvent.press(screen.getByTestId('profile-avatar-library'));
  });

  await waitFor(() => expect(screen.getByTestId('avatar-photo')).toBeTruthy());
  expect(mockUploadAvatar).toHaveBeenCalledWith(
    mockTokenGetter,
    expect.objectContaining({ uri: 'file:///shrunk.jpg', mimeType: 'image/jpeg' }),
  );
  // The downscale ran BEFORE the upload — the raw picked uri never reaches
  // uploadAvatar directly.
  expect(mockManipulate).toHaveBeenCalledWith(
    'file:///picked.jpg',
    expect.anything(),
    expect.anything(),
  );
});

/**
 * Save and an avatar change are two different requests to two different
 * endpoints, and nothing about them technically conflicts — but firing both
 * at once is a confusing state for the athlete to be in, so the screen
 * disables Save for the DURATION of an avatar upload, not just its own.
 */
it('disables Save while an avatar upload is in flight, and re-enables it after', async () => {
  let resolveUpload: (p: typeof PROFILE) => void;
  mockUploadAvatar.mockReturnValue(
    new Promise((resolve) => {
      resolveUpload = resolve;
    }),
  );
  render(<EditProfileScreen />);
  await screen.findByTestId('profile-avatar-row');

  fireEvent.press(screen.getByTestId('profile-avatar-library'));

  await waitFor(() => expect(screen.getByTestId('profile-save').props.accessibilityState?.disabled).toBe(true));

  await act(async () => {
    resolveUpload({ ...PROFILE, avatar_url: 'https://cdn.test/new.jpg' });
  });

  await waitFor(() => expect(screen.getByTestId('profile-save').props.accessibilityState?.disabled).toBe(false));
});

/**
 * The regression this pins: a failed upload must not silently clear the
 * avatar that was already showing (the "no half-set avatar" acceptance
 * criterion, on the client side of the same guarantee the backend already
 * enforces).
 */
it('a failed upload leaves the previous avatar showing, with an error', async () => {
  mockGetProfile.mockResolvedValue({ ...PROFILE, avatar_url: 'https://cdn.test/existing.jpg' });
  mockUploadAvatar.mockRejectedValue(new Error('storage is down'));
  render(<EditProfileScreen />);
  await screen.findByTestId('avatar-photo');

  await act(async () => {
    fireEvent.press(screen.getByTestId('profile-avatar-library'));
  });

  await waitFor(() => expect(screen.getByText('storage is down')).toBeTruthy());
  // Still the photo, not the monogram — the failed replace did not clear it.
  expect(screen.getByTestId('avatar-photo')).toBeTruthy();
});

it('removing the avatar returns to the monogram', async () => {
  mockGetProfile.mockResolvedValue({ ...PROFILE, avatar_url: 'https://cdn.test/existing.jpg' });
  mockRemoveAvatar.mockResolvedValue(undefined);
  render(<EditProfileScreen />);
  await screen.findByTestId('avatar-photo');

  await act(async () => {
    fireEvent.press(screen.getByTestId('profile-avatar-remove'));
  });

  await waitFor(() =>
    expect(
      screen.getByTestId('avatar-monogram', { includeHiddenElements: true }),
    ).toBeTruthy(),
  );
  expect(mockRemoveAvatar).toHaveBeenCalledWith(mockTokenGetter);
});

it('declines to upload when camera permission is refused, without touching uploadAvatar', async () => {
  mockRequestCamera.mockResolvedValue({ granted: false });
  render(<EditProfileScreen />);
  await screen.findByTestId('profile-avatar-row');

  await act(async () => {
    fireEvent.press(screen.getByTestId('profile-avatar-camera'));
  });

  await waitFor(() => expect(screen.getByText(/needs camera access/i)).toBeTruthy());
  expect(mockLaunchCamera).not.toHaveBeenCalled();
  expect(mockUploadAvatar).not.toHaveBeenCalled();
});
