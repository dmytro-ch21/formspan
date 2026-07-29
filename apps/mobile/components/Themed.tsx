/**
 * Learn more about Light and Dark modes:
 * https://docs.expo.io/guides/color-schemes/
 */
import { Text as DefaultText, View as DefaultView } from 'react-native';

import { useColorScheme } from './useColorScheme';

import Colors from '@/constants/Colors';

type ThemeProps = {
  lightColor?: string;
  darkColor?: string;
};

export type TextProps = ThemeProps & DefaultText['props'];
export type ViewProps = ThemeProps & DefaultView['props'];

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  const theme = useColorScheme();
  const colorFromProps = props[theme];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return Colors[theme][colorName];
  }
}

export function Text(props: TextProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');

  return <DefaultText style={[{ color }, style]} {...otherProps} />;
}

/**
 * A layout View. Deliberately does NOT paint a background.
 *
 * It used to apply the theme's page background unconditionally, which meant
 * every nested layout container stamped a page-coloured rectangle over
 * whatever card it sat inside — visible as a darker box behind text on the
 * dark theme. Backgrounds now belong to the thing that actually is a
 * surface: the screen (via the navigator's theme) or a card (via its own
 * style).
 *
 * Pass lightColor/darkColor to opt back in where a themed background is
 * genuinely wanted.
 */
export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const themed = useThemeColor({ light: lightColor, dark: darkColor }, 'background');
  const backgroundColor = lightColor || darkColor ? themed : 'transparent';

  return <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />;
}
