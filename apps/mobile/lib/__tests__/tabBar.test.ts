import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { OFF_BAR_ROUTES, TABS, declaredTabRoutes, offBar } from '../tabs';

/**
 * The bottom bar's membership and order — N176.
 *
 * The bar reads **Today · Train · Progress · Plan · You**, and every one of the
 * five is unconditional. Two properties are worth a test rather than a comment:
 *
 * 1. **The order is the product loop** — plan, train, understand, progress,
 *    plan — read left to right. A reordering is a product decision, so it fails
 *    here rather than being noticed on a device.
 * 2. **Every route file in `app/(tabs)/` is accounted for exactly once.**
 *    expo-router auto-injects every route file in that folder whether the
 *    layout declares it or not, so a new file that nobody put in one of the two
 *    lists comes back as a SIXTH TAB titled after its filename. That is a bug
 *    that ships silently — it needs a device to see and nothing else in the
 *    pipeline looks at that directory.
 *
 * The behavioural half — that the layout actually renders these, that Food and
 * Goals get `href: null` rather than disappearing, and that the bar does not
 * vary with the module set — is in `app/__tests__/tabLayout.test.tsx`. This
 * file pins the decision; that one pins the wiring.
 */

const TABS_DIR = join(__dirname, '..', '..', 'app', '(tabs)');

/** Every route file expo-router will turn into a screen in the tab folder. */
function routeFilesInTabFolder(): string[] {
  return readdirSync(TABS_DIR)
    .filter((f) => /\.tsx?$/.test(f) && !f.startsWith('_') && !f.startsWith('+'))
    .map((f) => f.replace(/\.tsx?$/, ''));
}

describe('the visible bar', () => {
  it('reads Today, Train, Progress, Plan, You, in that order', () => {
    expect(TABS.map((t) => t.title)).toEqual(['Today', 'Train', 'Progress', 'Plan', 'You']);
  });

  it('maps those titles onto the routes that actually implement them', () => {
    // Titles alone would pass with every tab pointing at the same file. Plan is
    // the interesting row: it is the long-standing `workouts` route under its
    // product name, and renaming the file is not part of this change.
    expect(TABS.map((t) => t.name)).toEqual(['index', 'train', 'progress', 'workouts', 'you']);
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

describe('the routes with no bar position', () => {
  it('is Food and Goals, which lost a button and not a route', () => {
    expect([...OFF_BAR_ROUTES].sort()).toEqual(['food', 'goals']);
  });

  it('never overlaps the bar', () => {
    // A name in both lists is a bar entry the layout would then null out —
    // the tab renders, and pressing it does nothing anyone can see.
    expect(TABS.filter((t) => offBar(t.name))).toEqual([]);
  });

  it('does not answer yes to a tab that has a button', () => {
    // Guards against `offBar` degenerating into a constant. Without this a
    // mutation returning `true` unconditionally passes the overlap test above
    // only by making it vacuous — and would strip the whole bar.
    expect(offBar('index')).toBe(false);
    expect(offBar('train')).toBe(false);
    expect(offBar('food')).toBe(true);
  });
});

describe('every route in the tab folder', () => {
  it('finds the folder at all', () => {
    // Guards the guard: a bad path would make the assertion below compare two
    // empty-ish sets and report that everything is accounted for.
    const files = routeFilesInTabFolder();
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files).toContain('index');
    expect(files).toContain('train');
  });

  // **The one that catches a file nobody decided about.** expo-router injects
  // every route file here whether it is declared or not, so an undeclared one
  // arrives as an extra tab with a filename-derived title on a real device and
  // nowhere else. Set comparison in both directions: an extra file is an
  // unplanned tab, and a name in the lists with no file behind it is a tab
  // pointing at nothing.
  it('is either a tab or deliberately off the bar, and never neither', () => {
    expect([...routeFilesInTabFolder()].sort()).toEqual([...declaredTabRoutes()].sort());
  });
});
