import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import type { Module } from '@/lib/modules';

import TabLayout from '../(tabs)/_layout';

/**
 * The tab bar as the navigator actually receives it — N176.
 *
 * `lib/__tests__/tabBar.test.ts` pins WHICH five tabs and in what order. This
 * file pins that the layout hands the navigator that arrangement, and three
 * properties that only exist in the render:
 *
 * - **The frame-hold.** `<Tabs>` mounts its initial route immediately, and
 *   `(tabs)/index.tsx` reads `useModules()` without reading `ready`, so
 *   `foodEnabled` is `hasFoodLog([])` — false. Without the hold, Today renders
 *   the dashed "Nutrition is turned off" placeholder for the first frames of
 *   every cold start on an account where nutrition is ON.
 * - **Train and Goals are still routes.** `href: null`, not omission: omitting a
 *   `<Tabs.Screen>` does not hide it, expo-router injects it anyway, so the two
 *   would come back as extra tabs titled "train" and "goals".
 * - **One accessible button for all five.** `tabBarButton` is installed once on
 *   `screenOptions`, so the two tabs N176 added cannot announce themselves
 *   differently from their three neighbours.
 *
 * ## Why it mocks the navigator rather than rendering it
 *
 * `<Tabs>` is a real navigator that wants a navigation container, a route tree
 * and a screen for every name it is given. What is under test here is the
 * CONFIGURATION — the list of screens and the options on each — so the mock
 * records exactly that and nothing else. A real navigator would additionally
 * require every one of the seven route files to render under jest, which is a
 * far larger surface for a test about a list.
 */

type Declared = { name: string; options: Record<string, unknown> };

const mockDeclared: Declared[] = [];
const mockScreenOptions: { current: Record<string, unknown> | null } = { current: null };
const mockModuleState: { modules: Module[]; ready: boolean } = { modules: [], ready: true };

/*
 * Named function declarations, and no `require('react')`.
 *
 * `Tabs` returns its children directly rather than wrapping them in a
 * `Fragment`, which is legal for a component and removes the only reason this
 * factory would need React at all — jest hoists `jest.mock` above the imports,
 * so a factory cannot close over one and has to `require` it, which this app's
 * lint rules forbid. Named rather than arrows so `react/display-name` is
 * satisfied by the components themselves instead of by an exception.
 */
jest.mock('expo-router', () => {
  function Tabs({ children, screenOptions }: any) {
    mockScreenOptions.current = screenOptions;
    return children;
  }
  Tabs.Screen = function TabsScreen({ name, options }: any) {
    mockDeclared.push({ name, options: options ?? {} });
    return null;
  };
  return { Tabs };
});

jest.mock('@/lib/ModulesProvider', () => ({ useModules: () => mockModuleState }));
jest.mock('@/lib/AccentProvider', () => ({
  useAccent: () => ({ accent: '#B8FF2C', ink: '#B8FF2C', on: '#0B0F16' }),
}));

/** A module set with a food log turned ON — the fullest state the bar ever sees. */
function fullModules(): Module[] {
  const caps = {
    catalog: '',
    facets: [] as string[],
    has_goals: false,
    has_progression: false,
    has_food_log: false,
    record_kinds: [] as string[],
  };
  return [
    {
      key: 'strength',
      label: 'Strength',
      is_sport: true,
      default_on: true,
      enabled: true,
      capabilities: { ...caps, catalog: 'exercises' },
    },
    {
      key: 'nutrition',
      label: 'Nutrition',
      is_sport: false,
      default_on: true,
      enabled: true,
      capabilities: { ...caps, has_food_log: true },
    },
  ] as Module[];
}

/** Render once and return what the navigator was told. */
function declare(state: { modules: Module[]; ready: boolean }): Declared[] {
  mockDeclared.length = 0;
  mockScreenOptions.current = null;
  mockModuleState.modules = state.modules;
  mockModuleState.ready = state.ready;
  render(<TabLayout />);
  return mockDeclared;
}

/** The tabs the athlete can actually press, in bar order. */
function visible(declared: Declared[]): Declared[] {
  return declared.filter((d) => d.options.href !== null);
}

beforeEach(() => {
  mockDeclared.length = 0;
  mockScreenOptions.current = null;
});

describe('the bar the navigator is given', () => {
  it('shows Today, Food, Progress, Plan, You, in that order', () => {
    const bar = visible(declare({ modules: fullModules(), ready: true }));
    expect(bar.map((d) => d.options.title)).toEqual([
      'Today',
      'Food',
      'Progress',
      'Plan',
      'You',
    ]);
    expect(bar.map((d) => d.name)).toEqual(['index', 'food', 'progress', 'workouts', 'you']);
  });

  it('gives each of the five an icon to draw', () => {
    const bar = visible(declare({ modules: fullModules(), ready: true }));
    expect(bar.every((d) => typeof d.options.tabBarIcon === 'function')).toBe(true);
  });

  // **Train and Goals lost a button, not a route.** `href: null` keeps the route
  // resolvable, which is what an in-flight `router.push`, a back-stack entry
  // and a `vola://train` deep link all need. Omitting the `<Tabs.Screen>`
  // entirely does the opposite of hiding it: expo-router injects the file
  // anyway, and it returns as a sixth tab titled "train".
  //
  // N180 swapped which two these are. `train.tsx` is NOT deleted — #587 moves
  // its sections into Plan — so it has to keep being declared here.
  it('keeps Train and Goals reachable with no button in the bar', () => {
    const declared = declare({ modules: fullModules(), ready: true });
    const names = declared.map((d) => d.name);
    expect(names).toContain('train');
    expect(names).toContain('goals');
    for (const name of ['train', 'goals']) {
      expect(declared.find((d) => d.name === name)!.options.href).toBeNull();
    }
  });

  // The mirror of the line above, and the one that fails if `href: null` is
  // softened to `undefined` — which reads as "no override" and puts both tabs
  // straight back in the bar.
  it('leaves exactly five pressable tabs', () => {
    expect(visible(declare({ modules: fullModules(), ready: true }))).toHaveLength(5);
  });
});

/**
 * The property that replaced the food-log gate.
 *
 * The bar used to vary with the module set, which is why the layout holds a
 * frame: an unread list is empty, an empty list has no food-log capability, so
 * the first frames hid Food and Goals and the bar visibly rearranged on every
 * cold start. N176 made all five slots unconditional, so that can no longer
 * happen — and this is what says so.
 *
 * It is also the tripwire for the next ticket in this epic. If one of them
 * makes a tab conditional on the module set again, this goes red, and the
 * frame-hold's bar-shaped half has to be argued back rather than assumed.
 */
describe('the bar does not depend on the module set', () => {
  it('is identical for an unread list and a full one', () => {
    const unread = visible(declare({ modules: [], ready: true })).map((d) => ({
      name: d.name,
      title: d.options.title,
      href: d.options.href,
    }));
    const full = visible(declare({ modules: fullModules(), ready: true })).map((d) => ({
      name: d.name,
      title: d.options.title,
      href: d.options.href,
    }));
    expect(unread).toEqual(full);
    expect(unread).toHaveLength(5);
  });

  it('is identical with every module turned off', () => {
    // The vector that distinguishes a real answer from a broken one: a set
    // where the modules EXIST and are all disabled is the state the old gate
    // got wrong in the other direction, and a naive `enabled` check would
    // reappear here rather than in the empty-list case above.
    const off = fullModules().map((m) => ({ ...m, enabled: false }));
    expect(visible(declare({ modules: off, ready: true })).map((d) => d.name)).toEqual([
      'index',
      'food',
      'progress',
      'workouts',
      'you',
    ]);
  });
});

/**
 * The frame-hold, which is load-bearing for the SCREENS rather than for the bar.
 *
 * Deleting `if (!ready) return null` mounts the whole tab subtree against an
 * empty module list. `(tabs)/index.tsx` reads `useModules()` and never reads
 * `ready`, so Today asserts "Nutrition is turned off" in words for the first
 * frames of every cold start — the N61 lie flashing rather than sticking, and
 * `lib/modules.ts`'s `foodLogGate` docstring records the same failure one level
 * further down.
 */
describe('before the module set has been read', () => {
  it('declares nothing at all', () => {
    expect(declare({ modules: [], ready: false })).toEqual([]);
  });

  it('declares the full bar as soon as it has', () => {
    // Without this the test above is satisfied by a layout that renders
    // nothing ever, which is a very quiet way to lose the tab bar.
    expect(declare({ modules: [], ready: true })).not.toEqual([]);
  });
});

/**
 * One button, five tabs.
 *
 * `tabBarButton` is installed on `screenOptions`, never per screen, so the two
 * tabs N176 added get the same role, label and selected state as the three that
 * were already there. A per-screen override is how one tab ends up announcing
 * itself differently from its neighbours, so its absence is asserted.
 */
describe('the tab button', () => {
  function renderButton(props: Record<string, unknown>) {
    declare({ modules: fullModules(), ready: true });
    const make = mockScreenOptions.current!.tabBarButton as (p: unknown) => React.ReactElement;
    return render(make({ children: <Text>Progress</Text>, ...props }));
  }

  it('is the same one for every tab', () => {
    const declared = declare({ modules: fullModules(), ready: true });
    expect(typeof mockScreenOptions.current!.tabBarButton).toBe('function');
    expect(declared.every((d) => d.options.tabBarButton === undefined)).toBe(true);
  });

  it('passes the navigator’s role, label and selected state straight through', () => {
    renderButton({
      accessibilityRole: 'tab',
      accessibilityLabel: 'Progress, tab, 3 of 5',
      accessibilityState: { selected: true },
      'aria-selected': true,
    });
    const button = screen.getByLabelText('Progress, tab, 3 of 5');
    expect(button.props.accessibilityRole).toBe('tab');
    expect(button.props.accessibilityState).toEqual({ selected: true });
  });

  it('does the same for an unselected tab', () => {
    // Both states, because a button that hard-codes `selected: true` announces
    // every tab as the current one and passes a single-vector test.
    renderButton({
      accessibilityRole: 'tab',
      accessibilityLabel: 'Food, tab, 2 of 5',
      accessibilityState: { selected: false },
      'aria-selected': false,
    });
    expect(screen.getByLabelText('Food, tab, 2 of 5').props.accessibilityState).toEqual({
      selected: false,
    });
  });

  // **The underline reads `focused` off the navigator's own props**, and the
  // bug this replaced was that it read only `accessibilityState`: React
  // Navigation 7 sets the ARIA form, so the rule rendered on every tab in
  // `transparent`, which looks exactly like no underline at all. Both spellings
  // and both answers, because a mutation hard-coding `focused` to either
  // constant survives a single-vector test — one marks every tab, the other
  // marks none, and both are invisible in a green suite.
  it('marks the selected tab, on either spelling of selected', () => {
    for (const props of [
      { 'aria-selected': true },
      { accessibilityState: { selected: true } },
    ]) {
      const { toJSON } = renderButton({ accessibilityLabel: 'Progress', ...props });
      expect(JSON.stringify(toJSON())).toContain('#B8FF2C');
    }
  });

  it('leaves the unselected tabs unmarked', () => {
    const { toJSON } = renderButton({
      accessibilityLabel: 'Food',
      'aria-selected': false,
      accessibilityState: { selected: false },
    });
    expect(JSON.stringify(toJSON())).not.toContain('#B8FF2C');
  });

  it('hides the underline from assistive technology', () => {
    // It repeats what `selected` already conveys. Announced, every tab reads
    // out a nameless view after its label.
    const { toJSON } = renderButton({
      accessibilityRole: 'tab',
      accessibilityLabel: 'Progress',
      accessibilityState: { selected: true },
      'aria-selected': true,
    });
    const tree = JSON.stringify(toJSON());
    expect(tree).toContain('"accessibilityElementsHidden":true');
    expect(tree).toContain('"importantForAccessibility":"no-hide-descendants"');
  });
});
