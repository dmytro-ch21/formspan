import type { DayNarration } from '@/lib/dayNarration';

/**
 * Where the day panel's narration renders — and, in N541 tranche 1, where
 * nothing renders.
 *
 * It sits above the facts rather than inside them so that removing it can never
 * remove a fact: the panel is complete without this component, and the test for
 * the screen asserts exactly that. See `lib/dayNarration.ts` for the contract
 * tranche 2 attaches under.
 *
 * An exhaustive switch rather than a bare `return null`, so that adding the
 * `ready` member to `DayNarration` is a type error here until somebody decides
 * what it draws.
 */
export function DayNarrationSlot({ narration }: { narration: DayNarration }) {
  switch (narration.kind) {
    case 'absent':
      return null;
    default: {
      const unhandled: never = narration.kind;
      return unhandled;
    }
  }
}
