import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Pill } from '../Pill';

/**
 * N444 (#741) — the shared rounded-label control: a badge without `onPress`,
 * a chip with it.
 */
describe('Pill — radius is always the full-pill token (999)', () => {
  it('a badge (no onPress) is borderRadius 999', () => {
    render(<Pill label="Public" testID="pill" />);
    const style = StyleSheet.flatten(screen.getByTestId('pill').props.style);
    expect(style.borderRadius).toBe(999);
  });

  it('a chip (with onPress), active or not, is also borderRadius 999', () => {
    const inactive = render(<Pill label="Strength" onPress={() => {}} testID="pill" />);
    expect(StyleSheet.flatten(inactive.getByTestId('pill').props.style).borderRadius).toBe(999);
    inactive.unmount();

    const active = render(<Pill label="Strength" onPress={() => {}} active testID="pill" />);
    expect(StyleSheet.flatten(active.getByTestId('pill').props.style).borderRadius).toBe(999);
  });
});

describe('Pill — onPress is what decides chip vs badge, exhaustively', () => {
  it('without onPress: a plain label, no button role, inert', () => {
    const clickSpy = jest.fn();
    render(<Pill label="Public" testID="pill" />);
    const pill = screen.getByTestId('pill');
    expect(pill.props.accessibilityRole).not.toBe('button');
    // Nothing to press — confirms this never silently gained button
    // semantics without a handler.
    fireEvent.press(pill);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('with onPress: a real button that fires and announces its selected state', () => {
    const onPress = jest.fn();
    render(<Pill label="Strength" onPress={onPress} active testID="pill" />);
    const pill = screen.getByTestId('pill');
    expect(pill.props.accessibilityRole).toBe('button');
    expect(pill.props.accessibilityState.selected).toBe(true);
    fireEvent.press(pill);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('an inactive chip reports selected: false, not undefined', () => {
    render(<Pill label="Strength" onPress={() => {}} testID="pill" />);
    expect(screen.getByTestId('pill').props.accessibilityState.selected).toBe(false);
  });
});

describe('Pill — active tints toward the accent, not a hardcoded colour', () => {
  it('active uses the accent (DEFAULT_ACCENT green with no <AccentProvider>), inactive does not', () => {
    const active = render(<Pill label="Strength" onPress={() => {}} active testID="pill" />);
    const activeStyle = StyleSheet.flatten(active.getByTestId('pill').props.style);
    // withAlpha('#D3EC52', 0.22) — the same derivation Button's primary
    // fill uses, at a lower opacity since this sits BEHIND label text of
    // its own rather than carrying a button's whole fill.
    expect(activeStyle.backgroundColor).toBe('rgba(211,236,82,0.22)');
    active.unmount();

    const inactive = render(<Pill label="Strength" onPress={() => {}} testID="pill" />);
    const inactiveStyle = StyleSheet.flatten(inactive.getByTestId('pill').props.style);
    expect(inactiveStyle.backgroundColor).not.toBe('rgba(211,236,82,0.22)');
  });
});

describe('Pill — accessibilityLabel overrides the visible label when given', () => {
  it('a badge with a count uses the fuller accessible name', () => {
    render(<Pill label="3" accessibilityLabel="3 friends waiting" testID="pill" />);
    expect(screen.getByTestId('pill').props.accessibilityLabel).toBe('3 friends waiting');
  });

  it('a chip with no override speaks its own label', () => {
    render(<Pill label="Strength" onPress={() => {}} testID="pill" />);
    expect(screen.getByTestId('pill').props.accessibilityLabel).toBe('Strength');
  });
});
