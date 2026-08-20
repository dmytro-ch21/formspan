import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Every screen with a text input must use the shared keyboard containers.
 *
 * **This is the part that makes the fix stick.** `KeyboardAwareScroll.tsx` was
 * already correct and already exported before this test existed; it was adopted
 * by one screen out of thirteen, and the other twelve each reinvented some
 * fraction of it — or nothing at all. Centralising knowledge does not
 * centralise behaviour while using it stays opt-in and nothing notices when a
 * new screen doesn't. The gap took months to be reported and was reported as a
 * bug in a screen, not as a missing import.
 *
 * So the rule is enforced rather than documented: add a `TextInput` to a screen
 * that scrolls with a bare `ScrollView`/`FlatList` and this goes red, naming
 * the file.
 *
 * **What it proves, precisely.** That the file imports the module — not that
 * the container actually wraps the input. That limit is real and worth stating
 * rather than implying more (the same caution `CLAUDE.md` records about regex
 * assertions standing in for behaviour). It is still the check that catches the
 * failure that actually happened, which is a screen written without the wrapper
 * at all; a render-level assertion would have to be written per screen and so
 * could never cover the screen nobody thought about. `inputErgonomics.test.ts`
 * covers the arithmetic; this covers the reach.
 */

const MOBILE_ROOT = resolve(__dirname, '../..');
const SEARCH_DIRS = ['app', 'components'];

/**
 * The module every scrolling screen with an input has to go through.
 *
 * Matched as an IMPORT, not as a substring of the file. A plain
 * `includes('KeyboardAwareScroll')` is satisfied by a passing mention in a
 * comment — and that is not hypothetical: before this branch,
 * `PromotionForm.tsx` carried the words "see the extensive note in
 * KeyboardAwareScrollView.tsx" while using a bare `ScrollView`, so it would
 * have satisfied the loose check while being exactly what the check exists to
 * catch.
 */
const IMPORTS_MODULE = /from ['"]@\/components\/KeyboardAwareScroll['"]/;

/**
 * Escape hatch for a component that renders an input but is ALWAYS mounted
 * inside a parent that already provides a container — a row inside a list, say.
 * Deliberately a visible marker rather than a list kept in this file: the
 * justification belongs next to the code, and an exemption nobody can see is
 * how a rule quietly stops applying.
 */
const OPT_OUT = 'keyboard-container: provided by parent';

/**
 * What counts as "this file takes typing".
 *
 * A list rather than one literal because a wrapper around `TextInput` is
 * invisible to a substring search for the thing it wraps. Add the tag whenever
 * a new input wrapper appears, or its call sites silently leave the scan.
 */
const INPUT_TAGS = ['<TextInput', '<SelectAllTextInput'];

function tsxFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(full);
      } else if (entry.endsWith('.tsx')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

const screensWithInputs = SEARCH_DIRS.flatMap((d) => tsxFilesUnder(join(MOBILE_ROOT, d)))
  .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
  // `<TextInput` rather than `TextInput`, so a file that merely mentions the
  // name in a comment or a type import is not dragged in. `SwipeToDelete.tsx`
  // is exactly that case and would otherwise be a permanent false positive.
  //
  // `<SelectAllTextInput` counts as an input too, and leaving it out would have
  // been a real hole: a screen using only the wrapper contains no `<TextInput`
  // at all, so it would escape this scan entirely while taking typing exactly
  // like the thirteen that do not. The wrapper carries `OPT_OUT` for ITSELF —
  // that is a claim about a leaf component with no scroll container, not a
  // licence for the screens that render it.
  .filter(({ source }) => INPUT_TAGS.some((tag) => source.includes(tag)))
  .map(({ path, source }) => ({ file: relative(MOBILE_ROOT, path), source }));

describe('keyboard handling reaches every screen that takes typing', () => {
  /**
   * Guards the guard. A walker pointed at the wrong directory, or a filter that
   * stops matching after a refactor, yields an empty list — and every
   * `forEach` assertion below then passes by running zero times. This suite
   * exists because two tests in this app once passed for exactly that kind of
   * wrong reason.
   */
  it('actually found the screens', () => {
    expect(screensWithInputs.length).toBeGreaterThanOrEqual(13);
    const files = screensWithInputs.map((s) => s.file);
    // Named anchors, so "found 13 files" cannot be satisfied by 13 of the
    // wrong ones. These two are the screens the keyboard bug was reported on.
    expect(files).toContain('app/library.tsx');
    expect(files).toContain('app/bjj/reflect/[id].tsx');
  });

  it.each(screensWithInputs.map((s) => [s.file, s.source] as const))(
    '%s goes through the shared keyboard container',
    (file, source) => {
      if (source.includes(OPT_OUT)) return;
      expect({ file, importsModule: IMPORTS_MODULE.test(source) }).toEqual({
        file,
        importsModule: true,
      });
    },
  );

  /**
   * The other half: importing the module and then ALSO scrolling with a bare
   * vertical container means the input can still sit in the unhandled one.
   *
   * Horizontal rows are exempt because a keyboard never traps content on the
   * x-axis — the library's filter chips and the reflection wizard's category
   * strip are both legitimately plain `ScrollView`s.
   *
   * The two narrow spellings are deliberate, because both were holes:
   * `horizontal={false}` is an explicitly VERTICAL list and a plain
   * `includes('horizontal')` would have exempted it, and the tag list covers
   * the wrapped and aliased forms rather than only the two literal names — a
   * `SectionList` or an `Animated.ScrollView` is just as capable of trapping
   * content under a keyboard.
   */
  it.each(screensWithInputs.map((s) => [s.file, s.source] as const))(
    '%s has no bare vertical scroller left behind',
    (file, source) => {
      if (source.includes(OPT_OUT)) return;
      const SCROLLERS =
        /<(?:Animated\.)?(ScrollView|FlatList|SectionList|VirtualizedList|FlashList)\b([^>]*)>/g;
      // `horizontal`, but not `horizontal={false}`.
      const isHorizontal = /\bhorizontal\b(?!\s*=\s*\{\s*false\s*\})/;
      const bare = [...source.matchAll(SCROLLERS)].filter(
        ([, , attrs]) => !isHorizontal.test(attrs),
      );
      expect({ file, bare: bare.map(([, tag]) => tag) }).toEqual({ file, bare: [] });
    },
  );
});
