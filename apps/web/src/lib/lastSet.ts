import type { Suggestion } from "./api";
import { formatWeight, type UnitSystem } from "./units";

/**
 * "5 × 100kg (2 assisted) · 1 RIR" — a suggestion's top set, one real set,
 * never a composite. Moved out of `ProgressionCard.tsx` so it can be tested:
 * vitest here is pure logic, and the card is a component file (F62/#1165).
 *
 * `last_reps` is the full count of that set, so without the note an assisted
 * top set read as unaided, while the progression beside it is measured against
 * the solo count. The note is mobile's `assistedNote` rule, by value: nothing
 * for null or 0, and only where a rep count is printed.
 */
export function lastSetLine(s: Suggestion, units: UnitSystem): string | null {
  if (s.last_weight_kg == null) return null;
  const reps = s.last_reps != null ? `${s.last_reps} × ` : "";
  const assisted =
    s.last_reps != null && (s.last_assisted_reps ?? 0) > 0 ? ` (${s.last_assisted_reps} assisted)` : "";
  const effort =
    s.last_rir != null
      ? ` · ${s.last_rir} RIR`
      : s.last_rpe != null
        ? ` · RPE ${s.last_rpe}`
        : "";
  return `${reps}${formatWeight(s.last_weight_kg, units)}${assisted}${effort}`;
}
