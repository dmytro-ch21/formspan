import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { Avatar } from '../Avatar';

/**
 * N12's two acceptance criteria for the fallback, both pinned here:
 * "the monogram renders whenever no avatar is set, AND when one fails to
 * load." The second half is the one a naive `url ? photo : monogram` would
 * miss entirely — a real url whose image never actually loads (an expired
 * presigned link, a takedown, a dropped connection) would render nothing
 * useful without the `onError` fallback this file exists to pin.
 *
 * The monogram's own container is deliberately hidden from assistive tech
 * (see Avatar.tsx — it is decorative, same as LibraryTile's coded fallback),
 * so every query for it passes `includeHiddenElements`, the same convention
 * `youScreen.test.tsx` established for its own hidden badge.
 */

describe('Avatar', () => {
  it('shows the monogram when no url is set', () => {
    render(<Avatar url={null} handle="dmytro_bjj" />);
    expect(screen.getByTestId('avatar-monogram', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId('avatar-photo')).toBeNull();
  });

  it('shows the photo when a url is set', () => {
    render(<Avatar url="https://example.test/avatar.jpg" handle="dmytro_bjj" />);
    expect(screen.getByTestId('avatar-photo')).toBeTruthy();
    expect(screen.queryByTestId('avatar-monogram', { includeHiddenElements: true })).toBeNull();
  });

  /** The regression this file exists for. */
  it('falls back to the monogram when the photo fails to load', () => {
    render(<Avatar url="https://example.test/broken.jpg" handle="dmytro_bjj" />);
    expect(screen.getByTestId('avatar-photo')).toBeTruthy();

    act(() => {
      fireEvent(screen.getByTestId('avatar-photo'), 'onError');
    });

    expect(screen.queryByTestId('avatar-photo')).toBeNull();
    expect(screen.getByTestId('avatar-monogram', { includeHiddenElements: true })).toBeTruthy();
  });

  /**
   * A fresh url — a successful re-upload replacing a broken one — must be
   * retried, not permanently blocked by the PREVIOUS url's failure. This is
   * what distinguishes tracking the failed URL from a bare boolean: a
   * boolean would keep the monogram showing forever after one failure, even
   * once the athlete uploaded a photo that works fine.
   */
  it('retries a new url after a previous one failed', () => {
    const { rerender } = render(<Avatar url="https://example.test/broken.jpg" handle="d" />);
    act(() => {
      fireEvent(screen.getByTestId('avatar-photo'), 'onError');
    });
    expect(screen.getByTestId('avatar-monogram', { includeHiddenElements: true })).toBeTruthy();

    rerender(<Avatar url="https://example.test/replacement.jpg" handle="d" />);
    expect(screen.getByTestId('avatar-photo')).toBeTruthy();
    expect(screen.queryByTestId('avatar-monogram', { includeHiddenElements: true })).toBeNull();
  });

  it('derives the fallback initials from the handle, never the display name', () => {
    // monogramFor is already covered in lib/__tests__/monogram.test.ts; this
    // just confirms Avatar actually passes the handle through rather than
    // some other prop.
    render(<Avatar url={null} handle="mat_rat" />);
    expect(screen.getByText('MR', { includeHiddenElements: true })).toBeTruthy();
  });
});
