import { BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import { Tabs } from 'expo-router';
import { Platform, StyleSheet } from 'react-native';

import { vola } from '@/constants/Colors';

/**
 * The tab bar floats: a rounded bar inset from the edges, sitting over the
 * content rather than sealing the bottom of the screen with a full-width
 * band and a hairline rule.
 *
 * That rule, plus the header's own, split the app into three stacked slabs
 * of slightly different dark — the most visible thing on a dark theme, and
 * dividing nothing real. One continuous ground, one floating control.
 *
 * It's glass rather than a solid fill: content scrolling under a floating
 * control should be *visible* through it, which is the whole reason to float
 * it rather than seal the bottom of the screen. A solid bar floating over
 * content is just a smaller opaque bar.
 *
 * Because it's absolutely positioned, content scrolls *underneath* it, so
 * every scrolling screen leaves TAB_BAR_CLEARANCE at the bottom.
 */
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: vola.lime,
        tabBarInactiveTintColor: vola.textDim,
        sceneStyle: { backgroundColor: vola.bg },
        tabBarStyle: styles.bar,
        tabBarItemStyle: styles.item,
        // The active tab gets its own raised pill, as in the reference. The
        // lime tint alone reads as "this one is coloured"; a container reads
        // as "you are here".
        tabBarActiveBackgroundColor: 'rgba(255, 255, 255, 0.08)',
        tabBarLabelStyle: styles.label,
        // The blur *is* the background. It has to live here rather than in
        // tabBarStyle because a style can't blur what's behind it — only a
        // real view in the background slot can.
        tabBarBackground: () => (
          <BlurView
            intensity={40}
            tint="dark"
            // A hair of fill under the blur: pure blur over a near-black
            // ground reads as murky rather than glassy, and the hairline is
            // what gives the pill an edge to catch light on.
            style={[StyleSheet.absoluteFill, styles.glass]}
          />
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Today',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'sun.max', android: 'today', web: 'today' }}
              tintColor={color}
              size={22}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="workouts"
        options={{
          title: 'Workouts',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'square.stack', android: 'view_agenda', web: 'view_agenda' }}
              tintColor={color}
              size={22}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: 'Library',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'books.vertical', android: 'list', web: 'list' }}
              tintColor={color}
              size={22}
            />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    // Margins, not left/right/bottom: React Navigation positions the tab
    // bar's own container absolutely and overwrites those offsets, but it
    // leaves margins on the bar itself alone. Insetting with left/right/
    // bottom silently did nothing and the bar stayed edge-to-edge.
    marginHorizontal: 30,
    marginBottom: 26,
    height: 60,
    borderRadius: 30,
    paddingBottom: 0,
    // Transparent so the blur behind it is what you see. Any fill here
    // would sit *over* the blur and cancel it.
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    // Clips the blur to the pill; without it the blur is a rectangle behind
    // rounded corners.
    overflow: 'hidden',
    // Android draws a shadow from elevation; iOS needs it spelled out. Both
    // are what make the bar read as floating rather than pasted on.
    elevation: 12,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.5,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
      },
      default: {},
    }),
  },
  item: {
    paddingTop: 6,
    paddingBottom: 6,
    marginVertical: 6,
    marginHorizontal: 4,
    // Matches the bar's inner curve so the end tabs' highlight can't cut a
    // square corner across it.
    borderRadius: 24,
  },
  label: { fontSize: 10, fontWeight: '600' },
  glass: {
    backgroundColor: 'rgba(23, 30, 43, 0.55)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.10)',
    borderRadius: 30,
  },
});
