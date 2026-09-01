import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { PromotionForm, type EditablePromotion } from '../PromotionForm';
import type { Promotion, Standing } from '@/lib/bjj';

/**
 * N456's photo picker on the add/edit promotion form.
 *
 * The two modes behave differently and that difference is the point under
 * test, not an implementation detail: a brand-new promotion has no id yet, so
 * a picked photo can only be HELD until `save()` creates the row and learns
 * its id (`createPromotion` then `uploadPromotionPhoto`); an existing one
 * already has an id, so a pick uploads IMMEDIATELY, the same interaction
 * `checkin/[date].tsx` offers. Getting the branch wrong either uploads to an
 * id that doesn't exist yet, or leaves an edit-mode pick sitting unsent until
 * a Save button that this form doesn't even show in that mode.
 *
 * `lib/imageUpload.ts`'s own resize/compress/mime steps are exercised for
 * real — only `expo-image-manipulator` underneath them is mocked, the same
 * choice `editProfileAvatar.test.tsx` makes — so this also stands as the
 * regression guard for PromotionForm actually calling that shared helper
 * rather than a screen-local copy.
 */

jest.setTimeout(30_000);

const mockCreatePromotion = jest.fn();
const mockUpdatePromotion = jest.fn();
const mockDeletePromotion = jest.fn();
const mockGetStanding = jest.fn();
const mockUploadPromotionPhoto = jest.fn();
jest.mock('@/lib/bjj', () => ({
  ...jest.requireActual('@/lib/bjj'),
  createPromotion: (...a: unknown[]) => mockCreatePromotion(...a),
  updatePromotion: (...a: unknown[]) => mockUpdatePromotion(...a),
  deletePromotion: (...a: unknown[]) => mockDeletePromotion(...a),
  getStanding: (...a: unknown[]) => mockGetStanding(...a),
  uploadPromotionPhoto: (...a: unknown[]) => mockUploadPromotionPhoto(...a),
}));

const mockUseModules = jest.fn(() => ({
  modules: [{ key: 'bjj', enabled: true }] as unknown[],
  ready: true,
}));
jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => mockUseModules() }));

const mockTokenGetter = jest.fn(async () => 'token');
jest.mock('@/lib/useAuthToken', () => ({ useAuthToken: () => mockTokenGetter }));

jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ label: 'VOLA', accent: '#D3EC52', ink: '#D3EC52', on: '#080B12' }),
}));

const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    // Renders `headerRight`, where this form's Save button lives (see
    // editProfileAvatar.test.tsx for the same reasoning) — a bare `() => null`
    // mock would make Save unreachable to every test here.
    Stack: {
      Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) =>
        options?.headerRight ? options.headerRight() : null,
    },
    useRouter: () => ({ back: mockBack, push: jest.fn() }),
    // KeyboardAwareScrollView (used by this form) calls this internally.
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

const mockRequestLibrary = jest.fn();
const mockLaunchLibrary = jest.fn();
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: (...a: unknown[]) => mockRequestLibrary(...a),
  launchImageLibraryAsync: (...a: unknown[]) => mockLaunchLibrary(...a),
}));

const EXISTING: EditablePromotion = {
  id: 'p1',
  belt: 'blue',
  stripes: 2,
  degree: 0,
  promoted_on: '2025-01-01',
  academy: 'Origin',
  instructor: 'Coach',
  note: '',
};

function emptyStanding(): Standing {
  return { current: null, time_at_current_days: null, promotions: [] };
}

/** `EXISTING` plus the server-only fields `Promotion` requires but the form
 * never reads — kept out of `EXISTING` itself so it stays usable as the
 * lighter `EditablePromotion`. */
function asPromotion(overrides: Partial<Promotion> = {}): Promotion {
  return { ...EXISTING, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', ...overrides };
}

beforeEach(() => {
  mockCreatePromotion.mockReset();
  mockUpdatePromotion.mockReset();
  mockDeletePromotion.mockReset();
  mockGetStanding.mockReset().mockResolvedValue(emptyStanding());
  mockUploadPromotionPhoto.mockReset();
  mockBack.mockReset();
  mockManipulate.mockReset().mockResolvedValue({ uri: 'file:///shrunk.jpg' });
  mockRequestLibrary.mockReset().mockResolvedValue({ granted: true });
  mockLaunchLibrary
    .mockReset()
    .mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///picked.jpg' }] });
});

describe('adding a new promotion', () => {
  it('has no photo yet, and picking one only PREVIEWS it — no upload happens', async () => {
    render(<PromotionForm />);
    await screen.findByTestId('promotion-form');

    expect(screen.queryByTestId('promotion-photo-image')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByTestId('promotion-photo'));
    });

    await waitFor(() => expect(screen.getByTestId('promotion-photo-image')).toBeTruthy());
    expect(mockUploadPromotionPhoto).not.toHaveBeenCalled();
  });

  it('save() creates the promotion THEN uploads the held photo to the new id', async () => {
    mockCreatePromotion.mockResolvedValue(asPromotion({ id: 'new-id' }));
    render(<PromotionForm />);
    await screen.findByTestId('promotion-form');

    await act(async () => {
      fireEvent.press(screen.getByTestId('promotion-photo'));
    });
    await waitFor(() => expect(screen.getByTestId('promotion-photo-image')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('promotion-save'));
    });

    await waitFor(() => expect(mockCreatePromotion).toHaveBeenCalled());
    expect(mockUploadPromotionPhoto).toHaveBeenCalledWith(
      mockTokenGetter,
      'new-id',
      'file:///shrunk.jpg',
    );
    // The upload call must happen AFTER create resolves — asserted by order,
    // since calling it with an id that doesn't exist yet is exactly the bug
    // this two-step design exists to avoid.
    const createOrder = mockCreatePromotion.mock.invocationCallOrder[0];
    const uploadOrder = mockUploadPromotionPhoto.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(uploadOrder);
    expect(mockBack).toHaveBeenCalled();
  });

  it('saves the promotion even when the deferred photo upload fails', async () => {
    mockCreatePromotion.mockResolvedValue(asPromotion({ id: 'new-id' }));
    mockUploadPromotionPhoto.mockRejectedValue(new Error('storage unavailable'));
    render(<PromotionForm />);
    await screen.findByTestId('promotion-form');

    await act(async () => {
      fireEvent.press(screen.getByTestId('promotion-photo'));
    });
    await waitFor(() => expect(screen.getByTestId('promotion-photo-image')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('promotion-save'));
    });

    // The rank is what mattered here — a failed photo must not undo it or
    // strand the athlete on the form.
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it('never calls uploadPromotionPhoto when no photo was picked', async () => {
    mockCreatePromotion.mockResolvedValue(asPromotion({ id: 'new-id' }));
    render(<PromotionForm />);
    await screen.findByTestId('promotion-form');

    await act(async () => {
      fireEvent.press(screen.getByTestId('promotion-save'));
    });

    await waitFor(() => expect(mockBack).toHaveBeenCalled());
    expect(mockUploadPromotionPhoto).not.toHaveBeenCalled();
  });
});

describe('editing an existing promotion', () => {
  it('starts with no photo shown when the promotion has none', async () => {
    render(<PromotionForm initial={EXISTING} />);
    await screen.findByTestId('promotion-form');
    await waitFor(() => expect(mockGetStanding).toHaveBeenCalled());
    expect(screen.queryByTestId('promotion-photo-image')).toBeNull();
  });

  it('shows the route-param photo immediately, then refreshes to a live presigned URL', async () => {
    // A controllable promise, so the intermediate (pre-refresh) paint is
    // actually observable rather than racing a mock that resolves before the
    // first render settles.
    let resolveStanding!: (s: Standing) => void;
    mockGetStanding.mockReturnValue(new Promise<Standing>((res) => { resolveStanding = res; }));

    render(<PromotionForm initial={{ ...EXISTING, photo_url: 'https://cdn.test/stale.jpg' }} />);
    await screen.findByTestId('promotion-form');

    // First paint: the (possibly stale) route-param hint, before the refresh
    // has had a chance to resolve.
    expect(screen.getByTestId('promotion-photo-image').props.source.uri).toBe(
      'https://cdn.test/stale.jpg',
    );

    await act(async () => {
      resolveStanding({
        current: null,
        time_at_current_days: null,
        promotions: [asPromotion({ photo_url: 'https://cdn.test/fresh.jpg' })],
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId('promotion-photo-image').props.source.uri).toBe(
        'https://cdn.test/fresh.jpg',
      ),
    );
  });

  it('picking a photo uploads it IMMEDIATELY — no Save required', async () => {
    mockUploadPromotionPhoto.mockResolvedValue(asPromotion({ photo_url: '' }));
    mockGetStanding.mockResolvedValue({
      current: null,
      time_at_current_days: null,
      promotions: [asPromotion({ photo_url: 'https://cdn.test/after.jpg' })],
    });
    render(<PromotionForm initial={EXISTING} />);
    await screen.findByTestId('promotion-form');
    await waitFor(() => expect(mockGetStanding).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.press(screen.getByTestId('promotion-photo'));
    });

    await waitFor(() =>
      expect(mockUploadPromotionPhoto).toHaveBeenCalledWith(mockTokenGetter, 'p1', 'file:///shrunk.jpg'),
    );
    // Never touched Save, and the upload already happened.
    expect(mockUpdatePromotion).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.getByTestId('promotion-photo-image').props.source.uri).toBe(
        'https://cdn.test/after.jpg',
      ),
    );
  });

  it('a failed pick-upload leaves the form usable and reports the error', async () => {
    mockUploadPromotionPhoto.mockRejectedValue(new Error('network down'));
    render(<PromotionForm initial={EXISTING} />);
    await screen.findByTestId('promotion-form');
    await waitFor(() => expect(mockGetStanding).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.press(screen.getByTestId('promotion-photo'));
    });

    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
    // Nothing to show — the upload never succeeded.
    expect(screen.queryByTestId('promotion-photo-image')).toBeNull();
  });
});
