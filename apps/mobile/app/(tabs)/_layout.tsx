import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { vola } from '@/constants/Colors';

/**
 * The tab bar from the hi-fi design: flat, flush to the bottom, on the same
 * ground as everything else. Type only — no icons, no pill, no fill.
 *
 * This replaces a floating glass pill, which was the wrong instinct. A
 * floating control is a *thing on top of* the app; the design treats
 * navigation as part of the page, quiet enough to ignore until you look for
 * it. The active tab is marked by a small dot above the label rather than a
 * container, which is the least furniture that can still answer "where am
 * I" at a glance.
 *
 * A hairline is the only separator, and it's the one seam worth keeping:
 * without it the labels read as content when a list scrolls behind them.
 */
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: vola.text,
        tabBarInactiveTintColor: vola.textDim,
        sceneStyle: { backgroundColor: vola.bg },
        tabBarStyle: styles.bar,
        tabBarLabelStyle: styles.label,
        tabBarIconStyle: styles.iconSlot,
        // The dot *is* the icon slot — a marker above the label rather than
        // a glyph beside it.
        tabBarIcon: ({ focused }) => (
          <View style={[styles.dot, focused && styles.dotActive]} />
        ),
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Today' }} />
      <Tabs.Screen name="workouts" options={{ title: 'Plan' }} />
      <Tabs.Screen name="library" options={{ title: 'Library' }} />
      <Tabs.Screen name="you" options={{ title: 'You' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: vola.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.lineSoft,
    height: 88,
    paddingTop: 10,
    elevation: 0,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  iconSlot: { height: 10, marginBottom: 2 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: 'transparent' },
  dotActive: { backgroundColor: vola.lime },
});
