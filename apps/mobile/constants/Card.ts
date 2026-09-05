import type { ViewStyle } from 'react-native';

import { vola } from '@/constants/Colors';
import { Radius } from '@/constants/Spacing';

/**
 * The VOLA card surface — sibling to `Colors.ts`, `Spacing.ts` and
 * `Typography.ts`.
 *
 * ## What N444 settled, and what this does not reopen
 *
 * N444 (2026-08-28) ruled cards flat with no shadow/glow, and that ruling
 * stands: nothing here adds elevation or a drop-shadow. What N508 adds is a
 * different MATERIAL on top of that flat surface — a glass/blur treatment
 * (translucency, a lit edge, a subtle wash) — which is not a reversal of
 * "no glow", it's the "Liquid Glass" vocabulary N504 already commits the
 * tab bar to, applied to cards. See {@link CardGlass} below for the
 * mechanism and why it is a gradient wash rather than `expo-blur`.
 *
 * ## The one thing this file actually settles: border colour
 *
 * Before this ticket, a card's border was a coin flip between `vola.line`
 * (219 sites) and `vola.lineSoft` (50 sites) for the identical visual
 * object. `vola.line` wins — it's the supermajority usage, and `lineSoft`
 * stays reserved for the softer dividers/rules it's used for elsewhere
 * (e.g. `Stat.tsx`'s internal `divider`, which is inside a card, not the
 * card's own edge). Do not reach for `lineSoft` on a new card border; that
 * is the exact drift this settles.
 *
 * `radius` reads `Radius.card` from `Spacing.ts` rather than restating 14 a
 * second time — see that file's own note on why 14 was added to the
 * declared scale instead of being fought.
 */
export const Card = {
  /**
   * The base card surface: fill, radius, border. Spread this into a card's
   * `StyleSheet.create` entry rather than restating any of these four
   * literals:
   *
   *     card: {
   *       ...Card.base,
   *       padding: Spacing.cardPadding,
   *     },
   */
  base: {
    backgroundColor: vola.surface,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: vola.line,
  } satisfies ViewStyle,

  radius: Radius.card,
  borderWidth: 1,
  borderColor: vola.line,
  backgroundColor: vola.surface,
} as const;

/**
 * The glass wash's own colours — a lit top-left corner fading to nothing,
 * the same shape `BjjRankHeader.tsx` and `library.tsx`'s facet sheet already
 * use, generalised for a card with no single accent to tint it with.
 *
 * Exported (rather than inlined into `CardGlass` below) so a call site that
 * cannot take a dependency on `expo-linear-gradient` — none exists yet, but
 * `Card.base` above is deliberately usable on its own — can still reference
 * the same colours if it builds its own gradient view.
 */
export const CARD_GLASS_COLORS = [
  'rgba(255,255,255,0.06)',
  'rgba(255,255,255,0.02)',
  'rgba(255,255,255,0)',
] as const;
