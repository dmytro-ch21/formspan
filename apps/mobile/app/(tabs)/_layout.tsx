import { Tabs } from 'expo-router';
import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { useModules } from '@/lib/ModulesProvider';
import { OFF_BAR_ROUTES, TABS } from '@/lib/tabs';

/**
 * The tab bar: an icon, a label, and an underline on the active one.
 *
 * It was type-only with a dot above the label, on the reasoning that an icon
 * beside a word is redundant furniture. The redesign puts the icons back, and
 * the argument against them was thinner than it looked: at a glance-and-tap
 * distance — thumb moving before the eye has read anything — a shape is faster
 * to acquire than a five-letter word, and this bar holds few enough
 * destinations that each shape stays learnable.
 *
 * That said "four" until Food arrived, then "four or five" while the food-log
 * gate was in force. It is **exactly five now, always** — Today · Food ·
 * Progress · Plan · You — and the claim was always about LEARNABILITY rather
 * than the literal number, so a fixed five is the easy case for it.
 *
 * The active mark moved from a dot above the label to a rule beneath it. A dot
 * is ambiguous about *what* it marks when there is now also an icon above the
 * word; an underline is unambiguously about the item it sits under.
 *
 * **The accent comes from the provider, not the palette**, so the bar follows
 * whatever the athlete chose. That is also why the styles below are split:
 * anything accent-coloured has to be inline, because `StyleSheet.create` is
 * evaluated once at module load and cannot see a preference.
 *
 * A hairline is the only separator, and it is the one seam worth keeping:
 * without it the labels read as content when a list scrolls behind them.
 *
 * **Which five, in what order, and which routes here hold no slot at all, are
 * all decided in `lib/tabs.ts`** — including the reasoning N176 superseded and
 * the reasoning it did not. This file draws the bar; that one says what is in
 * it, and is where a proposal to add, remove or hide a tab has to argue itself.
 */
export default function TabLayout() {
  const { ready } = useModules();
  const accent = useAccent();

  // Hold the frame until the cached module set has been read.
  //
  // **This no longer guards the BAR, and that half is genuinely gone.** It used
  // to: Food and Goals were hidden on a food-log gate, an unread module list is
  // empty, an empty list has no food-log capability in it, so the first frames
  // computed "hide both" and the bar visibly rearranged on every cold start.
  // N176 made all five slots unconditional, so the bar is now identical for an
  // empty list and a full one. `app/__tests__/tabLayout.test.tsx`'s
  // "the bar does not depend on the module set" is what says so — both its
  // cases, the unread list and the all-disabled one — and is what turns red if
  // a future ticket makes a tab conditional again without restoring that guard.
  //
  // **N180 returned Food to the bar WITHOUT returning the gate**, so that
  // property still holds and is more load-bearing than it was: Food is now a
  // permanent slot whose screen carries its own off-state, rather than a slot
  // that comes and goes with a server response.
  //
  // **It still guards the SCREENS, which is the larger half and always was.**
  // `<Tabs>` mounts its initial route immediately, and `(tabs)/index.tsx` reads
  // `useModules()` without reading `ready` — `foodEnabled` is `hasFoodLog([])`,
  // which is false. Without this hold, Today renders the dashed "Nutrition is
  // turned off" placeholder for the first frames of every cold start, on an
  // account where nutrition is on. That is the N61 lie flashing rather than
  // sticking, and `lib/modules.ts`'s `foodLogGate` docstring describes the same
  // failure one level further down. `RootLayoutNav` holds a frame this way for
  // Clerk, for the same reason.
  if (!ready) return null;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: accent.accent,
        tabBarInactiveTintColor: vola.textDim,
        sceneStyle: { backgroundColor: vola.bg },
        tabBarStyle: styles.bar,
        tabBarLabelStyle: styles.label,
        tabBarIconStyle: styles.iconSlot,
        tabBarButton: (props) => <TabButton {...props} color={accent.accent} />,
      }}
    >
      {TABS.map(({ name, title, icon }) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title,
            tabBarIcon: ({ focused }) => (
              <Icon
                name={icon}
                size={22}
                color={focused ? accent.accent : vola.textDim}
              />
            ),
          }}
        />
      ))}
      {/*
        Declared, not omitted. Omitting a `<Tabs.Screen>` does NOT hide it —
        expo-router auto-injects every route file in this folder whether it is
        declared or not, so leaving these out brings them back as a sixth and
        seventh tab with filename-derived titles. `href: null` removes the
        button and keeps the route resolvable, which is what an in-flight
        `router.push`, a back-stack entry and every `vola://train` deep link
        need — and which is why both screens still carry their own off-state.
      */}
      {OFF_BAR_ROUTES.map((name) => (
        <Tabs.Screen key={name} name={name} options={{ href: null }} />
      ))}
    </Tabs>
  );
}

/**
 * The default tab button, plus the rule under the active one.
 *
 * A wrapper rather than part of the icon, so the underline spans the tab's own
 * width instead of the glyph's — an underline as narrow as a 22pt icon reads as
 * a dropped shadow rather than a marker.
 *
 * `focused` is read off `accessibilityState.selected`, which the navigator
 * already sets on every tab button. Deriving it rather than threading a second
 * source of truth means the underline cannot disagree with what a screen
 * reader announces.
 *
 * It is installed once as `screenOptions.tabBarButton`, never per screen, so
 * every tab gets the same role, label and selected state — including the two
 * N176 added. A per-screen override is how one tab ends up announcing itself
 * differently from its four neighbours.
 */
/**
 * Typed structurally rather than against `BottomTabBarButtonProps`. That type
 * lives in `@react-navigation/bottom-tabs`, which is a *transitive* dependency
 * of expo-router — importing from it would mean adding a direct dependency on
 * a package this app never chose, and pinning it separately from the router
 * that owns it. The three fields used here are stable navigator contract.
 */
type TabButtonProps = PressableProps & {
  children?: React.ReactNode;
  color: string;
  /** React Navigation 7 sets the ARIA form; older versions set the RN one. */
  'aria-selected'?: boolean;
};

function TabButton({ color, children, ...props }: TabButtonProps) {
  // Both spellings, because the navigator changed which one it sets and
  // reading only `accessibilityState` gave a permanently-unfocused underline —
  // it rendered on every tab, transparent, which looks exactly like no
  // underline at all.
  const focused = props['aria-selected'] ?? props.accessibilityState?.selected ?? false;
  return (
    <View style={styles.tabSlot}>
      <Pressable {...props} style={styles.tabPress}>
        {children}
      </Pressable>
      <View
        style={[styles.underline, focused && { backgroundColor: color }]}
        // Decoration that repeats what `selected` already conveys.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: vola.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.lineSoft,
    height: 94,
    paddingTop: 12,
    elevation: 0,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  iconSlot: { height: 24, marginBottom: 2 },

  // `justifyContent: flex-start` so the underline sits directly under the
  // label rather than being pushed to the bottom of the bar, where the safe
  // area inset was clipping it entirely.
  tabSlot: { flex: 1, alignItems: 'center', justifyContent: 'flex-start' },
  tabPress: { alignItems: 'center', justifyContent: 'center', width: '100%' },
  // Always laid out, coloured only when active — so the row does not shift by
  // 2pt every time the tab changes.
  underline: {
    height: 2,
    width: 20,
    borderRadius: 1,
    backgroundColor: 'transparent',
    marginTop: 5,
  },
});
