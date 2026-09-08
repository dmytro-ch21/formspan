/**
 * N531/#962 — the 3-dot menu behind a food entry row. Exactly three actions,
 * and Share gated the way the entry screen used to gate its Share button.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';

import { EntryMenuSheet } from '../EntryMenuSheet';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

function renderSheet(over: Partial<React.ComponentProps<typeof EntryMenuSheet>> = {}) {
  const props = {
    open: true,
    entryName: 'Greek yoghurt',
    shareBlocked: null as string | null | undefined,
    onDuplicate: jest.fn(),
    onRemove: jest.fn(),
    onShare: jest.fn(),
    onClose: jest.fn(),
    ...over,
  };
  render(<EntryMenuSheet {...props} />);
  return props;
}

describe('the three actions, and nothing else', () => {
  it('offers Duplicate, Remove and Share — no fourth row', () => {
    renderSheet();
    const buttons = screen
      .getAllByRole('button')
      .map((b) => b.props.testID as string)
      .filter((id) => id?.startsWith('entry-menu-') && id !== 'entry-menu-close');
    expect(buttons).toEqual(['entry-menu-duplicate', 'entry-menu-remove', 'entry-menu-share']);
  });

  it('names the entry it was opened for', () => {
    renderSheet();
    expect(screen.getByText('Greek yoghurt')).toBeTruthy();
    expect(screen.getByTestId('entry-menu-duplicate').props.accessibilityLabel).toBe(
      'Duplicate Greek yoghurt',
    );
    expect(screen.getByTestId('entry-menu-remove').props.accessibilityLabel).toBe(
      'Remove Greek yoghurt',
    );
  });

  it('Duplicate and Remove call back', () => {
    const p = renderSheet();
    fireEvent.press(screen.getByTestId('entry-menu-duplicate'));
    expect(p.onDuplicate).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('entry-menu-remove'));
    expect(p.onRemove).toHaveBeenCalledTimes(1);
    expect(p.onShare).not.toHaveBeenCalled();
  });

  it('Done and the backdrop both close', () => {
    const p = renderSheet();
    fireEvent.press(screen.getByTestId('entry-menu-close'));
    // Hidden from assistive tech on purpose (see the component), so ask for
    // hidden elements too.
    fireEvent.press(screen.getByTestId('entry-menu-backdrop', { includeHiddenElements: true }));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });

  it('renders nothing while closed', () => {
    renderSheet({ open: false });
    expect(screen.queryByTestId('entry-menu-duplicate')).toBeNull();
  });
});

/**
 * The gate `app/food/entry/[id].tsx` carried on its Share button, moved here
 * with the button: sharing sends what the SERVER holds, so an entry that has
 * not reached it is refused WITH the reason, in the label as well as under
 * the row.
 */
describe('Share is gated on sync state', () => {
  it('is enabled and calls back when nothing blocks it', () => {
    const p = renderSheet({ shareBlocked: null });
    const share = screen.getByTestId('entry-menu-share');
    expect(share.props.accessibilityState).toEqual({ disabled: false });
    expect(share.props.accessibilityLabel).toBe('Share Greek yoghurt');
    expect(screen.queryByTestId('entry-menu-share-reason')).toBeNull();
    fireEvent.press(share);
    expect(p.onShare).toHaveBeenCalledTimes(1);
  });

  it('is disabled with the reason when the entry has not synced', () => {
    const reason = 'Not synced yet — this becomes shareable once it reaches the server.';
    const p = renderSheet({ shareBlocked: reason });
    const share = screen.getByTestId('entry-menu-share');
    expect(share.props.accessibilityState).toEqual({ disabled: true });
    // The reason is IN THE LABEL — a hint on a disabled control is not
    // reliably announced.
    expect(share.props.accessibilityLabel).toBe(`Share. ${reason}`);
    expect(
      screen.getByTestId('entry-menu-share-reason', { includeHiddenElements: true }).props.children,
    ).toBe(reason);
    fireEvent.press(share);
    expect(p.onShare).not.toHaveBeenCalled();
  });

  it('reads as blocked while the sync state is still being read — never permitted by default', () => {
    const p = renderSheet({ shareBlocked: undefined });
    const share = screen.getByTestId('entry-menu-share');
    expect(share.props.accessibilityState).toEqual({ disabled: true });
    expect(share.props.accessibilityLabel).toBe('Share. Loading…');
    fireEvent.press(share);
    expect(p.onShare).not.toHaveBeenCalled();
  });
});
