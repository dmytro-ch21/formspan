import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { vola } from '@/constants/Colors';
import { Radius, Spacing } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';

/**
 * N132 (#536) — a build must never be mistaken for production by looking at
 * it. `EXPO_PUBLIC_APP_ENV` is inlined at bundle time from each EAS build
 * profile's `env` block (`apps/mobile/eas.json`) and from `.env.example`'s
 * local-dev default; this renders a small corner label whenever it resolves
 * to anything other than exactly `"production"`, and renders NOTHING when
 * it does.
 *
 * **Fails safe in the direction that matters for a safety instrument**: an
 * unset or misspelled value is treated as non-production (shows a marker)
 * rather than silently hiding one — the only way this badge can be wrong is
 * by appearing on a real production build, never the reverse. The single
 * profile allowed to suppress it (`EXPO_PUBLIC_APP_ENV === "production"`) is
 * asserted separately, statically, by
 * `scripts/validate-production-config.mjs`'s `--check` (wired into `pnpm
 * run verify`), so eas.json's production profile can't drift to some OTHER
 * value and silently show the marker on a real release either.
 *
 * Deliberately a bare `<Text>` in a fixed corner, not a designed component —
 * this is a debugging/safety instrument, not a piece of the athlete-facing
 * UI, and over-investing in its visual polish would be the wrong kind of
 * craft for what it's for. Hidden from the accessibility tree
 * (`accessibilityElementsHidden`/`importantForAccessibility="no-hide-
 * descendants"`, matching this codebase's own convention for purely visual
 * overlays — see `Avatar.tsx`/`CaffeineBanner.tsx`) — found in review
 * (frontend-reviewer): a screen reader has nothing to gain from announcing
 * "DEV" on every screen, and `pointerEvents="none"` already keeps it out of
 * the touch tree, so it should be out of the accessibility tree too.
 */
export function EnvironmentBadge() {
  const insets = useSafeAreaInsets();
  const env = process.env.EXPO_PUBLIC_APP_ENV;

  if (env === 'production') return null;

  const label = env ? env.toUpperCase() : 'DEV';

  return (
    <View
      pointerEvents="none"
      style={[styles.wrap, { top: insets.top + Spacing.sm }]}
      testID="environment-badge"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: Spacing.sm,
    backgroundColor: vola.warn,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xxs,
    borderRadius: Radius.sm,
    zIndex: 999,
    elevation: 999,
  },
  label: {
    ...Typography.caption,
    color: vola.bg,
    letterSpacing: 1,
  },
});
