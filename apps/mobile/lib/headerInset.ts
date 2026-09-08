import { createContext, useContext } from 'react';

/**
 * Who supplies the top safe-area inset on a given screen (N504/#876).
 *
 * ## The bug this exists to prevent recurring
 *
 * `NativeTabs` hands the bar to UIKit's own `UITabBarController`, and a tab
 * screen's scroller acquires the platform's safe-area top content inset
 * whether or not it asks for one. `ScreenHeader` had always added `insets.top`
 * itself — correct while the tab bar was a JS `<Tabs>` and every screen was
 * genuinely full-bleed — so under native tabs the inset is stated twice and
 * the screen wears a blank band the height of the Dynamic Island above its
 * own header.
 *
 * **It presented as ONE broken screen out of five, from identical code**, and
 * that is the part worth remembering. Measured on the iOS 26.5 Simulator: the
 * header box's top edge sat at 62.0pt on Today and 0.0pt on Food, which
 * render structurally identical trees — same `ScrollView`, same
 * `contentContainerStyle`, same `<ScreenHeader …contentScrollsUnder={false}/>`
 * as the first child. Today is merely the tab that is SELECTED FIRST, so its
 * scroll view is created while UIKit is still standing the tab controller up,
 * and it comes out holding an inset the others never get. Forcing that one
 * scroll view to remount moved it to 0.0pt with nothing else changed, which
 * is what identified mount order rather than styling as the cause.
 *
 * Three fixes were tried against the running Simulator and each did nothing:
 * `automaticallyAdjustContentInsets={false}`, an explicit
 * `contentInset`/`contentOffset` of zero, and rendering the navigator on the
 * very first frame so no screen mounts into a subtree about to be replaced.
 * `contentInsetAdjustmentBehavior="never"` — already set on Today — is itself
 * the fourth: it is silently ineffective on the first-mounted screen, which
 * is why the screen that opts out hardest is the only one that was wrong.
 *
 * ## So the platform owns it, everywhere, rather than only where it insists
 *
 * All five tab scrollers now say `contentInsetAdjustmentBehavior="automatic"`
 * and every one of them reports the same 62.0pt (verified on all five), so
 * the value no longer depends on which tab the athlete happened to open
 * first. `ScreenHeader` then adds nothing on top inside the tab group. The
 * point is DETERMINISM, not the number: a screen laid out differently
 * depending on mount order cannot be reasoned about, and no test in this repo
 * can reach it — the whole thing is invisible until somebody looks at a
 * device and asks why there is a hole above the title.
 *
 * ## Declared ONCE by the layout, not passed by eight callers
 *
 * `ScreenHeader`'s own history is a list of layout contracts its callers
 * could not keep — see the wordmark note in that file, where an `action` slot
 * with no width contract collided with a centred image twice, and the fix was
 * to stop asking callers and measure instead. A `platformOwnsTopInset` prop
 * on `ScreenHeader` would be the same mistake: eight call sites, one of them
 * eventually wrong, and the failure invisible in review.
 *
 * So `app/(tabs)/_layout.tsx` — the one file that KNOWS it has handed the bar
 * to UIKit — states it once for everything beneath it, and every screen in
 * that subtree inherits the answer. Screens pass nothing and cannot get it
 * wrong; a screen added to `(tabs)/` is right automatically, and one added
 * outside it is right for the opposite reason.
 *
 * **The default is the safe direction, and that is deliberate.** With no
 * provider — a pushed route, and every screen test in the suite — this is
 * `false` and the header adds the inset exactly as it always has. The two
 * failures are not symmetrical: a surplus gap is visible and somebody
 * complains, a missing one puts the title under the status bar where it
 * cannot be read. Defaulting to `false` also means no existing test changes
 * behaviour, which is why this is a context rather than something read from
 * the router: 59 test files mock `expo-router` locally, and a router-derived
 * answer would have needed a line in every one of them, plus a fresh landmine
 * for the sixtieth.
 *
 * The arithmetic is pure and parameterised, following `wordmarkFits`,
 * `lib/tabIconPlan.ts` and `lib/shareCard.ts`'s `cardCaptureSize`: jest runs
 * no Yoga pass, so the padding a screen actually receives is unobservable
 * there — but the decision behind it can still be pinned exactly.
 */

/**
 * Set to `true` by a layout whose platform chrome already applies the top
 * safe-area inset to the screens beneath it. Only `app/(tabs)/_layout.tsx`
 * does, and only because `NativeTabs` is a real `UITabBarController`.
 */
export const PlatformTopInsetContext = createContext(false);

/** Does an ancestor already apply the top safe-area inset on this screen? */
export function usePlatformOwnsTopInset(): boolean {
  return useContext(PlatformTopInsetContext);
}

/**
 * `ScreenHeader`'s top padding: its own breathing room, plus the safe-area
 * inset ONLY where nothing above it has already added one.
 *
 * `base` is the header's own padding above the title row, unconditional — a
 * tab screen still needs space between the platform's inset and the text.
 */
export function headerTopPadding(
  platformOwnsTopInset: boolean,
  insetTop: number,
  base = 14,
): number {
  return (platformOwnsTopInset ? 0 : insetTop) + base;
}
