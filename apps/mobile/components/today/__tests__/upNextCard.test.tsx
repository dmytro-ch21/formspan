import { fireEvent, render, screen } from '@testing-library/react-native';

import { UpNextCard } from '../UpNextCard';

/**
 * N457/#766 direct-component coverage.
 *
 * `todayScreen.test.tsx` covers the wiring (the card routes through
 * `startPlanned`/`startSessionHref` with the right backdated `?date=`). This
 * file covers what belongs to `UpNextCard` itself: a `past` card is a real,
 * tappable button — not the inert `accessibilityRole="text"` card it used to
 * be — while carrying forward the two accessibility fixes that inertness was
 * originally standing in for (no `disabled`/`accessibilityState`, so
 * VoiceOver never appends "dimmed"; no opacity wash over the card).
 */

const BASE = {
  sport: 'strength',
  title: 'Strength session',
  when: 'Today',
  onLog: jest.fn(),
  onOpen: jest.fn(),
};

beforeEach(() => {
  BASE.onLog.mockClear();
  BASE.onOpen.mockClear();
});

describe('past (a day already gone, unmet)', () => {
  it('is a real button, not inert text', () => {
    render(<UpNextCard {...BASE} past testID="card" />);
    const card = screen.getByTestId('card');
    expect(card.props.accessibilityRole).toBe('button');
  });

  it('tapping the card calls onOpen', () => {
    render(<UpNextCard {...BASE} past testID="card" />);
    fireEvent.press(screen.getByTestId('card'));
    expect(BASE.onOpen).toHaveBeenCalledTimes(1);
    expect(BASE.onLog).not.toHaveBeenCalled();
  });

  it('says the status label, still', () => {
    render(<UpNextCard {...BASE} past pastLabel="Not logged" testID="card" />);
    expect(screen.getByText('Not logged')).toBeTruthy();
  });

  it('folds pastLabel into the DEFAULT accessibilityLabel, so a future caller cannot omit it silently', () => {
    // The one real call site always passes an explicit accessibilityLabel —
    // this guards the fallback a second caller would get if it didn't.
    render(<UpNextCard {...BASE} past pastLabel="Not logged" testID="card" />);
    const card = screen.getByTestId('card');
    expect(card.props.accessibilityLabel).toBe('Strength session, Today. Not logged');
  });

  it('renders no second, nested Log control — the card itself is the one target', () => {
    render(<UpNextCard {...BASE} past testID="card" />);
    expect(screen.queryByTestId('up-next-log')).toBeNull();
  });

  it('never marks the card disabled — the fold that made VoiceOver say "dimmed"', () => {
    render(<UpNextCard {...BASE} past testID="card" />);
    const card = screen.getByTestId('card');
    // `Pressable` always reports an `accessibilityState` object (RN
    // populates every field, even ones nobody set) — what matters is that
    // `disabled` inside it is undefined, not `false`: React Native only
    // folds `disabled` into `accessibilityState` (and VoiceOver only
    // appends "dimmed") when the `disabled` prop is explicitly passed, which
    // this component never does on this path.
    expect(card.props.disabled).toBeUndefined();
    expect(card.props.accessibilityState?.disabled).toBeUndefined();
  });

  it('does not composite a blanket opacity over the card', () => {
    render(<UpNextCard {...BASE} past testID="card" />);
    const card = screen.getByTestId('card');
    const style = Array.isArray(card.props.style) ? card.props.style : [card.props.style];
    for (const s of style) {
      expect(s?.opacity).toBeUndefined();
    }
  });
});

describe('not past (today or a future day) — unaffected', () => {
  it('is a button and tapping the card calls onOpen', () => {
    render(<UpNextCard {...BASE} testID="card" />);
    const card = screen.getByTestId('card');
    expect(card.props.accessibilityRole).toBe('button');
    fireEvent.press(card);
    expect(BASE.onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders a separate Log control that calls onLog without triggering onOpen', () => {
    render(<UpNextCard {...BASE} testID="card" />);
    fireEvent.press(screen.getByTestId('up-next-log'));
    expect(BASE.onLog).toHaveBeenCalledTimes(1);
    expect(BASE.onOpen).not.toHaveBeenCalled();
  });

  it('does not render the past status label', () => {
    render(<UpNextCard {...BASE} testID="card" />);
    expect(screen.queryByText('Not logged')).toBeNull();
  });
});
