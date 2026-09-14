import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { backGoesHome, HOME_TAB, nestedStateOf, TABS, tabWasChosen, type NavStateNode } from '../tabs';

/**
 * The bottom bar's membership and order — N176, as revised by N180.
 *
 * The bar reads **Today · Food · Progress · Plan · You**, and every one of the
 * five is unconditional. Two properties are worth a test rather than a comment:
 *
 * 1. **The order is frequency, highest first among the destinations.** N176
 *    ordered it as a loop — plan, train, understand, progress, plan — and put
 *    Train in slot two; the user carried that bar and reversed it, because food
 *    is logged three to five times a day against four to six sessions a WEEK.
 *    Food is back in slot two and Train's slot is retired. Either way a
 *    reordering is a product decision, so it fails here rather than being
 *    noticed on a device.
 * 2. **Every route file in `app/(tabs)/` is one of the five.** N504 moved
 *    `train` and `goals` out of this folder entirely (a `NativeTabs` tab with
 *    no button cannot be navigated to, so the old off-bar mechanism has no
 *    equivalent — see this file's own top-of-file comment on `lib/tabs.ts`).
 *    So the invariant this test now pins is simpler than it used to be: the
 *    tab folder holds EXACTLY the five files `TABS` names, nothing else. A
 *    stray file here is a tab nobody decided about — `NativeTabs` only shows
 *    what a `<NativeTabs.Trigger>` declares, so an undeclared file would not
 *    silently become a sixth tab the way it did under the old `<Tabs>`
 *    navigator; it would instead be dead code sitting in the tab folder for
 *    no reason. Both are worth catching, which is why this stayed a test
 *    rather than being deleted along with `OFF_BAR_ROUTES`.
 *
 * The behavioural half — that the layout actually hands `NativeTabs` this
 * arrangement, with icons and accent tinting — is in
 * `app/__tests__/tabLayout.test.tsx`. This file pins the decision; that one
 * pins the wiring.
 */

const TABS_DIR = join(__dirname, '..', '..', 'app', '(tabs)');

/** Every route file expo-router will turn into a screen in the tab folder. */
function routeFilesInTabFolder(): string[] {
  return readdirSync(TABS_DIR)
    .filter((f) => /\.tsx?$/.test(f) && !f.startsWith('_') && !f.startsWith('+'))
    .map((f) => f.replace(/\.tsx?$/, ''));
}

describe('the visible bar', () => {
  it('reads Food, Progress, Today, Plan, You, in that order', () => {
    expect(TABS.map((t) => t.title)).toEqual(['Food', 'Progress', 'Today', 'Plan', 'You']);
  });

  it('maps those titles onto the routes that actually implement them', () => {
    // Titles alone would pass with every tab pointing at the same file. Plan is
    // the interesting row: it is the long-standing `workouts` route under its
    // product name, and renaming the file is not part of this change.
    expect(TABS.map((t) => t.name)).toEqual(['food', 'progress', 'index', 'workouts', 'you']);
  });

  // **The centre slot specifically, because that is the whole of N580's bar
  // change** (owner, 2026-09-14). The two assertions above are satisfied by any
  // bar holding those five names in that order; this one states the property
  // the owner asked for — Today in the MIDDLE — so it still fails if the bar
  // ever grows or shrinks around a Today that stays at index 2.
  it('puts Today in the centre slot', () => {
    expect(TABS.length % 2).toBe(1);
    expect(TABS[(TABS.length - 1) / 2]).toEqual({ name: 'index', title: 'Today', icon: 'dashboard' });
  });

  // N180's half, kept: Food has a permanent slot, because it is logged several
  // times a day and the bar is the phone's only fixed-position affordance.
  // N580 moved Today into the centre, which put Food first and two slots from
  // Today. It did not take Food off the bar.
  it('keeps Food on the bar', () => {
    expect(TABS.map((t) => t.name)).toContain('food');
  });

  it('gives every tab an icon, and no two the same', () => {
    const icons = TABS.map((t) => t.icon);
    expect(icons.every((i) => typeof i === 'string' && i.length > 0)).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });

  // **The regression this whole ticket had to avoid, stated as a property.**
  // Food and Goals used to vanish from the bar whenever nutrition was turned
  // off — 40% of the primary navigation, erased with nothing saying why, and
  // the user reported the BJJ equivalent from a real device as the feature
  // being "not there". Nothing in `TABS` may carry a condition, so there is
  // nothing here for a module set to switch off.
  it('holds exactly five, with nothing conditional in the list', () => {
    expect(TABS).toHaveLength(5);
    expect(Object.keys(TABS[0]).sort()).toEqual(['icon', 'name', 'title']);
  });
});

describe('the tab the app opens on (N580)', () => {
  // Named, and not the first slot: if these two ever agree again, the default
  // is being carried by position and nothing would notice it moving.
  it('is Today, which is no longer first on the bar', () => {
    expect(HOME_TAB).toBe('index');
    expect(TABS.find((t) => t.name === HOME_TAB)?.title).toBe('Today');
    expect(TABS[0].name).not.toBe(HOME_TAB);
  });

  describe('tabWasChosen', () => {
    it('is true inside the tab group, whichever tab the URL named', () => {
      expect(tabWasChosen(['(tabs)'], undefined)).toBe(true);
      expect(tabWasChosen(['(tabs)', 'food'], undefined)).toBe(true);
    });

    it('is true when the navigation named a tab or carried nested state', () => {
      expect(tabWasChosen(['sign-in'], { screen: 'index', params: {} })).toBe(true);
      expect(tabWasChosen(['sign-in'], { state: { routes: [{ name: 'food' }] } })).toBe(true);
    });

    // The anchor under a pushed screen: the only case the layout acts on.
    it('is false under a pushed screen with nothing naming a tab', () => {
      expect(tabWasChosen(['goals'], undefined)).toBe(false);
      expect(tabWasChosen(['goals'], {})).toBe(false);
      expect(tabWasChosen([], null)).toBe(false);
      expect(tabWasChosen(['goals'], { screen: 42 })).toBe(false);
    });
  });
});

// The decision behind Android's back button (F68). The real-router half, with
// the handler and the router's own back handling, is in
// `__tests__/app/tabDefault.test.tsx`.
describe('backGoesHome (F68)', () => {
  /** The tab navigator's state with `name` focused, and optionally a nested state in it. */
  function tabsOn(name: string, nested?: NavStateNode): NavStateNode {
    return {
      index: TABS.findIndex((t) => t.name === name),
      routes: TABS.map((t) => (t.name === name && nested ? { name: t.name, state: nested } : { name: t.name })),
    };
  }

  it('sends every tab but Today home, when the tab bar is what is showing', () => {
    const home = TABS.filter((t) => backGoesHome(true, tabsOn(t.name))).map((t) => t.name);
    expect(home).toEqual(['food', 'progress', 'workouts', 'you']);
  });

  // The owner's call: back on Today keeps the platform default.
  it('leaves Today to the platform, which leaves the app', () => {
    expect(backGoesHome(true, tabsOn(HOME_TAB))).toBe(false);
  });

  it('leaves a screen pushed over the tabs to be popped first', () => {
    expect(backGoesHome(false, tabsOn('progress'))).toBe(false);
  });

  it('leaves a nested navigator in the tab to pop its own screen first', () => {
    const stack = (index?: number): NavStateNode => ({ index, routes: [{ name: 'a' }, { name: 'b' }] });
    expect(backGoesHome(true, tabsOn('progress', stack(1)))).toBe(false);
    expect(backGoesHome(true, tabsOn('progress', stack(0)))).toBe(true);
    expect(backGoesHome(true, tabsOn('progress', stack(undefined)))).toBe(true);
  });

  it('does nothing when no route is focused', () => {
    expect(backGoesHome(true, { index: 7, routes: [] })).toBe(false);
  });
});

describe('nestedStateOf (F68)', () => {
  // The shape `getRootState()` returns for the real app: the root navigator,
  // the root stack under it, `(tabs)` in the stack with a screen pushed over it.
  const tabs: NavStateNode = { key: 'tab-1', index: 1, routes: [{ key: 'food-1', name: 'food' }, { key: 'progress-1', name: 'progress' }] };
  const root: NavStateNode = {
    key: 'root-0',
    index: 0,
    routes: [
      {
        key: '__root-0',
        name: '__root',
        state: {
          key: 'stack-0',
          index: 1,
          routes: [
            { key: 'tabs-0', name: '(tabs)', state: tabs },
            { key: 'goals-0', name: 'goals' },
          ],
        },
      },
    ],
  };

  it('finds the state held by a route at any depth', () => {
    expect(nestedStateOf(root, 'tabs-0')).toBe(tabs);
  });

  it('is undefined for a key nowhere in the tree, a route with no state, or no tree', () => {
    expect(nestedStateOf(root, 'tabs-1')).toBeUndefined();
    expect(nestedStateOf(root, 'goals-0')).toBeUndefined();
    expect(nestedStateOf(undefined, 'tabs-0')).toBeUndefined();
  });
});

describe('the tab folder holds exactly the five tabs, and nothing else', () => {
  it('finds the folder at all', () => {
    // Guards the guard: a bad path would make the assertion below compare two
    // empty-ish sets and report that everything is accounted for.
    const files = routeFilesInTabFolder();
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toContain('index');
  });

  // **N504's replacement for the old "tab or deliberately off-bar" check.**
  // `train` and `goals` left this folder for the app root, so there is no
  // third category left to name — a file here that isn't one of the five is
  // simply undeclared, and `NativeTabs` would never show it as a tab (unlike
  // the old `<Tabs>` navigator, which auto-injected every route file whether
  // declared or not). Still worth failing on: an undeclared file sitting in
  // this folder is either a mistake or a tab nobody decided to add, and
  // `NativeTabs.Trigger` requires every tab to be declared explicitly rather
  // than tolerating one.
  it('is exactly the five names TABS declares', () => {
    expect([...routeFilesInTabFolder()].sort()).toEqual([...TABS.map((t) => t.name)].sort());
  });
});
