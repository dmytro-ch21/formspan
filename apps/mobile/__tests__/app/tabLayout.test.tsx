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
 * N580: the layout names Today itself when nothing chose a tab. These three
 * hooks are all it reads for that. The global `expo-router` mock in
 * `jest.setup.js` does not carry them, so this file supplies them. The
 * behaviour against the real router is `tabDefault.test.tsx`'s job; this only
 * pins that the layout asks, and when.
 */
const mockSetParams = jest.fn();
const mockNav: { segments: string[]; params: object | undefined } = { segments: ['(tabs)'], params: undefined };
jest.mock('expo-router', () => ({
  useNavigation: () => ({ setParams: mockSetParams }),
  useRoute: () => ({ params: mockNav.params }),
  useSegments: () => mockNav.segments,
}));

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
  mockSetParams.mockClear();
  await render(<TabLayout />);
}

describe('which tab the navigator opens on (N580)', () => {
  it('asks for Today when nothing chose a tab, even while the module set is still loading', async () => {
    // The anchor under a cold-started deep link to a pushed screen: the URL is
    // that screen, and the tab route carries no `screen` param.
    await declare({ modules: [], ready: false, raster: { host: null, sources: null }, segments: ['goals'] });
    expect(mockSetParams).toHaveBeenCalledTimes(1);
    expect(mockSetParams).toHaveBeenCalledWith({ screen: 'index' });
  });

  it('leaves the tab alone when the URL chose one', async () => {
    await declare({ modules: [], ready: true, raster: { host: null, sources: {} }, segments: ['(tabs)', 'food'] });
    expect(mockSetParams).not.toHaveBeenCalled();
  });

  it('leaves the tab alone when the navigation that created it named one', async () => {
    await declare({
      modules: [],
      ready: true,
      raster: { host: null, sources: {} },
      segments: ['sign-in'],
      params: { screen: 'food', params: {} },
    });
    expect(mockSetParams).not.toHaveBeenCalled();
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
