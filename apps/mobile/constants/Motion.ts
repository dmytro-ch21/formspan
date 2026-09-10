/**
 * F38/#1037 — the press-feedback constants, in one place.
 *
 * **Deliberately small.** A full duration/easing token scale is N556's
 * ticket, not this one; adding one here would decide that ticket's questions
 * in passing. These are only the values F38 needs to stop the app disagreeing
 * with itself about what a press looks like.
 *
 * ## Why press feedback gets to exist at all
 *
 * The frequency gate says an interaction touched tens of times a day earns
 * "near-imperceptible only: under 150ms, or nothing". Press clears it because
 * there is no hover on a phone: press IS the entire feedback channel, and
 * 411 of this app's 493 pressables currently answer a finger with nothing.
 *
 * It also has to clear this product's own bar, which is stricter than the
 * general one: one-handed, standing, wet hands, ~20 seconds between sets. So
 * the press-IN is instant — 0ms — and only the release is animated. A press
 * that takes 120ms to appear is 120ms of the athlete wondering whether the
 * tap registered.
 */

/**
 * How far a pressed control shrinks. 3% — enough to read as physical because
 * it takes the label and icon with it, small enough not to look like a
 * separate event on a control tapped forty times a session.
 */
export const PRESS_SCALE = 0.97;

/** The release. 120ms sits mid-range of the 100–150ms press band. */
export const PRESS_MS = 120;

/**
 * Strong ease-out, as the four bezier control points rather than a built
 * easing object.
 *
 * **This module imports nothing, on purpose.** Building the curve here would
 * mean importing `cubicBezier` from Reanimated, which drags its whole native
 * runtime in behind it — and a constants file that cannot be read without a
 * native module is one no test can import. That is not hypothetical: it threw
 * `Cannot read properties of undefined (reading 'loadUnpackers')` the moment a
 * test touched it. The consumer builds the curve; this states the numbers.
 *
 * `ease-in` is banned on UI — it starts slow, delaying the exact moment the
 * finger is asking about.
 */
export const PRESS_BEZIER = [0.23, 1, 0.32, 1] as const;

/**
 * How far a finger may drift off a control before the press cancels.
 *
 * Zero controls in this app set it today, so a thumb sliding a few pixels
 * between sets cancels a press the athlete meant. 16 is roughly a finger's
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
 * "pressed", and reclassifying them is a visual decision this ticket has no
 * mandate to make.
 */
export const PRESS_OPACITY = 0.7;
