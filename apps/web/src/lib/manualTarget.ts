/**
 * A typed nutrition target, parsed from the five text fields on
 * `/dashboard/nutrition/targets` (N127, #531).
 *
 * A port of `apps/mobile/lib/manualTarget.ts`'s `parseManualTarget`, not a new
 * design — the phone got client-side rails first (N86), and the two forms ask
 * the same server the same question. Web's form checked only "finite and not
 * negative", so a dropped digit submitted, came back as a permanent 400 and
 * landed in the page's shared error slot as "Could not save that target." —
 * a refusal that reads like a save that merely failed.
 *
 * `__tests__/manualTarget.test.ts` reads the server's `Target.Validate` and the
 * phone's constants from source and fails if any of the three disagree, so a
 * bound moved in one place cannot quietly leave the other two behind.
 *
 * Pure on purpose: what can be wrong here is arithmetic on strings.
 */

/** The form as the athlete has it: five strings, any of them half-typed. */
export type ManualDraft = {
  kcal: string;
  protein_g: string;
  carb_g: string;
  fat_g: string;
  fibre_g: string;
};

export type ManualTargetInput = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  /** Null, never zero — see {@link parseManualTarget}. */
  fibre_g: number | null;
};

export type ManualParse =
  | { ok: true; input: ManualTargetInput }
  | { ok: false; field: keyof ManualDraft | null; problem: string };

/**
 * The SERVER'S bounds — `backend/internal/modules/nutrition/nutrition.go`,
 * `Target.Validate`: kcal 800–8,000, protein ≤500 g, carbs ≤1,200 g, fat
 * ≤400 g, fibre ≤120 g. A rail against a mis-keyed number, not a second
 * opinion about what is safe to eat.
 *
 * **A client rail wider than the server's is worse than none.** The typo
 * passes here, is refused there — permanently — and the athlete is shown a
 * save that failed rather than a number that was wrong. The phone's first
 * version shipped exactly that (kcal 1–20,000).
 */
export const MIN_KCAL = 800;
export const MAX_KCAL = 8000;

/** Per-macro ceilings, matching the server's table field for field. */
export const MAX_MACRO_G: Record<"protein_g" | "carb_g" | "fat_g" | "fibre_g", number> = {
  protein_g: 500,
  carb_g: 1200,
  fat_g: 400,
  fibre_g: 120,
};

const LABEL: Record<keyof ManualDraft, string> = {
  kcal: "Calories",
  protein_g: "Protein",
  carb_g: "Carbs",
  fat_g: "Fat",
  fibre_g: "Fibre",
};

/**
 * Parse and validate.
 *
 * - **Blank fibre is null, not zero.** A target that does not state fibre is
 *   not a zero-fibre target; the column is nullable for exactly that reason.
 * - **Non-numeric fibre is REFUSED, not blanked.** This was the worst of web's
 *   old check: `Math.round(Number("abc"))` is `NaN`, `JSON.stringify` writes
 *   `NaN` as `null`, and the server stores `null` as "not stated" — so a typo
 *   in the one optional field was silently discarded, with a success message.
 * - **Zero or blank calories is not a target**, and **a blank macro is refused
 *   rather than defaulted**: `Number("")` is 0, and 0 g of protein reads as a
 *   decision nobody made.
 *
 * Every refusal names the field and, for a bound, the bound — "out of range"
 * sends somebody back to guess at a limit they cannot see.
 */
export function parseManualTarget(draft: ManualDraft): ManualParse {
  const kcal = parseField(draft.kcal);
  if (kcal === null) return { ok: false, field: "kcal", problem: "Calories need to be a number." };
  if (kcal <= 0) return { ok: false, field: "kcal", problem: "A target needs some calories in it." };
  if (kcal < MIN_KCAL || kcal > MAX_KCAL) {
    return {
      ok: false,
      field: "kcal",
      problem: `A target has to be between ${MIN_KCAL} and ${MAX_KCAL} kcal. Check that number.`,
    };
  }

  const macros: ("protein_g" | "carb_g" | "fat_g")[] = ["protein_g", "carb_g", "fat_g"];
  const out: Record<string, number> = {};
  for (const key of macros) {
    const v = parseField(draft[key]);
    if (v === null) return { ok: false, field: key, problem: `${LABEL[key]} needs to be a number.` };
    if (v < 0) return { ok: false, field: key, problem: `${LABEL[key]} cannot be negative.` };
    if (v > MAX_MACRO_G[key]) {
      return {
        ok: false,
        field: key,
        problem: `${LABEL[key]} tops out at ${MAX_MACRO_G[key]} g. Check that number.`,
      };
    }
    out[key] = Math.round(v);
  }

  // The blank check comes FIRST: `parseField` of a blank is null, which here
  // means "not stated" — and a non-blank that fails to parse must not be
  // allowed to mean the same thing.
  let fibre: number | null = null;
  if (draft.fibre_g.trim() !== "") {
    const v = parseField(draft.fibre_g);
    if (v === null) return { ok: false, field: "fibre_g", problem: "Fibre needs to be a number." };
    if (v < 0) return { ok: false, field: "fibre_g", problem: "Fibre cannot be negative." };
    if (v > MAX_MACRO_G.fibre_g) {
      return {
        ok: false,
        field: "fibre_g",
        problem: `Fibre tops out at ${MAX_MACRO_G.fibre_g} g. Check that number.`,
      };
    }
    fibre = Math.round(v);
  }

  return {
    ok: true,
    input: {
      kcal: Math.round(kcal),
      protein_g: out.protein_g,
      carb_g: out.carb_g,
      fat_g: out.fat_g,
      fibre_g: fibre,
    },
  };
}

/**
 * One field, or null when it is not a number at all. `Number("")` and
 * `Number(" ")` are both 0, which is the trap this closes. A comma is a decimal
 * point, as on the phone.
 */
function parseField(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
