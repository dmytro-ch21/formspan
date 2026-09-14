import { useEffect, useState } from 'react';
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
 *
 * ## Android's back button (F68)
 *
 * The owner's decision, 2026-09-14: *"make back go to Today on Android"*. Back
 * from any other tab goes to Today, a screen pushed over a tab is popped first,
 * and back on Today leaves the app.
 *
 * - **Platform.** jest-expo runs as iOS, and `Platform.OS` is a getter there, so
 *   `Platform` is replaced with a getter each test sets (the approach
 *   `healthConnectRefusalLine.test.tsx` uses). The N580 cases run on both
 *   platforms, because Android's bar has a different `backBehavior`.
 * - **The back button.** `BackHandler` is replaced with a copy of Android's
 *   dispatch (`BackHandler.android.js`): the newest subscriber is asked first,
 *   the first to return true stops it, and if none does it is `exitApp`. The
 *   router's own handler (`useBackButton.native.js`) subscribes through it too,
 *   so a press here asks the same handlers a phone asks.
 * - **Both handler orders.** Which of those two is asked first depends on when
 *   the tab layout mounts. The real root layout returns null until fonts load,
 *   so on a phone the tab layout mounts later and is asked first. A plain root
 *   mounts both in one commit, and the router is asked first. The F68 cases run
 *   under both, and assert which order they got.
 */

jest.unmock('expo-router');

let mockOS: 'ios' | 'android' = 'ios';
jest.mock('react-native/Libraries/Utilities/Platform', () => {
  const base = {
    select: (spec: Record<string, unknown>) =>
      mockOS in spec ? spec[mockOS] : 'native' in spec ? spec.native : spec.default,
    Version: 35,
    isTV: false,
    isTesting: true,
    constants: {},
  };
  const platform = { ...base };
  Object.defineProperty(platform, 'OS', { get: () => mockOS, enumerable: true });
  const mod = { __esModule: true, default: platform, ...base };
  Object.defineProperty(mod, 'OS', { get: () => mockOS, enumerable: true });
  return mod;
});

jest.mock('react-native/Libraries/Utilities/BackHandler', () => {
  const subscribers: { handler: () => boolean | null | undefined; from: string }[] = [];
  const BackHandler = {
    exitApp: jest.fn(),
    addEventListener(_event: string, handler: () => boolean | null | undefined) {
      // Who subscribed, read off the call stack, so a test asserts the order it
      // claims to be testing instead of assuming it.
      const stack = new Error().stack ?? '';
      const from = stack.includes('(tabs)/_layout')
        ? 'tab layout'
        : stack.includes('useBackButton')
          ? 'router'
          : 'other';
      if (!subscribers.some((s) => s.handler === handler)) subscribers.push({ handler, from });
      return {
        remove() {
          const i = subscribers.findIndex((s) => s.handler === handler);
          if (i !== -1) subscribers.splice(i, 1);
        },
      };
    },
    /** One press of Android's back button. */
    press() {
      for (let i = subscribers.length - 1; i >= 0; i--) {
        if (subscribers[i]?.handler()) return;
      }
      BackHandler.exitApp();
    },
    /** Who a press asks, in the order it asks them. */
    askOrder: () => subscribers.map((s) => s.from).reverse(),
  };
  return { __esModule: true, default: BackHandler };
});

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
// stand-ins `tabLayout.test.tsx` uses, for the same reasons. The icon rasters
// cover both platforms' colours, since the layout asks for Android's pair there.
jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => ({ modules: [], ready: true }) }));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => jest.requireActual('@/constants/Colors').accents.purple,
}));
jest.mock('@/lib/tabIconRaster', () => {
  const { tabIconRequestKey, IOS_ICON_RASTER_COLOR } = jest.requireActual('@/lib/tabIconPlan');
  const { ANDROID_ACTIVE_ICON_COLOR, ANDROID_INACTIVE_ICON_COLOR } = jest.requireActual('@/lib/tabs');
  const sources: Record<string, { uri: string }> = {};
  for (const icon of ['food', 'progress', 'dashboard', 'calendar', 'profile']) {
    for (const color of [IOS_ICON_RASTER_COLOR, ANDROID_ACTIVE_ICON_COLOR, ANDROID_INACTIVE_ICON_COLOR]) {
      sources[tabIconRequestKey({ name: icon, color })] = { uri: `mock://${icon}/${color}` };
    }
  }
  return { useRasterizedIcons: () => ({ host: null, sources }) };
});

type BackButton = { exitApp: jest.Mock; press: () => void; askOrder: () => string[] };

function backButton(): BackButton {
  return jest.requireMock<{ default: BackButton }>('react-native/Libraries/Utilities/BackHandler').default;
}

function stub(id: string) {
  return function StubScreen() {
    return <Text>{id}</Text>;
  };
}

/** Mounts the stack in the same commit as the navigation container. */
function RootStack() {
  return <Stack />;
}

/**
 * Mounts the stack a commit later, the way `app/_layout.tsx` does by returning
 * null until its fonts load. The tab layout then subscribes after the router.
 */
function LateRootStack() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);
  return ready ? <Stack /> : null;
}

function app(root: () => React.ReactElement | null) {
  return {
    _layout: { default: root, unstable_settings: { initialRouteName: '(tabs)' } },
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

type NavState = {
  index?: number;
  routeNames?: string[];
  history?: { key: string }[];
  routes: { name: string; key: string; state?: NavState }[];
};

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

async function open(initialUrl: string, root: () => React.ReactElement | null = RootStack) {
  const result = renderRouter(app(root), { initialUrl });
  await result;
  await settle();
  return {
    pathname: () => result.getPathname(),
    focusedTab: () => {
      const tabs = focusedTabNavigator();
      return tabs.routes[tabs.index ?? 0]?.name;
    },
    tabRouteNames: () => focusedTabNavigator().routes.map((r) => r.name),
    /** The tab router's back history, as tab names. */
    tabHistory: () => {
      const tabs = focusedTabNavigator();
      return (tabs.history ?? []).map((h) => tabs.routes.find((r) => r.key === h.key)?.name);
    },
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

async function pressBack() {
  await go(() => backButton().press());
}

beforeEach(() => {
  backButton().exitApp.mockClear();
});

describe.each(['ios', 'android'] as const)('on %s', (os) => {
  beforeEach(() => {
    mockOS = os;
  });

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
    //
    // Plain root only. With `LateRootStack`, the shape of the real root layout,
    // this lands on Food on both platforms, with or without F68: measured while
    // building F68, and reported there rather than fixed in passing.
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
});

describe('on Android, back goes to Today (F68)', () => {
  beforeEach(() => {
    mockOS = 'android';
  });

  describe.each([
    ['the router is asked first', RootStack, ['router', 'tab layout']],
    ['the tab layout is asked first', LateRootStack, ['tab layout', 'router']],
  ] as const)('when %s', (_order, root, askOrder) => {
    // Guards the describe's own name: if the order silently flipped, both
    // blocks would test the same thing.
    it('asks the handlers in that order', async () => {
      await open('/', root);
      expect(backButton().askOrder()).toEqual(askOrder);
    });

    // Before F68, every one of these landed on Food, the bar's first route.
    it.each([
      ['/food', 'food'],
      ['/progress', 'progress'],
      ['/workouts', 'workouts'],
      ['/you', 'you'],
    ] as const)('from %s, opened from Today', async (url, tab) => {
      const app = await open('/', root);
      await go(() => router.navigate(url));
      expect(app.focusedTab()).toBe(tab);
      await pressBack();
      expect(app.pathname()).toBe('/');
      expect(app.focusedTab()).toBe('index');
      expect(backButton().exitApp).not.toHaveBeenCalled();
    });

    it('from a tab the app was cold-started on by a deep link', async () => {
      const app = await open('/progress', root);
      expect(app.focusedTab()).toBe('progress');
      await pressBack();
      expect(app.pathname()).toBe('/');
      expect(app.focusedTab()).toBe('index');
      expect(backButton().exitApp).not.toHaveBeenCalled();
    });

    // Before F68, back on Today went to Food too: the tab router kept Food
    // behind every tab, Today included.
    it('and back on Today leaves the app, before and after visiting another tab', async () => {
      const app = await open('/', root);
      await pressBack();
      expect(backButton().exitApp).toHaveBeenCalledTimes(1);
      expect(app.focusedTab()).toBe('index');

      await go(() => router.navigate('/progress'));
      await pressBack();
      expect(app.focusedTab()).toBe('index');
      expect(backButton().exitApp).toHaveBeenCalledTimes(1);
      await pressBack();
      expect(backButton().exitApp).toHaveBeenCalledTimes(2);
      expect(app.focusedTab()).toBe('index');
    });

    it('pops a screen pushed over a tab before it leaves the tab', async () => {
      const app = await open('/', root);
      await go(() => router.navigate('/progress'));
      await go(() => router.push('/goals'));
      expect(app.pathname()).toBe('/goals');

      await pressBack();
      expect(app.pathname()).toBe('/progress');
      expect(app.focusedTab()).toBe('progress');

      await pressBack();
      expect(app.pathname()).toBe('/');
      expect(app.focusedTab()).toBe('index');
      expect(backButton().exitApp).not.toHaveBeenCalled();
    });
  });

  // N580's pin and F68's handler on the one path both touch. Plain root only,
  // for the reason given on N580's own case above.
  it('from a screen the app was cold-started on by a deep link, to Today, then out', async () => {
    const app = await open('/goals');
    await pressBack();
    expect(app.pathname()).toBe('/');
    expect(app.focusedTab()).toBe('index');
    await pressBack();
    expect(backButton().exitApp).toHaveBeenCalledTimes(1);
  });
});

describe('on iOS, nothing about back changes (F68)', () => {
  beforeEach(() => {
    mockOS = 'ios';
  });

  // iOS has no back button between tabs. The Android block's order assertion is
  // this one's positive control: the same harness does see the tab layout's
  // handler when there is one.
  it.each([
    ['the router is asked first', RootStack],
    ['the tab layout would be asked first', LateRootStack],
  ] as const)('subscribes no back handler of its own, when %s', async (_order, root) => {
    await open('/', root);
    expect(backButton().askOrder()).toEqual(['router']);
  });

  it('leaves the tab router on its default back history', async () => {
    const app = await open('/');
    await go(() => router.navigate('/progress'));
    expect(app.tabHistory()).toEqual(['food', 'progress']);
  });
});
