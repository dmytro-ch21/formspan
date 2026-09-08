import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { TABS } from '../tabs';

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
  it('reads Today, Food, Progress, Plan, You, in that order', () => {
    expect(TABS.map((t) => t.title)).toEqual(['Today', 'Food', 'Progress', 'Plan', 'You']);
  });

  it('maps those titles onto the routes that actually implement them', () => {
    // Titles alone would pass with every tab pointing at the same file. Plan is
    // the interesting row: it is the long-standing `workouts` route under its
    // product name, and renaming the file is not part of this change.
    expect(TABS.map((t) => t.name)).toEqual(['index', 'food', 'progress', 'workouts', 'you']);
  });

  // **Slot two specifically, because that is the whole of N180's bar change.**
  // The two assertions above are satisfied by any bar holding those five names;
  // this one fails if Food drifts to the end, which is the shape the next
  // reorder is most likely to take — appending is always the smaller diff.
  it('puts Food in slot two, beside Today', () => {
    expect(TABS[1]).toEqual({ name: 'food', title: 'Food', icon: 'food' });
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
