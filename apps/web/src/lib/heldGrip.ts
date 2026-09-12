import { GRIPS, type Grip } from "./api";

/**
 * The grip a set was held in, as a finished session's read-only row prints it
 * (F27, #715). `null` when the set recorded none: this restores a fact that
 * exists and never invents one, the same "only when recorded" rule mobile's
 * `describeSet` follows.
 *
 * The full word, not the three-letter short. The short ("Rev") sat beside the
 * set number with the word only in a hover `title`, and the one report on
 * record of this surface is somebody who looked for the grip on a finished
 * session and did not see it. The select it replaces once editing is over
 * already showed the full word, and so does mobile's row. The row appends a
 * visually hidden " grip", so a screen reader says what the word is.
 *
 * A key this build does not know (a grip a newer server added) prints as its
 * own id rather than disappearing.
 */
export function heldGripLabel(grip: Grip | null | undefined): string | null {
  if (!grip) return null;
  return GRIPS.find((g) => g.key === grip)?.label ?? grip;
}
