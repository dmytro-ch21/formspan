import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { Radius, Spacing } from '@/constants/Spacing';
import { Typography } from '@/constants/Typography';
import { useAccent } from '@/lib/AccentProvider';
import { badgeLabel, bellLabel, refreshShareInbox, useShareInboxCount } from '@/lib/shareInbox';

/**
 * The bell — where shares arrive (N529/#960).
 *
 * **It replaced the `DEV` pill, and it is a control where the pill was a
 * label.** The pill sat in this corner because it was untouchable: a
 * `pointerEvents="none"` overlay out of the accessibility tree. A bell an
 * athlete taps has no business floating over every screen — over a modal's
 * close button, over a native header's Save — so it lives in `ScreenHeader`'s
 * trailing cluster instead, on every tab and on the pushed screens that draw
 * their own header. The corner is the same one; the mechanism is not.
 *
 * **Always there, badged only when something is waiting.** The bell is how
 * an athlete learns where shares arrive, so it does not come and go the way
 * `SyncChip` does. The badge does: `badgeLabel` returns null for zero AND for
 * unknown, so a failed read (offline, a cold open in airplane mode) shows
 * the bell and nothing else — never "0", which would be a claim.
 *
 * **Refreshes on focus, throttled.** `useFocusEffect` fires when this header's
 * screen comes to the front — a tab flip, or returning from `/shared` — and
 * the store skips a read inside its window, so eight mounted headers do not
 * become eight requests. The foreground return is the orchestrator's job, and
 * the accept/dismiss update is the inbox screen publishing its own count; see
 * `lib/shareInbox.ts` for the whole schedule.
 *
 * 44pt target via `hitSlop` rather than a 44pt box: the header row is 28pt
 * tall and a taller pressable would grow every header by 16pt for a control
 * that is drawn at 22.
 */
export function ShareBell() {
  const count = useShareInboxCount();
  const router = useRouter();
  const accent = useAccent();

  useFocusEffect(
    useCallback(() => {
      void refreshShareInbox();
    }, []),
  );

  const badge = badgeLabel(count);

  return (
    <Pressable
      onPress={() => router.push('/shared')}
      hitSlop={HIT_SLOP}
      style={styles.target}
      accessibilityRole="button"
      accessibilityLabel={bellLabel(count)}
      testID="share-bell"
    >
      <Icon name="notification" size={ICON_SIZE} color={vola.textMuted} />
      {badge !== null && (
        <RNView
          style={[styles.badge, { backgroundColor: accent.accent }]}
          // The pressable's label already says "3 waiting"; announcing the
          // digit as well would read the number twice.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="share-bell-badge"
        >
          <Text style={[styles.badgeText, { color: accent.on }]}>{badge}</Text>
        </RNView>
      )}
    </Pressable>
  );
}

const ICON_SIZE = 22;
/** 28pt drawn box + 8pt each side = the 44pt target. */
const BOX = 28;
const HIT_SLOP = (44 - BOX) / 2;

const styles = StyleSheet.create({
  target: {
    width: BOX,
    height: BOX,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -Spacing.xs,
    right: -Spacing.xsPlus,
    minWidth: 18,
    height: 18,
    paddingHorizontal: Spacing.xs,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    // A ring of the page's own ground, so the badge reads as sitting on the
    // bell rather than being part of its stroke.
    borderWidth: 2,
    borderColor: vola.bg,
  },
  badgeText: {
    ...Typography.eyebrow,
    letterSpacing: 0,
  },
});
