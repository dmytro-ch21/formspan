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
    async (variant) => {
      await render(<Button label="Go" onPress={() => {}} variant={variant} testID="btn" />);
      const style = StyleSheet.flatten(screen.getByTestId('btn').props.style);
      expect(style.shadowOpacity).toBeUndefined();
      expect(style.shadowColor).toBeUndefined();
      expect(style.shadowRadius).toBeUndefined();
      expect(style.elevation).toBeUndefined();
    },
  );
});

describe('Button — radius is always the full-pill token (999)', () => {
  it.each(['primary', 'secondary', 'ghost'] as const)('%s is borderRadius 999', async (variant) => {
    await render(<Button label="Go" onPress={() => {}} variant={variant} testID="btn" />);
    const style = StyleSheet.flatten(screen.getByTestId('btn').props.style);
    expect(style.borderRadius).toBe(999);
  });
});

describe('Button — the primary fill is the accent, semi-transparent, not a new colour', () => {
  it('primary is the default green accent at 92% opacity, not fully solid', async () => {
    await render(<Button label="Go" onPress={() => {}} testID="btn" />);
    const style = StyleSheet.flatten(screen.getByTestId('btn').props.style);
    // #D3EC52 is DEFAULT_ACCENT ('green') in constants/Colors.ts, which is
    // what the context default resolves to with no <AccentProvider> in the
    // tree — the same untagged-default pattern every other useAccent()
    // consumer's tests already rely on.
    expect(style.backgroundColor).toBe('rgba(211,236,82,0.92)');
  });

  it('secondary and ghost do not reuse the primary fill', async () => {
    const secondary = await render(
      <Button label="Go" onPress={() => {}} variant="secondary" testID="btn" />,
    );
    const secondaryStyle = StyleSheet.flatten(secondary.getByTestId('btn').props.style);
    expect(secondaryStyle.backgroundColor).not.toBe('rgba(211,236,82,0.92)');
    await secondary.unmount();

    const ghost = await render(<Button label="Go" onPress={async () => {}} variant="ghost" testID="btn" />);
    const ghostStyle = StyleSheet.flatten(ghost.getByTestId('btn').props.style);
    expect(ghostStyle.backgroundColor).toBeUndefined();
  });
});

describe('Button — press behaviour and disabled state', () => {
  it('calls onPress when tapped', async () => {
    const onPress = jest.fn();
    await render(<Button label="Go" onPress={onPress} testID="btn" />);
    await fireEvent.press(screen.getByTestId('btn'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('a disabled button announces itself as disabled and is inert', async () => {
    const onPress = jest.fn();
    await render(<Button label="Go" onPress={onPress} disabled testID="btn" />);
    const btn = screen.getByTestId('btn');
    expect(btn.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(btn);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('Button — layout props', () => {
  it('fullWidth stretches; the default does not', async () => {
    const stretched = await render(<Button label="Go" onPress={async () => {}} fullWidth testID="btn" />);
    expect(StyleSheet.flatten(stretched.getByTestId('btn').props.style).alignSelf).toBe('stretch');
    await stretched.unmount();

    const compact = await render(<Button label="Go" onPress={async () => {}} testID="btn" />);
    expect(StyleSheet.flatten(compact.getByTestId('btn').props.style).alignSelf).not.toBe(
      'stretch',
    );
  });

  it('floating positions bottom-right, matching Today/Workouts FAB placement', async () => {
    await render(<Button label="Go" onPress={() => {}} floating testID="btn" />);
    const style = StyleSheet.flatten(screen.getByTestId('btn').props.style);
    expect(style.position).toBe('absolute');
    expect(style.right).toBe(16);
    expect(style.bottom).toBe(16);
  });
});
