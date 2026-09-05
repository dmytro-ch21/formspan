import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet } from 'react-native';

import { CARD_GLASS_COLORS } from '@/constants/Card';

/**
 * The "glass" in VOLA's glass card — N508.
 *
 * Render this as a card's FIRST child, over an already-positioned
 * (`position: 'relative'`, implicit for any View) card, with
 * `overflow: 'hidden'` on the card so the wash respects its rounded
 * corners. It draws nothing but a lit top-left wash fading to nothing — a
 * translucent panel with a highlight, not a shadow or a glow, matching
 * N444's flat/no-glow ruling: this is a different MATERIAL layered on that
 * flat surface, not elevation.
 *
 * ## Deliberately NOT `expo-blur`
 *
 * `BlurView` samples what's actually behind it, and behind a card here is
 * this app's own flat, near-solid `vola.surface` — blurring that costs a
 * native compositing pass to blur almost nothing, which is the same
 * reasoning `BjjRankHeader.tsx` and `library.tsx`'s facet sheet already
 * recorded for their own glass treatments before this ticket existed. This
 * component is the same recipe generalised for a card with no single
 * accent to tint the wash with — three fixed whites instead of a belt's or
 * an accent's tone. Screens with a natural tint (a belt, a sport colour)
 * may still build their own tinted gradient rather than use this — see
 * `BjjRankHeader.tsx` for that variant — this component is the untinted
 * default.
 */
export function CardGlass() {
  return (
    <LinearGradient
      colors={CARD_GLASS_COLORS}
      start={{ x: 0, y: 0 }}
      end={{ x: 0.9, y: 1 }}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );
}
