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
 * ## What the root stands in for, and why there are three (F70)
 *
 * **When the root stack mounts decides whether the pin works, so every
 * cold-start case runs under each order.** N580's version of this file had one
 * root, a bare `<Stack>` mounted in the navigation container's own commit, and
 * its `/goals` case passed. The real `app/_layout.tsx` returns null until its
 * fonts load, so on a phone the stack mounts a commit later, and there N580's
 * pin was lost and back landed on Food. The test could not fail on the path
 * the app takes.
 *
 * - `plainRoot`: a bare `<Stack>` in the container's commit, with the one root
 *   setting that matters, `unstable_settings.initialRouteName: '(tabs)'`.
 * - `lateRoot`: the same, mounted a microtask later.
 * - `realRoot`: `app/_layout.tsx` itself. Clerk, the orchestrators and the
 *   providers are stubbed below, and `useFonts` loads a macrotask after mount,
 *   so the file's own `if (!loaded) return null` is what delays the stack. A
 *   precondition asserts the gate really was closed on the first render.
 *
 * Sign-in is replayed on `plainRoot` only, as the call the root layout makes,
 * `router.replace('/')`: the real layout's auth guard would redirect on its own
 * and the test would no longer be about the replace. The screens are stubs:
 * which tab is focused is the router's answer, read from its state, not from
 * what rendered.
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
 *   the tab layout mounts. With the stack mounted later, as on a phone, the tab
 *   layout is asked first. With the stack in the container's commit, the router
 *   is asked first. The F68 cases run under every root, and assert which order
 *   they got.
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
// The two providers are for the real root layout, which wraps the navigator in
// them.
jest.mock('@/lib/ModulesProvider', () => ({
  useModules: () => ({ modules: [], ready: true }),
  ModulesProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => jest.requireActual('@/constants/Colors').accents.purple,
  AccentProvider: ({ children }: { children: React.ReactNode }) => children,
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

// Everything else `app/_layout.tsx` imports (F70). A signed-in athlete whose
// session needs no resume check, and five orchestrators that do nothing. None
// of these touches navigation, which is what is under test.
jest.mock('@clerk/clerk-expo', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ userId: 'u1', isLoaded: true, isSignedIn: true, getToken: async () => 'tok' }),
  useSignUp: () => ({ signUp: undefined }),
}));
jest.mock('@/lib/authResume', () => ({ useResumeSignOutGuard: () => false }));
jest.mock('@/lib/useReducedMotion', () => ({ useReducedMotion: () => false }));
jest.mock('@/lib/TrackEffortProvider', () => ({
  TrackEffortProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/lib/UnitsProvider', () => ({ UnitsProvider: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('@/lib/telemetryClient', () => ({ clearTelemetryForSignOut: () => {}, installTelemetry: () => {} }));
jest.mock('@/lib/sounds', () => ({ initSounds: async () => {} }));
jest.mock('@/lib/voice', () => ({ initVoice: async () => {} }));
jest.mock('@/lib/session', () => ({ clearSessionToken: async () => {} }));
jest.mock('@/lib/seed', () => ({ seedIfNeeded: async () => {} }));
jest.mock('@/lib/sessionStore', () => ({ syncSessions: async () => {} }));
jest.mock('@/lib/tokenCache', () => ({ tokenCache: {} }));
jest.mock('@/lib/sync', () => ({ setSyncIdentity: () => {}, startSyncOrchestrator: () => () => {} }));
jest.mock('@/lib/healthkitSync', () => ({
  setHealthKitSyncIdentity: () => {},
  startHealthKitImportOrchestrator: () => () => {},
}));
jest.mock('@/lib/biometricSync', () => ({
  setBiometricSyncIdentity: () => {},
  startBiometricSyncOrchestrator: () => () => {},
}));
jest.mock('@/lib/hrMonitor/orchestrator', () => ({
  setHRMonitorIdentity: () => {},
  startHRMonitorOrchestrator: () => () => {},
}));
jest.mock('@/lib/healthConnectSync', () => ({
  setHealthConnectSyncIdentity: () => {},
  startHealthConnectSyncOrchestrator: () => () => {},
}));
jest.mock('@/lib/shareInbox', () => ({ setShareInboxIdentity: () => {}, startShareInboxOrchestrator: () => () => {} }));
jest.mock('@/components/AnimatedSplash', () => ({ AnimatedSplash: () => null }));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: async () => {},
  setOptions: () => {},
  hideAsync: async () => {},
}));
/** Every value `useFonts` returned for `loaded`, in render order. */
const mockFontsLoaded: boolean[] = [];
jest.mock('expo-font', () => ({
  // Loads a macrotask after mount, as a real font load does.
  useFonts: () => {
    const react = jest.requireActual<typeof import('react')>('react');
    const [loaded, setLoaded] = react.useState(false);
    react.useEffect(() => {
      const timer = setTimeout(() => setLoaded(true), 0);
      return () => clearTimeout(timer);
    }, []);
    mockFontsLoaded.push(loaded);
    return [loaded, null];
  },
}));

type BackButton = { exitApp: jest.Mock; press: () => void; askOrder: () => string[] };

function backButton(): BackButton {
  return jest.requireMock<{ default: BackButton }>('react-native/Libraries/Utilities/BackHandler').default;
}

function stub(id: string) {
  return function StubScreen() {
    return <Text>{id}</Text>;
  };
}

type RootLayout = { default: () => React.ReactElement | null; unstable_settings?: object };

/** Copied from `app/_layout.tsx`: what puts the tabs under a cold-started deep link. */
const ROOT_SETTINGS = { initialRouteName: '(tabs)' };

/** Mounts the stack in the same commit as the navigation container. */
const plainRoot: RootLayout = {
  default: function RootStack() {
    return <Stack />;
  },
  unstable_settings: ROOT_SETTINGS,
};

/** Mounts the stack a commit later, the shape of `app/_layout.tsx`. */
const lateRoot: RootLayout = {
  default: function LateRootStack() {
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
  },
  unstable_settings: ROOT_SETTINGS,
};

/**
 * `app/_layout.tsx` itself. Loaded after the Clerk key is set, because the file
 * reads it at module scope and throws at render without one.
 */
const realRoot: RootLayout = (() => {
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_tabDefault';
  return jest.requireActual<RootLayout>('../../app/_layout');
})();

/** The three mount orders, for the cold-start cases. */
const MOUNT_ORDERS = [
  ['with the stack mounted in the container’s commit', plainRoot],
  ['with the stack mounted a commit later', lateRoot],
  ['under the real app/_layout.tsx', realRoot],
] as const;

/** Every other route `app/_layout.tsx` declares, so its `Stack.Screen`s all resolve. */
const DECLARED_ROUTES = [
  'sign-up',
  'forgot-password',
  'workout/[id]',
  'settings',
  'settings/units',
  'profile/edit',
  'checkin/[date]',
  'library',
  'train',
  'day',
  'curriculum/index',
  'curriculum/new',
  'curriculum/edit/[id]',
  'exercise/[id]',
  'technique/[id]',
  'run-type/[id]',
  'hr-zones',
  'position/[id]',
  'session/start',
  'session/[id]',
  'session/[id]/add',
];

function app(root: RootLayout) {
  return {
    ...Object.fromEntries(DECLARED_ROUTES.map((name) => [name, stub(name)])),
    _layout: root,
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

async function open(initialUrl: string, root: RootLayout = plainRoot) {
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

describe('the real root layout, as this file renders it (F70)', () => {
  // If the stubbed font load resolved before the first render, `realRoot` would
  // mount the stack in the container's commit and be `plainRoot` by another
  // name, and the late-mount cases below would prove nothing about the app.
  it('renders nothing until its fonts load, then the deep-linked screen', async () => {
    mockFontsLoaded.length = 0;
    const app = await open('/goals', realRoot);
    expect(mockFontsLoaded[0]).toBe(false);
    expect(mockFontsLoaded).toContain(true);
    expect(app.pathname()).toBe('/goals');
  });
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
    it.each(MOUNT_ORDERS)('on a cold start, %s', async (_order, root) => {
      const app = await open('/', root);
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
    // screen with no tab named, and NativeTabs picks its first route.
    //
    // N580 ran this with the stack in the container's commit only, and it
    // passed. With the stack mounted later, as the real root layout mounts it,
    // it landed on Food (F70).
    it.each(MOUNT_ORDERS)(
      'when it goes back from a screen the app was cold-started on by a deep link, %s',
      async (_order, root) => {
        const app = await open('/goals', root);
        // The pin moves the tab under the pushed screen. It must not pop that
        // screen, or the athlete never sees the link they opened.
        expect(app.pathname()).toBe('/goals');
        await go(() => router.back());
        expect(app.pathname()).toBe('/');
        expect(app.focusedTab()).toBe('index');
      },
    );

    // The pin happens once. A tab chosen after it is the athlete's.
    it.each(MOUNT_ORDERS)('and a tab chosen after that stays chosen, %s', async (_order, root) => {
      const app = await open('/goals', root);
      await go(() => router.back());
      expect(app.focusedTab()).toBe('index');
      await go(() => router.navigate('/progress'));
      expect(app.pathname()).toBe('/progress');
      expect(app.focusedTab()).toBe('progress');
    });
  });

  // The other direction, and the one a heavier pin breaks: forcing Today onto
  // the tab navigator unconditionally sent both of these to Today.
  describe.each(MOUNT_ORDERS)('a deep link to another tab still lands on that tab, %s', (_order, root) => {
    it.each([
      ['/food', 'food'],
      ['/progress', 'progress'],
    ] as const)('%s', async (url, tab) => {
      const app = await open(url, root);
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
    ['the router is asked first', plainRoot, ['router', 'tab layout']],
    ['the tab layout is asked first', lateRoot, ['tab layout', 'router']],
    ['the real root layout mounts the stack', realRoot, ['tab layout', 'router']],
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

    // N580's pin and F68's handler on the one path both touch.
    it('from a screen the app was cold-started on by a deep link, to Today, then out', async () => {
      const app = await open('/goals', root);
      expect(app.pathname()).toBe('/goals');
      await pressBack();
      expect(app.pathname()).toBe('/');
      expect(app.focusedTab()).toBe('index');
      await pressBack();
      expect(backButton().exitApp).toHaveBeenCalledTimes(1);
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
});

describe('on iOS, nothing about back changes (F68)', () => {
  beforeEach(() => {
    mockOS = 'ios';
  });

  // iOS has no back button between tabs. The Android block's order assertion is
  // this one's positive control: the same harness does see the tab layout's
  // handler when there is one.
  it.each([
    ['the router is asked first', plainRoot],
    ['the tab layout would be asked first', lateRoot],
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
