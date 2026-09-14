import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import type { Module } from '@/lib/modules';
import { accents } from '@/constants/Colors';
import { TABS } from '@/lib/tabs';
import { IOS_ICON_RASTER_COLOR, tabIconRequestKey } from '@/lib/tabIconPlan';

import TabLayout from '../../app/(tabs)/_layout';

/**
 * The tab bar as `NativeTabs` actually receives it — N504/#876.
 *
 * `lib/__tests__/tabBar.test.ts` pins WHICH five tabs and in what order.
 * `lib/__tests__/tabIconPlan.test.ts` pins the pure per-platform icon-source
 * logic. This file pins that `(tabs)/_layout.tsx` wires all of that into
 * `NativeTabs` correctly, and the two frame-holds that only exist in the
 * render:
 *
 * - the module-set hold (unchanged from N176/N180 — see that history for why
 *   `(tabs)/index.tsx` needs it).
 * - the icon-raster hold (N504): `NativeTabs` must not mount until every tab
 *   icon has actually been captured, or the athlete's first frame is a tab
 *   bar with some icons and some blank slots.
 *
 * ## Why it mocks the navigator rather than rendering it
 *
 * `<NativeTabs>` is a real native-backed navigator. What is under test here
 * is the CONFIGURATION handed to it — which tabs, which icons, which colours
 * — so the mock records exactly that and nothing else, the same shape the
 * old `<Tabs>`-based version of this file used.
 */

type MockTrigger = {
  name: string;
  iconProps: Record<string, unknown> | null;
  labelText: string | null;
};

const mockTriggers: MockTrigger[] = [];
const mockNativeTabsProps: { current: Record<string, unknown> | null } = { current: null };
const mockModuleState: { modules: Module[]; ready: boolean } = { modules: [], ready: true };
const mockRaster: {
  current: { host: React.ReactNode; sources: Record<string, unknown> | null };
} = { current: { host: null, sources: {} } };

/*
 * Named function declarations, and no `require('react')` — same reasoning as
 * the file this replaces: `jest.mock` is hoisted above the imports, so a
 * factory cannot close over React, and `Trigger`/`NativeTabs` return their
 * `children` directly rather than wrapping them, which is legal for a
 * component and removes the only reason this factory would need JSX at all.
 */
jest.mock('expo-router/unstable-native-tabs', () => {
  function NativeTabs({ children, ...props }: any) {
    mockNativeTabsProps.current = props;
    return children;
  }
  function Trigger({ name, children }: any) {
    mockTriggers.push({ name, iconProps: null, labelText: null });
    return children;
  }
  Trigger.Icon = function TriggerIcon(props: any) {
    mockTriggers[mockTriggers.length - 1].iconProps = props;
    return null;
  };
  Trigger.Label = function TriggerLabel({ children }: any) {
    mockTriggers[mockTriggers.length - 1].labelText = children ?? null;
    return null;
  };
  NativeTabs.Trigger = Trigger;
  return { NativeTabs };
});

/*
 * N580, F70: the layout names Today itself when nothing chose a tab. These four
 * hooks are all it reads for that. The global `expo-router` mock in
 * `jest.setup.js` does not carry them, so this file supplies them. The
 * behaviour against the real router, under every mount order, is
 * `tabDefault.test.tsx`'s job; this only pins that the layout asks, when, and
 * with which action.
 *
 * The container stand-in holds the layout's `state` listeners, and `publish`
 * plays the container publishing its state. The Android back handler (F68)
 * reads the same container, and this iOS-only file never subscribes it.
 */
const mockDispatch = jest.fn();
const mockStateListeners: (() => void)[] = [];
const mockNav: { segments: string[]; params: object | undefined; rootState: object | undefined } = {
  segments: ['(tabs)'],
  params: undefined,
  rootState: undefined,
};
jest.mock('expo-router', () => {
  const navigation = { dispatch: (action: unknown) => mockDispatch(action), isFocused: () => false };
  const container = {
    addListener: (_event: string, listener: () => void) => {
      mockStateListeners.push(listener);
      return () => {
        const i = mockStateListeners.indexOf(listener);
        if (i !== -1) mockStateListeners.splice(i, 1);
      };
    },
    getRootState: () => mockNav.rootState,
  };
  return {
    useNavigation: () => navigation,
    useRoute: () => ({ key: 'tabs-route', params: mockNav.params }),
    useSegments: () => mockNav.segments,
    useNavigationContainerRef: () => container,
  };
});

/** The container publishing its state, as it does after a commit that changed it. */
function publish(rootState: object) {
  mockNav.rootState = rootState;
  for (const listener of [...mockStateListeners]) listener();
}

/** A cold start at `/goals`: the stack has published, the tab navigator does not exist yet. */
const TABS_NOT_BUILT = {
  routes: [
    {
      key: 'root-route',
      name: '__root',
      state: { routes: [{ key: 'tabs-route', name: '(tabs)' }, { key: 'goals-route', name: 'goals' }] },
    },
  ],
};

/** The same, once the tab navigator has built its state on its first route. */
const TABS_BUILT = {
  routes: [
    {
      key: 'root-route',
      name: '__root',
      state: {
        routes: [
          {
            key: 'tabs-route',
            name: '(tabs)',
            state: { key: 'tab-navigator', index: 0, routes: TABS.map(({ name }) => ({ key: name, name })) },
          },
          { key: 'goals-route', name: 'goals' },
        ],
      },
    },
  ],
};

jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => mockModuleState }));
// The purple theme, not the brand one: its `accent` and `ink` differ, so the
// assertions below can tell which of the two the tab bar was given. The brand
// theme's are the same value, and so were this stub's (the pre-N183 lime) —
// a swap from `accent` to `ink` passed unseen. N161 (#578).
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => jest.requireActual('@/constants/Colors').accents.purple,
}));
jest.mock('@/lib/tabIconRaster', () => ({ useRasterizedIcons: () => mockRaster.current }));

/** A resolved-sources map covering every icon `TABS` names, on iOS's key shape. */
function resolvedIosSources(): Record<string, { uri: string }> {
  const sources: Record<string, { uri: string }> = {};
  for (const { icon } of TABS) {
    sources[tabIconRequestKey({ name: icon, color: IOS_ICON_RASTER_COLOR })] = { uri: `mock://${icon}` };
  }
  return sources;
}

async function declare(state: {
  modules: Module[];
  ready: boolean;
  raster: { host: React.ReactNode; sources: Record<string, unknown> | null };
  segments?: string[];
  params?: object;
}) {
  mockTriggers.length = 0;
  mockNativeTabsProps.current = null;
  mockModuleState.modules = state.modules;
  mockModuleState.ready = state.ready;
  mockRaster.current = state.raster;
  mockNav.segments = state.segments ?? ['(tabs)'];
  mockNav.params = state.params;
  mockNav.rootState = undefined;
  mockStateListeners.length = 0;
  mockDispatch.mockClear();
  await render(<TabLayout />);
}

describe('which tab the navigator opens on (N580, F70)', () => {
  it('jumps the tab navigator to Today when nothing chose a tab, once it exists, even while the module set is still loading', async () => {
    // The anchor under a cold-started deep link to a pushed screen: the URL is
    // that screen, and the tab route carries no `screen` param.
    await declare({ modules: [], ready: false, raster: { host: null, sources: null }, segments: ['goals'] });
    // Not from the layout's own effect: on a phone that is too early (F70).
    expect(mockDispatch).not.toHaveBeenCalled();

    publish(TABS_NOT_BUILT);
    expect(mockDispatch).not.toHaveBeenCalled();

    publish(TABS_BUILT);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'JUMP_TO', target: 'tab-navigator', payload: { name: 'index' } });

    // Once. A later state event is the athlete's own navigation.
    publish(TABS_BUILT);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('leaves the tab alone when the URL chose one', async () => {
    await declare({ modules: [], ready: true, raster: { host: null, sources: {} }, segments: ['(tabs)', 'food'] });
    publish(TABS_BUILT);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('leaves the tab alone when the navigation that created it named one', async () => {
    await declare({
      modules: [],
      ready: true,
      raster: { host: null, sources: {} },
      segments: ['sign-in'],
      params: { screen: 'food', params: {} },
    });
    publish(TABS_BUILT);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('before the module set has been read', () => {
  it('renders nothing at all — not even the icon rig', async () => {
    await declare({ modules: [], ready: false, raster: { host: <Text testID="icon-host" />, sources: null } });
    expect(mockNativeTabsProps.current).toBeNull();
    expect(mockTriggers).toEqual([]);
    expect(screen.queryByTestId('icon-host')).toBeNull();
  });
});

describe('while icons are still being rasterised', () => {
  it('renders the capture rig, not NativeTabs', async () => {
    await declare({ modules: [], ready: true, raster: { host: <Text testID="icon-host" />, sources: null } });
    expect(screen.getByTestId('icon-host')).toBeTruthy();
    expect(mockNativeTabsProps.current).toBeNull();
    expect(mockTriggers).toEqual([]);
  });
});

describe('once ready and every icon has landed', () => {
  async function declareReady() {
    await declare({ modules: [], ready: true, raster: { host: null, sources: resolvedIosSources() } });
  }

  it('gives NativeTabs Food, Progress, Today, Plan, You, in that order', async () => {
    await declareReady();
    expect(mockTriggers.map((t) => t.name)).toEqual(['food', 'progress', 'index', 'workouts', 'you']);
    expect(mockTriggers.map((t) => t.labelText)).toEqual(['Food', 'Progress', 'Today', 'Plan', 'You']);
  });

  it('gives every tab an icon source', async () => {
    await declareReady();
    for (const t of mockTriggers) {
      const src = t.iconProps?.src as { default: unknown; selected: unknown } | undefined;
      expect(src?.default).toBeTruthy();
      expect(src?.selected).toBeTruthy();
    }
  });

  // jest-expo reports `Platform.OS === 'ios'` — the Android branch is
  // `lib/__tests__/tabIconPlan.test.ts`'s job, since a component test here
  // cannot observe it (see that file's own top-of-file comment).
  it('reuses the same image for default and selected on iOS, in template mode', async () => {
    await declareReady();
    for (const t of mockTriggers) {
      const src = t.iconProps?.src as { default: unknown; selected: unknown };
      expect(src.default).toBe(src.selected);
      expect(t.iconProps?.renderingMode).toBe('template');
    }
  });

  it('feeds the navigator the accent for tinting, and vola.textDim for inactive', async () => {
    await declareReady();
    const props = mockNativeTabsProps.current!;
    expect(props.tintColor).toBe(accents.purple.accent);
    expect(props.iconColor).toEqual({ default: expect.any(String), selected: accents.purple.accent });
    const labelStyle = props.labelStyle as { default: { color: string }; selected: { color: string } };
    expect(labelStyle.selected.color).toBe(accents.purple.accent);
    expect(labelStyle.default.color).not.toBe(accents.purple.accent);
  });

  it('minimises on scroll down, the iOS 26 behaviour this ticket asked for', async () => {
    await declareReady();
    expect(mockNativeTabsProps.current?.minimizeBehavior).toBe('onScrollDown');
  });

  it('leaves exactly five triggers, with Train and Goals nowhere in the list', async () => {
    await declareReady();
    expect(mockTriggers).toHaveLength(5);
    expect(mockTriggers.map((t) => t.name)).not.toContain('train');
    expect(mockTriggers.map((t) => t.name)).not.toContain('goals');
  });
});
