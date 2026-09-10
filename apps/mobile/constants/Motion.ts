import { DURATION, EASING_BEZIER } from '@/constants/designTokens.generated';

/**
 * The VOLA mobile motion scale — how long things take, and how they get there.
 *
 * Sibling to `Spacing.ts`, same idea and same reason it exists: facts about
 * the brand live in `assets/brand/design-tokens.json` and code references
 * them, never restates them. Before N556 the brand file had five top-level
 * keys and **not one of them was temporal**, so every animation in the app
 * hand-typed its own number and no two agreed by anything but luck.
 *
 * ## What is NOT here, deliberately
 *
 * There is no duration above 320ms and there is no `in` curve. `ease-in`
 * starts slow, delaying the exact moment the user is looking at, and is never
 * correct on UI — so the scale does not offer one to reach for.
 *
 * The app's existing long animations are **not** on this scale and should not
 * be moved onto it: `MacroRings`' 620ms sweep, `LiveHRIndicator`'s 90/220 and
 * `AnimatedSplash`'s launch sequence are deliberately outside the UI budget.
 * A ring sweep and a launch sequence are not UI transitions.
 *
 * ## Why this file imports the generated module but nothing else
 *
 * `designTokens.generated.ts` is plain numbers with no runtime behind it, so
 * importing it costs nothing. Importing `cubicBezier` from Reanimated to build
 * the curves here would be different: it drags Reanimated's whole native
 * runtime in behind it, and a constants file that cannot be read without a
 * native module is one no test can import. That is not hypothetical — it threw
 * `Cannot read properties of undefined (reading 'loadUnpackers')` the moment a
 * test touched it during F38. So this file states the four control points and
 * the CONSUMER builds the curve (`cubicBezier(...EASE.out)`).
 */

/**
 * Durations, in milliseconds.
 *
 * The bands are about what the user is doing, not about how big the thing is:
 * a press is answered, a control resolves, a surface arrives.
 */
export const MS = {
  /**
   * 120ms. The release of a press. Mid-range of the 100–150ms press band.
   *
   * Note this is the release ONLY — the press-IN is 0ms everywhere in this
   * app. A press that takes 120ms to appear is 120ms of the athlete wondering
   * whether the tap registered, and this product's bar is one-handed, standing,
   * with wet hands and ~20 seconds between sets.
   */
  press: DURATION.press,
  /** 180ms. A control resolving to its new state — a toggle, a chip, a segment. */
  control: DURATION.control,
  /** 240ms. A surface changing on screen — a card expanding, a section reflowing. */
  surface: DURATION.surface,
  /** 320ms. A sheet or drawer arriving or leaving. The longest the scale offers. */
  sheet: DURATION.sheet,
} as const;

/**
 * Easing curves, as their four bezier control points rather than built easing
 * objects — see the note above on why this file will not import Reanimated.
 *
 * Spread them at the call site: `cubicBezier(...EASE.out)`.
 */
export const EASE = {
  /** Strong ease-out. The default for anything entering or answering a touch. */
  out: EASING_BEZIER.out,
  /** Ease-in-out, for something already on screen moving or morphing. */
  inOut: EASING_BEZIER.inOut,
  /** iOS's own sheet curve, for a sheet or drawer. */
  sheet: EASING_BEZIER.sheet,
} as const;

/**
 * How far a pressed control shrinks. 3% — enough to read as physical because
 * it takes the label and icon with it, small enough not to look like a
 * separate event on a control tapped forty times a session.
 *
 * Hand-written rather than generated: it is a ratio, not a duration or a
 * curve, and `design-tokens.json`'s `motion` key covers only time.
 */
export const PRESS_SCALE = 0.97;

/**
 * How far a finger may drift off a control before the press cancels.
 *
 * Zero controls in this app set it before F38, so a thumb sliding a few pixels
 * between sets cancelled a press the athlete meant. 16 is roughly a finger's
 * own slop; a deliberate slide away still cancels.
 */
export const PRESS_RETENTION = 16;

/**
 * The ONE press opacity, for controls that dim rather than scale.
 *
 * Replaces the 0.6 / 0.7 / 0.8 / 0.85 spread — 27 hand-typed definitions
 * doing one job in four values. The four lower values in the app
 * (0.5, 0.55) are deliberately NOT folded in: at half strength they are
 * almost certainly saying "disabled" or "de-emphasised" rather than
 * "pressed", and reclassifying them is a visual decision F38 had no mandate
 * to make.
 */
export const PRESS_OPACITY = 0.7;

/**
 * F38's names for the two press values, kept so that the ~40 files which
 * already import them do not appear in N556's diff.
 *
 * They are now sourced from the token scale rather than restated: F38 landed
 * ahead of the ticket meant to unblock it and hand-typed `120` and
 * `[0.23, 1, 0.32, 1]`, which are exactly the values `motion.duration.press`
 * and `motion.easing.out` now carry. Same numbers, one source.
 */
export const PRESS_MS = MS.press;
export const PRESS_BEZIER = EASE.out;
