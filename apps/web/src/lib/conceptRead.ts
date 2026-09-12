import type { Curriculum } from "./api";

/**
 * "Read and understood" on web (N466), the copy mobile's roadmap screen already
 * uses (N123). Kept here, out of the page, so vitest can reach it: web's tests
 * run in node and cannot render a page.
 */

/**
 * "22 of 48 concepts read", or null when the curriculum has no concepts.
 *
 * Its own figure, and NEVER combined with `mastered_items`: whether read
 * concepts count toward completion was decided in the open, and the answer is
 * no. A pre-N123 server sends no counts, which reads as "no concepts" rather
 * than as "0 read".
 */
export function conceptsReadLine(
  c: Pick<Curriculum, "concept_items" | "read_concepts">,
): string | null {
  const total = c.concept_items ?? 0;
  if (total <= 0) return null;
  const read = c.read_concepts ?? 0;
  return `${read} of ${total} concept${total === 1 ? "" : "s"} read`;
}

/**
 * The toggle's visible label and its title. The label says what the state IS,
 * so a second click reads as withdrawing the claim, not as the same click twice.
 * The title keeps mobile's point: a note to yourself, not evidence of mastery.
 */
export function readToggleCopy(read: boolean): { label: string; title: string } {
  return read
    ? { label: "Read and understood", title: "Marks this idea as not yet read" }
    : {
        label: "Mark as read and understood",
        title: "Your own note that you read this, not evidence of mastery",
      };
}
