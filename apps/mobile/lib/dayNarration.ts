/**
 * The narration seam for the day panel — N541 (#972). **Tranche 1 ships it
 * empty on purpose.**
 *
 * ## What attaches here, and what may not
 *
 * Tranche 2 will narrate and prioritise the day: turn the facts in
 * `lib/dayPanel.ts` into a short plan and summary. The contract that tranche
 * has to keep is already fixed by the type of what it will be handed:
 *
 * - **Input is `panelFacts(panel)` and nothing else.** Narration never reads a
 *   table, never calls a read function, and never sees an absence as if it
 *   were a fact.
 * - **It is never the source of a fact.** Every sentence it produces must cite
 *   fact keys from that list; a key that is not there — a session that is not
 *   in the plan, a target that was never set — is a fabricated fact, and the
 *   guard that rejects it extends the invariant `dayPanel.test.ts` already
 *   checks rather than inventing a second one.
 * - **Absent is a complete, correct screen.** The panel below this slot renders
 *   the whole day with no narration at all; that is what the athlete sees with
 *   no signal, and it is what they see today.
 *
 * ## Why the union has one member
 *
 * A `ready` variant would have to decide the shape of generated text — how it
 * cites facts, whether it is cached per day or regenerated on change — and that
 * is tranche 2's generation and caching policy, a cost decision the user has not
 * made. Declaring a shape here would be making it. So the only honest value
 * today is `absent`, and adding the second member is where tranche 2 starts.
 *
 * Deliberately no placeholder copy anywhere: a stub sentence standing where
 * narration will go is exactly the unbacked user-facing assertion this ticket
 * forbids.
 */
export type DayNarration = { kind: 'absent' };

/**
 * One narrated sentence, and the fact keys it rests on (N570, #1131).
 *
 * Declared beside the seam because it is the unit the fabricated-fact guard in
 * `lib/narrationGuard.ts` checks. `cites` must name keys from `panelFacts`, and
 * every number in `text` must be a number those cited facts state themselves.
 *
 * **It is not yet a member of {@link DayNarration}.** Nothing produces
 * narration that reaches the screen until the model path lands, and a `ready`
 * variant with no producer would be the placeholder this file's doc forbids.
 */
export type NarrationSentence = { text: string; cites: string[] };

/** What the panel passes while nothing narrates. The only value in tranche 1. */
export const NO_NARRATION: DayNarration = { kind: 'absent' };
