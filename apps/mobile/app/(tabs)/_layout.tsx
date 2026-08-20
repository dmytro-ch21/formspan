import { Tabs } from 'expo-router';
import { Pressable, StyleSheet, View, type PressableProps } from 'react-native';

import { Icon, type IconName } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { useModules } from '@/lib/ModulesProvider';
import { tabHidden } from '@/lib/tabs';

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
 * That said "four" until Food arrived. The claim was always about
 * LEARNABILITY rather than the literal number, and the bar was already four
 * or five depending on whether any enabled discipline has a catalog — so a
 * variable count is the established state, not a new one. Food earns the slot
 * on frequency: it is logged three to six times a day, more than anything else
 * here, and the tab bar is the only fixed-position affordance the phone has.
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
 */
/**
 * Which tabs are hidden right now — and N61's answer for the tab bar.
 *
 * **This used to hide Food and Goals whenever nutrition was OFF**, on
 * `!hasFoodLog(modules)`. That erased two of five tabs — 40% of the primary
 * navigation — and left nothing behind saying why, so an athlete with
 * nutrition switched off did not see a reduced app, they saw a different,
 * smaller one. A surface that hides itself with no explanation is
 * indistinguishable from one that was never built, and it cannot even be
 * reported accurately, because the person reporting has no idea there is
 * anything to report. That is exactly what the user hit on a device with BJJ:
 * "bjj logging is not there and roadmaps curricula are not there". It was
 * there.
 *
 * **The answer is #370's, applied to chrome instead of content.** That fix
 * found the destinations were never the problem — `bjj/log` and friends
 * already say "BJJ tracking is off, turn it back on under Sports in your
 * profile" — and that NOTHING LINKED TO THEM while the module was off, so the
 * athlete never reached the screen that would explain itself. A tab IS the
 * link. So the link stays, and `food.tsx` and `goals.tsx` now explain
 * themselves the way the BJJ screens do.
 *
 * That is why this is not a placeholder tab, and why #468's dashed-versus-
 * card rule does not decide anything here: nothing is standing in for
 * anything. The real tab is present and leads to the real route; the route
 * says what state it is in.
 *
 * **The third state is the one case where hiding is still right.** A
 * deployment with no food-log module at all has nothing to turn on, so a tab
 * leading to "turn it on" would promise a feature the server does not have —
 * the same lie as hiding one it does. That is the whole of what `tabHidden`
 * asks, and the full reasoning lives on it in `lib/tabs.ts` — a route file
 * is not importable from a test, and this predicate was inline, untested and
 * wrong, which are not three unrelated facts.
 *
 * The Library used to be gated here too, on whether any enabled discipline
 * had a catalog. It is a row in You now, and deliberately NOT gated there —
 * see the comment on that row for why hiding it was the worse of the two
 * failures.
 *
 * `href: null` rather than omitting the <Tabs.Screen>. Omitting one does NOT
 * hide it — expo-router auto-injects every route file in this folder whether
 * declared or not, so the tab would come back with a filename-derived title.
 * `href: null` hides the button and keeps the route resolvable, which matters
 * for an in-flight router.push and for deep links — and which is why both
 * screens still need their own off-state even now the tab usually stays.
 */
export default function TabLayout() {
  const { modules, ready } = useModules();
  const accent = useAccent();

  // Hold the frame until the cached module set has been read. This is the
  // whole reason the cache exists: without it the first frames compute
  // `tabHidden` from an empty list, so Food and Goals are ABSENT and
  // then pop in — the tab bar visibly rearranging on every cold start, which is
  // exactly what the provider's docstring says it prevents. `RootLayoutNav`
  // already holds a frame this way for Clerk.
  //
  // Still load-bearing after N61, and for the same reason: an empty list has no
  // food-log capability in it either, so the pre-cache answer is still "hide
  // both" and still wrong. Widening the gate did not remove the flash.
  //
  // (This used to name `anyCatalog` and the Library tab, which N70 moved into
  // You. Same failure, different tabs.)
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
            href: tabHidden(name, modules) ? null : undefined,
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

const TABS = [
  { name: 'index', title: 'Today', icon: 'dashboard' },
  // Second, not last. Food is logged more often than anything else in this app
  // — three to six times a day against once for a session — and the tab bar is
  // the only fixed-position affordance the phone has. A card on Today would
  // cost an extra tap every time, on a screen whose contents move.
  { name: 'food', title: 'Food', icon: 'food' },
  { name: 'workouts', title: 'Plan', icon: 'calendar' },
  // Library's old slot, and the swap is the user's own call: they asked for
  // the Library out of the bar ("we dont need a dedicated view") and for
  // targets to live in a Goals tab. A catalog is browsed occasionally and
  // deliberately, which is what a profile row is for; a target is the number
  // every food decision is measured against, which is what a fixed slot is
  // for. The bar holds what you check, not what you explore.
  { name: 'goals', title: 'Goals', icon: 'goal' },
  { name: 'you', title: 'You', icon: 'profile' },
] as const satisfies readonly { name: string; title: string; icon: IconName }[];

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
