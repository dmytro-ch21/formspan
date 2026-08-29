import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Button } from '../Button';

/**
 * N444 (#741) — the shared primary/secondary/ghost control.
 *
 * The property that matters most here isn't any single style value; it's
 * the ABSENCE of a shadow. This component exists because "New workout" had
 * a glow and "New log" didn't, and the user asked for one rule, not two —
 * the fix chosen was no glow anywhere, confirmed directly. A future edit
 * that reaches for `shadowOpacity`/`elevation` on ANY variant is exactly
 * the regression this file exists to catch.
 */
describe('Button — no glow, on any variant (N108/N444)', () => {
  it.each(['primary', 'secondary', 'ghost'] as const)(
    'the %s variant carries no shadow or elevation',
    (variant) => {
      render(<Button label="Go" onPress={() => {}} variant={variant} testID="btn" />);
      const style = StyleSheet.flatten(screen.getByTestId('btn').props.style);
      expect(style.shadowOpacity).toBeUndefined();
      expect(style.shadowColor).toBeUndefined();
      expect(style.shadowRadius).toBeUndefined();
      expect(style.elevation).toBeUndefined();
    },
  );
});

describe('Button — radius is always the full-pill token (999)', () => {
  it.each(['primary', 'secondary', 'ghost'] as const)('%s is borderRadius 999', (variant) => {
    render(<Button label="Go" onPress={() => {}} variant={variant} testID="btn" />);
    const style = StyleSheet.flatten(screen.getByTestId('btn').props.style);
    expect(style.borderRadius).toBe(999);
  });
});

describe('Button — the primary fill is the accent, semi-transparent, not a new colour', () => {
  it('primary is the default green accent at 92% opacity, not fully solid', () => {
    render(<Button label="Go" onPress={() => {}} testID="btn" />);
    const style = StyleSheet.flatten(screen.getByTestId('btn').props.style);
    // #D3EC52 is DEFAULT_ACCENT ('green') in constants/Colors.ts, which is
    // what the context default resolves to with no <AccentProvider> in the
    // tree — the same untagged-default pattern every other useAccent()
    // consumer's tests already rely on.
    expect(style.backgroundColor).toBe('rgba(211,236,82,0.92)');
  });

  it('secondary and ghost do not reuse the primary fill', () => {
    const secondary = render(
      <Button label="Go" onPress={() => {}} variant="secondary" testID="btn" />,
    );
    const secondaryStyle = StyleSheet.flatten(secondary.getByTestId('btn').props.style);
    expect(secondaryStyle.backgroundColor).not.toBe('rgba(211,236,82,0.92)');
    secondary.unmount();

    const ghost = render(<Button label="Go" onPress={() => {}} variant="ghost" testID="btn" />);
    const ghostStyle = StyleSheet.flatten(ghost.getByTestId('btn').props.style);
    expect(ghostStyle.backgroundColor).toBeUndefined();
  });
});

describe('Button — press behaviour and disabled state', () => {
  it('calls onPress when tapped', () => {
    const onPress = jest.fn();
    render(<Button label="Go" onPress={onPress} testID="btn" />);
    fireEvent.press(screen.getByTestId('btn'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('a disabled button announces itself as disabled and is inert', () => {
    const onPress = jest.fn();
    render(<Button label="Go" onPress={onPress} disabled testID="btn" />);
    const btn = screen.getByTestId('btn');
    expect(btn.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(btn);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('Button — layout props', () => {
  it('fullWidth stretches; the default does not', () => {
    const stretched = render(<Button label="Go" onPress={() => {}} fullWidth testID="btn" />);
    expect(StyleSheet.flatten(stretched.getByTestId('btn').props.style).alignSelf).toBe('stretch');
    stretched.unmount();

    const compact = render(<Button label="Go" onPress={() => {}} testID="btn" />);
    expect(StyleSheet.flatten(compact.getByTestId('btn').props.style).alignSelf).not.toBe(
      'stretch',
    );
  });

  it('floating positions bottom-right, matching Today/Workouts FAB placement', () => {
    render(<Button label="Go" onPress={() => {}} floating testID="btn" />);
    const style = StyleSheet.flatten(screen.getByTestId('btn').props.style);
    expect(style.position).toBe('absolute');
    expect(style.right).toBe(16);
    expect(style.bottom).toBe(16);
  });
});
