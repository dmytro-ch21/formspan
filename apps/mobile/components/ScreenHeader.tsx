import { Image } from 'expo-image';
import { useCallback, useState } from 'react';
import { StyleSheet, View as RNView, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SyncChip } from '@/components/SyncChip';
import { View } from '@/components/Themed';
import { vola } from '@/constants/Colors';

/**
 * The top of every tab screen: the wordmark, then the screen's name.
 *
 * **The wordmark is the drawn artwork, not typed letters.** This used to be
 * the brand tick followed by "VOLA" set in the system font at weight 800 with
 * 3pt of tracking — an impersonation of the logo built from the only parts a
 * text node can offer. The real letterforms are a different shape entirely
 * (the A is an apex with no crossbar, the O is a rounded rectangle), so the
 * typed version was not a smaller version of the logo, it was a different
 * logo. It is now `vola-wordmark.png`, lifted from the stacked lockup — which
 * also means the header no longer needs the tick beside it to say what the
 * letters are. The tick still appears where it earns its place: the app icon,
 * and the landing beat of `AnimatedSplash`. It just isn't furniture on every
 * screen any more.
 *
 * Replaces React Navigation's default header, which drew its own surface
 * colour and a hairline rule — two bands of subtly different dark, stacked
 * against a third at the bottom. On a dark theme those seams are the most
 * visible thing on screen, and they were dividing a layout that has no
 * actual sections. Everything now sits on one continuous ground.
 *
 * The wordmark shares a row with the screen name rather than sitting above
 * it at island level. The first attempt put it level with the island and the
 * island simply covered it — it is opaque hardware, not a layer an app can
 * draw into. (Drawing *in* the island proper means a Live Activity via
 * ActivityKit: native code and a custom dev client, neither of which exists
 * here.) One row is also less furniture than two, which is the point.
 *
 * The screen name is small and left-aligned because it's orientation, not a
 * headline — you already know where you are, you just want confirming.
 *
 * It also carries the sync chip, which is why sync state reaches every tab
 * without each screen having to opt in — and why a screen added later gets it
 * for free rather than being the one place that quietly doesn't report.
 *
 * ## The wordmark yields rather than being overlapped
 *
 * This header publishes an `action` slot **with no width contract** while
 * drawing an 88pt image across the middle of the same row, and for a while
 * that was simply a collision waiting for a caller. It got two:
 *
 *   - `you.tsx` passes three text controls (~173pt at 14pt/700). On a 393pt
 *     device the row is 353pt and the wordmark spans ~132.5→220.5 while the
 *     cluster starts at ~180; on a 375pt device "Friends" lands on the
 *     wordmark's tail. `pointerEvents="none"` means taps still worked, so it
 *     read as a smudge rather than a broken control.
 *   - `justifyContent: 'space-between'` with a VARIABLE number of flow
 *     children. Two children (the other three tabs) puts the chip hard right;
 *     three children put it in the row's INTERIOR — the wordmark's band. The
 *     chip is silent when idle, so this half came and went with sync state,
 *     which is why the bug looked intermittent and nobody traced it to layout.
 *
 * The notifications PR then widened the cluster again (`Friends (3)`) without
 * anyone re-checking the geometry, and did it ASYNCHRONOUSLY — the count
 * arrives after paint. That is the proof the contract cannot be kept by
 * callers, so it is kept here.
 *
 * **Two flow children, always.** The chip and the action are one group, so
 * `space-between` can only ever put something at the two ends. This is also
 * what makes the arithmetic below true: only with two children does
 * `space-between` guarantee `rightStart === row − right`.
 *
 * **The wordmark hides when measurement says it cannot fit**, rather than
 * shrinking or being truncated. It keeps its absolute centring, which is the
 * guarantee the original comment was written for — the title's width must not
 * push it off-centre. A flow slot would give that up, and RN's `flexShrink`
 * defaults to 0, so an over-full row would not shrink the image; it would
 * wrap the labels. "Setti/ngs" on two lines is worse than the overlap.
 *
 * **Absolute positioning is what makes hiding safe.** Out of flow, mounting
 * and unmounting the wordmark changes no measured frame, so hiding it cannot
 * re-fire `onLayout` and cannot oscillate. A future refactor to a flow slot
 * would break that silently.
 *
 * **It MEASURES rather than computing, and that is deliberate.** See
 * `fabClearance` in `app/(tabs)/workouts.tsx`, which documents the trap:
 * `PixelRatio.getFontScale()` is a `Dimensions` snapshot, a module-scope const
 * freezes it at bundle load, and iOS does not restart the JS bundle when you
 * change text size and come back. A measured width already EMBODIES the font
 * scale — a `Text` at Accessibility Large simply lays out wider and
 * `onLayout` reports it — so there is no factor here to go stale. The obvious
 * future edit (`if (fontScale > 1.3) hide`) would inherit that trap and
 * re-encode today's labels; do not.
 *
 * ## The edge belongs to whatever the content actually scrolls under (W10)
 *
 * Eight screens mount this header, and the question that decides whether it
 * draws a bottom rule is **not** "is the header fixed?" — it is **"is this
 * header's bottom edge the top of the scrolling region?"** Three arrangements
 * exist and only the first says yes:
 *
 *  - **The header IS the boundary** — a sibling directly above the scroller, so
 *    content passes under the header itself. `goals`, `phase`, `progress`
 *    (added by N176/#602, after this note was first written — corrected by
 *    F20/#496's review rather than left to drift again). These draw it.
 *    `phase` sits outside `(tabs)`, so unlike `goals`/`progress` it has no tab
 *    bar beneath it to match; the rule still marks a real boundary there.
 *  - **The header scrolls away** — rendered INSIDE the scroll view as its first
 *    child, so nothing ever passes under it. `index` (Today), `food`, `you`.
 *  - **The header sits above OTHER fixed chrome, which owns the boundary** —
 *    `workouts` has a scope tab strip between the header and its list, and that
 *    strip already draws `borderBottomWidth: hairlineWidth` in `vola.line`
 *    (1.38:1 against `bg` — the same shortfall F20 fixed here, left open on
 *    that strip; see F20's history entry); `library` has a search field and
 *    filter chips. In both, content scrolls under the chrome, not under the
 *    header.
 *
 * **An earlier version of this note got that wrong**, and it is worth leaving
 * the correction visible rather than quietly fixing it: it said four screens
 * pin the header and therefore four have content passing underneath. The first
 * half was true and the second did not follow, so the rule would have put a
 * SECOND hairline about 40pt above `workouts`'s existing one — the stacked
 * seams this component's own history records eliminating — while on `library`
 * it would have marked the header/search boundary, where nothing scrolls, and
 * left the real clip edge below the chips exactly as bg-on-bg as before. Caught
 * in review, not by any test. See the note in `docs/decisions/history.md`.
 *
 * ## What the bug was
 *
 * `View` from `Themed` deliberately paints no background, so this header is
 * transparent and the screen's own `vola.bg` shows through on both sides of the
 * scroll view's top edge. The scroll view clips at its own frame. So content is
 * **cut mid-glyph against an identical colour** — no line, no shadow, no change
 * of tone at the place where it stops being drawn.
 *
 * That is W10, reported as *"the Goals screen scrolls on and on until the
 * content disappears"*, and the report was accurate. Measured on an iPhone
 * 17 Pro: the extent is exact in every state (`contentOffset` lands on
 * `contentSize − viewport + inset` to the pixel, at default AND at accessibility
 * text sizes), so nothing is over-tall and nothing unmounts — text simply leaves
 * the screen with no edge to leave at. At accessibility sizes a line is ~60pt,
 * so a whole line vanishes into nothing at a time.
 *
 * ## Why a hairline, when this header exists partly to have removed one
 *
 * The note above records replacing React Navigation's header because it drew
 * "its own surface colour and a hairline rule — two bands of subtly different
 * dark, stacked against a third". That objection was to a stack of SURFACES,
 * and to seams "dividing a layout that has no actual sections". Neither applies
 * where this rule is drawn: the header keeps the page's ground and gains one
 * hairline, over a boundary that genuinely exists. It very much DID apply to
 * `workouts`, which is why that screen is opted out rather than given a second
 * seam.
 *
 * `lineBoundary` matches the tab bar's own `borderTopColor` in
 * `app/(tabs)/_layout.tsx`, so on `goals` and `progress` — the two screens
 * that draw this rule AND sit under the tab bar — the scrolling region is
 * bounded by the same weight of rule at both ends. `phase` draws the same
 * rule outside the tab layout, where there is no second edge to match.
 *
 * **Resolved by F20 (#496): this used to be `lineSoft`, at 1.23:1 against
 * `vola.bg` — under the 3:1 WCAG 1.4.11 non-text floor, and weakest exactly
 * where the bug it fixes was worst, since the reader losing a whole 60pt line
 * at a time is the one on accessibility sizes.** `lineBoundary` is a new,
 * dedicated token at 3.11:1 — see its comment in `Colors.ts` for the full
 * costing (a stronger `lineSoft` everywhere, a threshold past some
 * accessibility size, elevation/a gradient, and accepting 1.23:1 were all
 * considered and rejected). `lineSoft` itself is untouched and still renders
 * everywhere else it always has; this is not that token nudged, it is a
 * narrower one that applies to exactly this boundary, the tab bar's, and (as
 * of F21/#497, which reused it rather than picking a third value) Library's
 * own `styles.chrome` border in `app/library.tsx` — see `Colors.ts`'s comment
 * on the token itself for the full, current list of sites.
 *
 * ## Why always-present rather than appearing on scroll
 *
 * An edge that fades in once content is beneath it says more. It is not cheap
 * here: the header and the scroller are SIBLINGS, so a scroll-derived value has
 * to be plumbed between them through a provider wrapping both. That buys the
 * animation at the cost of the property worth protecting — `goals.tsx` passes no
 * `onScroll` of its own and re-renders **zero** times while scrolling. A static
 * hairline costs nothing and fixes the reported bug; take it.
 *
 * ## Default ON, opt out with `contentScrollsUnder={false}`
 *
 * Five of eight callers opt out, which looks backwards until you compare the
 * two failure directions. A **missing** edge where content scrolls under the
 * header is the reported bug: invisible in code review, invisible to every
 * test, and found only when somebody reports it from a device. A **surplus**
 * edge is a stray line somebody sees immediately. So the default is the one
 * whose failure is loud, and a new screen that pins the header straight onto a
 * scroller is right without anyone remembering.
 *
 * **Known and accepted**: on a screen that draws it but whose content is shorter
 * than the viewport, the rule marks a boundary nothing is currently passing
 * under. It still says the region below scrolls, and it becomes load-bearing the
 * moment that screen has one more row than fits.
 *
 * ## The screen-name label is gone (N493)
 *
 * This header used to print the screen's own name — "LIBRARY", "FOOD" — as
 * visible text beside an accent-coloured dot, defended (see the JSX below,
 * before this note) as pairing with the tab bar's underline one row down to
 * answer "where am I" from either end of the screen. User-reported directly:
 * "Screens have additional view name in left corner that I don't like."
 *
 * Removed both the text AND the dot, not just the text — a lone dot with no
 * word beside it reads as a stray mark, not a deliberate design element,
 * and half-removing it would have looked like a bug rather than a choice.
 * The wordmark now has the whole row to centre in, which is a genuine side
 * effect worth knowing: `left` (fed to `wordmarkFits`) shrinks to whatever
 * `leading` alone contributes — 0 on every screen that doesn't pass one —
 * so the wordmark should now show reliably everywhere it used to sometimes
 * hide for width reasons.
 *
 * **VoiceOver still gets the screen name.** Sighted orientation was always
 * the tab bar's job as much as this header's (five of the eight callers ARE
 * tab screens); the two that are not (`library`, `phase`) still have no tab
 * bar to lean on, so removing the ONLY visual cue for a screen-reader user
 * too would be a real accessibility regression, not merely a visual
 * simplification. `titleWrap` itself now carries `accessibilityRole=
 * "header"` and `accessibilityLabel={title}` — nothing sighted, but VoiceOver
 * still announces "Library, header" on entering that screen, same as it
 * always could via the text this replaces.
 */

/** The artwork's width, and the clearance it needs on each side. */
const WORDMARK_WIDTH = 88;
const WORDMARK_MIN_GAP = 12;

/**
 * Whether the centred wordmark clears the content on both sides.
 *
 * Pure, and separated from the component because it is the only part of this
 * layout a test can reach: jest runs no Yoga pass, so `onLayout` never fires
 * and a real text measurement is unobtainable. The predicate can still be
 * pinned exactly.
 *
 * BOTH clauses matter. A right-only check passes the case that actually
 * shipped, and would then miss a long title — which is the direction a
 * localised build fails in.
 */
export function wordmarkFits(
  { row, left, right }: { row: number; left: number; right: number },
  wordmark = WORDMARK_WIDTH,
  minGap = WORDMARK_MIN_GAP,
): boolean {
  const centre = row / 2;
  const half = wordmark / 2;
  return left + minGap <= centre - half && centre + half <= row - right - minGap;
}

/**
 * A width from `onLayout`, ignoring the passes that did not change it.
 *
 * Without the equality check every layout pass sets state and re-renders,
 * which on a screen that lays out often is a needless render per pass.
 */
function useMeasuredWidth(): [number | null, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState<number | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout.width;
    setWidth((prev) => (prev === next ? prev : next));
  }, []);
  return [width, onLayout];
}

export function ScreenHeader({
  title,
  leading,
  action,
  contentScrollsUnder = true,
}: {
  title: string;
  /**
   * N484 — an optional control BEFORE the title, inside the same measured
   * `titleWrap` the wordmark's fit arithmetic already reads `left` from.
   * The only caller today is `library.tsx`'s own back button: this screen
   * is pushed (not a tab), so unlike every other `ScreenHeader` caller it
   * has no native header supplying one. Deliberately part of `titleWrap`
   * rather than a sibling absolutely positioned against `insets.top` —
   * that was the first version of this fix, and it overlaid the title
   * text rather than making room for it, because nothing told
   * `wordmarkFits` the left edge had grown. Putting it inside the
   * MEASURED box means `onLeftLayout` sees the true left extent
   * automatically, the same way it already does for the title and the
   * dot beside it — no new arithmetic, no magic number tied to this
   * header's own padding.
   */
  leading?: React.ReactNode;
  action?: React.ReactNode;
  /**
   * Does this header's bottom edge sit at the top of the scrolling region?
   *
   * `false` when the header scrolls away inside the scroll view, AND when it is
   * pinned above other fixed chrome that owns the boundary instead — see the
   * three arrangements at the top of this file. Both suppress the rule, for
   * different reasons, so each call site says which.
   *
   * Named for the question rather than for either reason on purpose: an earlier
   * `scrollsWithContent` described only the first, and would have been a false
   * assertion at the two call sites that opt out for the second.
   */
  contentScrollsUnder?: boolean;
}) {
  const insets = useSafeAreaInsets();

  const [rowWidth, onRowLayout] = useMeasuredWidth();
  const [leftWidth, onLeftLayout] = useMeasuredWidth();
  const [rightWidth, onRightLayout] = useMeasuredWidth();

  // OPTIMISTIC until all three are known, so the three tabs that have always
  // fitted never blink the wordmark out and back on mount. The pre-measurement
  // state is exactly the old behaviour, so nothing regresses on the screens
  // that were never wrong.
  const measured = rowWidth !== null && leftWidth !== null && rightWidth !== null;
  const showWordmark =
    !measured || wordmarkFits({ row: rowWidth, left: leftWidth, right: rightWidth });

  return (
    // The row is the positioning context for the centred wordmark, so the
    // title's own width can't push it off-centre.
    <View
      style={[
        styles.wrap,
        contentScrollsUnder && styles.scrollEdge,
        { paddingTop: insets.top + 14 },
      ]}
      testID="screen-header"
    >
      <View style={styles.row} onLayout={onRowLayout} testID="screen-header-row">
        {/* N493 — no visible text or dot here any more (see the doc comment
            above, "The screen-name label is gone"). `accessibilityRole=
            "header"` + `accessibilityLabel={title}` on this wrapper is what
            keeps VoiceOver announcing the screen name, since nothing sighted
            does that job for `library`/`phase` any more (they have no tab
            bar to lean on). `leading`, when present, is still a real,
            interactive child (Library's back button) — it must stay outside
            this label so VoiceOver still finds and announces IT separately,
            not swallowed into one "Library, header" announcement. */}
        <RNView style={styles.titleWrap} onLayout={onLeftLayout}>
          {leading}
          {/* A REAL, if tiny, frame — a zero-size `accessible` view has
              nothing for VoiceOver to land on and gets skipped entirely in
              linear navigation, which would silently undo the whole point
              of keeping this label. 1x1 is enough; nobody needs to SEE it. */}
          <RNView
            style={styles.titleAccessibilityMarker}
            accessible
            accessibilityRole="header"
            accessibilityLabel={title}
          />
        </RNView>
        {/* CONDITIONAL RENDER, not `opacity: 0`. The node below carries
            `accessibilityRole="header"` and the label "VOLA", so hiding it by
            opacity would leave a screen reader announcing a brand name that is
            not on screen. */}
        {showWordmark && (
          <RNView style={styles.wordmark} pointerEvents="none">
            {/* `accessible` sits on this inner view, not on the absolutely
                positioned wrapper. The wrapper is `left: 0, right: 0` so that the
                wordmark centres on the row rather than on whatever space the
                title leaves — but that makes it as wide as the header, and an
                accessibility element is the size of its frame. Put the label out
                there and touch-exploring anywhere across the middle band of the
                row reads "VOLA" instead of the screen name it is sitting on top
                of. Here the element is the 88pt artwork and nothing else. */}
            <RNView accessible accessibilityRole="header" accessibilityLabel="VOLA">
              <Image
                source={require('@/assets/images/vola-wordmark.png')}
                style={styles.wordmarkImage}
                contentFit="contain"
                // The view above carries the label; announcing the image too
                // would read the brand name twice.
                alt=""
                accessible={false}
              />
            </RNView>
          </RNView>
        )}
        {/* ONE flow child for both, which is the fix rather than tidiness: as
            separate children they made three, and `space-between` then places
            the middle one — the chip — inside the wordmark's band. The chip
            still comes first, so a screen's own control stays in the corner it
            has always been in. */}
        <RNView style={styles.rightCluster} onLayout={onRightLayout} testID="screen-header-actions">
          <SyncChip />
          {action}
        </RNView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, paddingBottom: 10 },
  // The top of the scrolling region, when this header is what content passes
  // under — see the three arrangements in the W10 note at the top.
  // `lineBoundary` (F20/#496) is the tab bar's own `borderTopColor` too, so on
  // those screens the scrolling region is bounded by the same weight of rule
  // at both ends — deliberately NOT `lineSoft`, see the token's own comment in
  // Colors.ts for why a dedicated token rather than a value nudge. Full-bleed
  // rather than inset by `paddingHorizontal`: it marks the edge of the scroll
  // view, which runs the whole width, not the edge of the text.
  scrollEdge: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: vola.lineBoundary,
  },
  wordmark: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 88 is where the wordmark carries the same weight as the screen title
  // opposite it without starting to compete. The height is derived from the
  // source SVG's 14030:1759 rather than typed, so the box is the artwork's
  // shape and `contain` has almost nothing to letterbox — the PNG's own
  // 2048:257 differs by a rounded-up pixel, which costs 0.08pt of slack, a
  // quarter of a device pixel at 3x. The viewBox ratio rather than the
  // raster's because `AnimatedSplash` derives the whole lockup from the same
  // numbers, and two files disagreeing by a rounding is worse than either.
  wordmarkImage: { width: 88, height: 88 * (1759 / 14030) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 28,
  },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  // The chip and the screen's own control, as one flow child. 12pt is `row`'s
  // own gap, carried over — though as siblings under `space-between` they
  // actually got MORE than that, since the surplus was split around the chip.
  // That surplus was the fault, not a baseline worth preserving: it is what
  // put the chip in the middle of the row. The free space now sits entirely
  // between the title and this group.
  rightCluster: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  // N493 — 1x1, not 0x0: an `accessible` view with no real frame is skipped
  // entirely by VoiceOver's linear navigation, which would silently drop
  // the screen-name announcement this exists to keep. Visually nothing.
  titleAccessibilityMarker: { width: 1, height: 1 },
});

/**
 * Bottom breathing room for a scrolling screen.
 *
 * Small now: the tab bar sits in normal flow rather than floating over the
 * content, so this is margin rather than the clearance it used to be.
 */
export const TAB_BAR_CLEARANCE = 28;
