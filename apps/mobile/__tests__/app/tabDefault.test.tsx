import { Text } from 'react-native';
import { act } from '@testing-library/react-native';
import { router, Stack } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import { TABS } from '@/lib/tabs';

import * as TabsLayoutModule from '../../app/(tabs)/_layout';

/**
 * Today is the screen the app opens on, and NOT because it comes first — N580.
 *
 * The owner moved Today to the centre of the bar (2026-09-14), so `TABS[0]` is
 * Food. Every test here runs the REAL expo-router and the REAL NativeTabs, with
 * the REAL `app/(tabs)/_layout.tsx` and the real `TABS` order. So a default
 * carried by position would show up here as Food.
 *
 * ## Why the real router and not a mock
 *
 * The question is what the router DOES with the layout, and a stub can only
 * repeat what its author believed. The belief was wrong once already.
 * `unstable_settings.initialRouteName` in the tab layout was the obvious pin,
 * and against this harness it changed nothing on any path. `NativeTabsNavigator`
 * never gives `initialRouteName` to its router. The layout now names Today
 * itself when nothing chose a tab: `lib/tabs.ts`, `tabWasChosen`.
 *
 * ## What the harness stands in for
 *
 * The root layout here is a bare `<Stack>` with the one root setting that
 * matters, `unstable_settings.initialRouteName: '(tabs)'`, copied from
 * `app/_layout.tsx`. That setting is what puts the tab navigator under a
 * cold-started deep link. The real root layout cannot be rendered in a test
 * (Clerk, five orchestrators), so its post-sign-in redirect is replayed as the
 * same call it makes, `router.replace('/')`. The screens are stubs: which tab
 * is focused is the router's answer, read from its state, not from what
 * rendered.
 */

jest.unmock('expo-router');

// `expo-router`'s navigator chrome reads the safe-area CONTEXTS, which the
// shared mock in `jest.setup.js` does not export (screens only need the hooks).
jest.mock('react-native-safe-area-context', () => {
  const react = jest.requireActual<typeof import('react')>('react');
  const inset = { top: 47, bottom: 34, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaInsetsContext: react.createContext(inset),
    SafeAreaFrameContext: react.createContext(frame),
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => frame,
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
    initialWindowMetrics: { insets: inset, frame },
  };
});

// The tab layout's own frame-holds, satisfied immediately — the same three
// stand-ins `tabLayout.test.tsx` uses, for the same reasons.
jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => ({ modules: [], ready: true }) }));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => jest.requireActual('@/constants/Colors').accents.purple,
}));
jest.mock('@/lib/tabIconRaster', () => {
  const { tabIconRequestKey, IOS_ICON_RASTER_COLOR } = jest.requireActual('@/lib/tabIconPlan');
  const sources: Record<string, { uri: string }> = {};
  for (const icon of ['food', 'progress', 'dashboard', 'calendar', 'profile']) {
    sources[tabIconRequestKey({ name: icon, color: IOS_ICON_RASTER_COLOR })] = { uri: `mock://${icon}` };
  }
  return { useRasterizedIcons: () => ({ host: null, sources }) };
});

function stub(id: string) {
  return function StubScreen() {
    return <Text>{id}</Text>;
  };
}

function RootStack() {
  return <Stack />;
}

function app() {
  return {
    _layout: { default: RootStack, unstable_settings: { initialRouteName: '(tabs)' } },
    '(tabs)/_layout': TabsLayoutModule,
    '(tabs)/index': stub('Today'),
    '(tabs)/food': stub('Food'),
    '(tabs)/progress': stub('Progress'),
    '(tabs)/workouts': stub('Plan'),
    '(tabs)/you': stub('You'),
    goals: stub('Goals'),
    'sign-in': stub('Sign in'),
  };
}

type NavState = { index?: number; routeNames?: string[]; routes: { name: string; state?: NavState }[] };

/**
 * The navigator's LIVE state, not the state the URL was parsed into.
 *
 * `renderRouter`'s `getRouterState()` hands back the linking-derived state,
 * where the tab route holds only the one tab the URL named, so a focused-tab
 * read against it reports the URL's answer, not the navigator's. This file's
 * first run caught exactly that: the precondition test saw one route where the
 * navigator has five. The container ref is the navigator's own account.
 */
function liveRootState(): NavState {
  const { store } = jest.requireActual('expo-router/build/global-state/router-store');
  const state = store.navigationRef?.getRootState?.() as NavState | undefined;
  if (!state) throw new Error('no live navigation state: the container never mounted');
  return state;
}

/**
 * The tab navigator on the FOCUSED chain (a stale one can sit below it), and
 * only once the navigator has actually built it: all five routes, with
 * `routeNames`. A partial state cannot satisfy an assertion here.
 */
function focusedTabNavigator(): NavState {
  let s: NavState | undefined = liveRootState();
  while (s) {
    const r: NavState['routes'][number] | undefined = s.routes[s.index ?? s.routes.length - 1];
    if (!r) break;
    if (r.name === '(tabs)') {
      const tabs = r.state;
      if (!tabs?.routeNames || tabs.routes.length !== TABS.length) {
        throw new Error(`the tab navigator is not built yet: ${JSON.stringify(tabs)}`);
      }
      return tabs;
    }
    s = r.state;
  }
  throw new Error('no tab navigator on the focused chain');
}

async function open(initialUrl: string) {
  const result = renderRouter(app(), { initialUrl });
  await result;
  await settle();
  return {
    pathname: () => result.getPathname(),
    focusedTab: () => {
      const tabs = focusedTabNavigator();
      return tabs.routes[tabs.index ?? 0]?.name;
    },
    tabRouteNames: () => focusedTabNavigator().routes.map((r) => r.name),
  };
}

/** Let the router's scheduled updates and the layout's effect land. */
async function settle() {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
}

async function go(fn: () => void) {
  await act(async () => fn());
  await settle();
}

describe('the precondition every test below relies on', () => {
  // If Today were first again, every test in this file would pass by position
  // and prove nothing. So the router's own first route is asserted, not just
  // the array.
  it('puts Food, not Today, first in the router the app actually builds', async () => {
    expect(TABS[0].name).toBe('food');
    const app = await open('/');
    expect(app.tabRouteNames()).toEqual(['food', 'progress', 'index', 'workouts', 'you']);
  });
});

describe('Today is where the app sends the athlete', () => {
  it('on a cold start', async () => {
    const app = await open('/');
    expect(app.pathname()).toBe('/');
    expect(app.focusedTab()).toBe('index');
  });

  it('when sign-in completes', async () => {
    const app = await open('/');
    await go(() => router.replace('/sign-in'));
    expect(app.pathname()).toBe('/sign-in');
    await go(() => router.replace('/'));
    expect(app.pathname()).toBe('/');
    expect(app.focusedTab()).toBe('index');
  });

  // `app/train.tsx`'s `<Redirect href="/(tabs)" />` and `running/[id].tsx`'s
  // `router.replace('/(tabs)')` both go through this.
  it('when something sends it to /(tabs)', async () => {
    const app = await open('/sign-in');
    await go(() => router.replace('/(tabs)'));
    expect(app.focusedTab()).toBe('index');
  });

  // **The one path where position decides, and the reason the layout carries
  // a pin.** The root layout's anchor puts the tabs under the deep-linked
  // screen with no tab named, and NativeTabs picks its first route. Remove the
  // layout's `setParams` and this lands on Food.
  it('when it goes back from a screen the app was cold-started on by a deep link', async () => {
    const app = await open('/goals');
    expect(app.pathname()).toBe('/goals');
    await go(() => router.back());
    expect(app.pathname()).toBe('/');
    expect(app.focusedTab()).toBe('index');
  });
});

describe('a deep link to another tab still lands on that tab', () => {
  // The other direction, and the one a heavier pin breaks: forcing `screen:
  // 'index'` onto the tab route unconditionally sent both of these to Today.
  it.each([
    ['/food', 'food'],
    ['/progress', 'progress'],
  ] as const)('%s', async (url, tab) => {
    const app = await open(url);
    expect(app.pathname()).toBe(url);
    expect(app.focusedTab()).toBe(tab);
  });
});
