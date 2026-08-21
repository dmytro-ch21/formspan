/**
 * A target somebody typed, parsed from five text fields.
 *
 * Pure on purpose. The screen around it is a lifecycle problem — focus
 * refetches, receipts, a keyboard — and none of that is where this can be
 * wrong. What can be wrong is arithmetic on strings, and that is testable
 * without rendering anything.
 *
 * ## Why the phone gets this at all
 *
 * Manual entry lived only on web, so an athlete looking at a derived 2,700 kcal
 * on their phone could read the whole derivation and had **no way to disagree
 * with it**. The reasoning was reachable and the action was not, which is the
 * failure the mobile-first rule in `CLAUDE.md` was written to forbid.
 */

import { ApiError } from './apiError';
import { kcalLooksOff, type Macros } from './nutrition';

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
  /** `field` is which input to point at, or null when the problem is the form
   *  as a whole. Same split `lib/clerkErrors.ts` makes, and for the same
   *  reason: blaming an input for a form-level failure sends somebody to
   *  retype a field that was fine. */
  | { ok: false; field: keyof ManualDraft | null; problem: string };

/**
 * The one offline sentence, said the same way wherever a target write fails.
 *
 * Lifted out of `app/(tabs)/goals.tsx` when a second screen — the history — grew
 * the same three write paths. Two copies of this sentence is two chances for
 * one of them to drift back into blaming the network for a refusal.
 */
export const OFFLINE_MESSAGE =
  'Could not save it — this one needs a connection. Nothing has changed; try again when you have signal.';

/**
 * Why the last write failed, in the words the athlete needs.
 *
 * The distinction is the whole point, and it was arrived at by getting it
 * wrong: a boolean `failed` flag made every failure share the offline copy, so
 * an athlete whose mis-keyed 700 kcal the server had permanently refused was
 * told to try again when they had signal. It would fail identically forever.
 *
 * An `ApiError` means the server ANSWERED and refused: its message is written
 * for a human and is the most useful thing available, so it is shown. Anything
 * else — `OfflineError`, a dropped socket — means nothing was answered at all,
 * and only then is "try again when you have signal" true.
 */
export function refusalOrWeather(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return OFFLINE_MESSAGE;
}

/**
 * What the typed-target form opens on, given a target.
 *
 * Structurally typed rather than taking a `Target`, so the history screen can
 * seed the form from a stored row and Goals can seed it from a live suggestion
 * without either having to fabricate an `effective_on` it does not mean.
 */
export function draftFrom(t: {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  fibre_g: number | null;
}): ManualDraft {
  return {
    kcal: String(t.kcal),
    protein_g: String(t.protein_g),
    carb_g: String(t.carb_g),
    fat_g: String(t.fat_g),
    // Absent, not zero — seeding "0" would turn a target that never stated
    // fibre into one that claims none, on the athlete's next save.
    fibre_g: t.fibre_g == null ? '' : String(t.fibre_g),
  };
}

/** Empty draft — what the form opens with when there is nothing to start from. */
export const EMPTY_DRAFT: ManualDraft = {
  kcal: '',
  protein_g: '',
  carb_g: '',
  fat_g: '',
  fibre_g: '',
};

/**
 * The bounds, and they are the SERVER'S bounds, deliberately.
 *
 * Copied from `backend/internal/modules/nutrition/nutrition.go`'s
 * `Target.Validate` — kcal 800–8,000, protein ≤500 g, carbs ≤1,200 g, fat
 * ≤400 g, fibre ≤120 g — and they exist here to catch a typo, not to police a
 * diet. The server's own comment says the same: a rail against a mis-keyed
 * number, not a second opinion about what is safe.
 *
 * **A client rail wider than the server's is worse than no rail at all**, and
 * the first version of this file had exactly that: kcal 1–20,000. An athlete
 * who dropped a digit and typed 700 passed this parse, got a permanent 400, and
 * the catch rendered "try again when you have signal" — a dead end presented as
 * weather, on a request that would fail identically forever. Widening these
 * without widening the server's puts that straight back.
 *
 * The remote half is still authoritative and the save path still reports what
 * it says; this only means the common mistakes are caught before a round trip,
 * with a message that names the actual limit.
 */
export const MIN_KCAL = 800;
export const MAX_KCAL = 8000;

/** Per-macro ceilings, matching the server's table field for field. */
export const MAX_MACRO_G: Record<'protein_g' | 'carb_g' | 'fat_g' | 'fibre_g', number> = {
  protein_g: 500,
  carb_g: 1200,
  fat_g: 400,
  fibre_g: 120,
};

/**
 * Parse and validate.
 *
 * Three rules carry meaning beyond "is it a number":
 *
 * - **Blank fibre is null, not zero.** A target that does not state fibre is
 *   not a zero-fibre target — the column is nullable for exactly that reason,
 *   and a confident zero would drag every fibre figure that averages it.
 * - **Zero calories is not a target.** `Number('')` is 0, so a blank calorie
 *   field parses to a perfectly finite number; without the `> 0` floor an empty
 *   form would save a target of nothing.
 * - **A blank macro is refused rather than defaulted.** The same `Number('')`
 *   behaviour would silently store 0 g of protein for a field somebody had not
 *   got to yet, and 0 g of protein reads as a decision.
 */
export function parseManualTarget(draft: ManualDraft): ManualParse {
  const kcal = parseField(draft.kcal);
  if (kcal === null) return { ok: false, field: 'kcal', problem: 'Calories need to be a number.' };
  if (kcal <= 0) return { ok: false, field: 'kcal', problem: 'A target needs some calories in it.' };
  if (kcal < MIN_KCAL || kcal > MAX_KCAL) {
    // The number is named in the message. "Out of range" sends somebody back to
    // guess at a bound they cannot see, and the commonest cause of landing here
    // is a dropped or an extra digit — which is obvious the moment the limit is
    // on screen next to what they typed.
    return {
      ok: false,
      field: 'kcal',
      problem: `A target has to be between ${MIN_KCAL} and ${MAX_KCAL} kcal. Check that number.`,
    };
  }

  const macros: ('protein_g' | 'carb_g' | 'fat_g')[] = ['protein_g', 'carb_g', 'fat_g'];
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

  // Absent rather than zero, and the blank check comes FIRST: `parseField('')`
  // is a valid 0, so testing the parse instead would store the silence as a
  // measurement.
  let fibre: number | null = null;
  if (draft.fibre_g.trim() !== '') {
    const v = parseField(draft.fibre_g);
    if (v === null) return { ok: false, field: 'fibre_g', problem: 'Fibre needs to be a number.' };
    if (v < 0) return { ok: false, field: 'fibre_g', problem: 'Fibre cannot be negative.' };
    if (v > MAX_MACRO_G.fibre_g) {
      return {
        ok: false,
        field: 'fibre_g',
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
 * Whether the typed macros and the typed calories disagree enough to mention.
 *
 * A NUDGE, never a block — the same posture `food/add.tsx` takes — but the
 * justification is the opposite one and worth stating. There, a packet's stated
 * kcal wins because real labels do not reconcile: rounding, fibre and sugar
 * alcohols put them 5–10% apart routinely. Here there is no packet. A target is
 * a plan rather than a measurement, so its macros genuinely should add up to
 * its calories, and a gap is somebody's arithmetic slipping.
 *
 * Still not a block, because a coach's numbers are the athlete's to enter as
 * given, and refusing them would put us back where this screen started.
 */
export function targetMacrosLookOff(input: ManualTargetInput): boolean {
  const m: Pick<Macros, 'protein_g' | 'carb_g' | 'fat_g'> = {
    protein_g: input.protein_g,
    carb_g: input.carb_g,
    fat_g: input.fat_g,
  };
  return kcalLooksOff(input.kcal, m);
}

const LABEL: Record<keyof ManualDraft, string> = {
  kcal: 'Calories',
  protein_g: 'Protein',
  carb_g: 'Carbs',
  fat_g: 'Fat',
  fibre_g: 'Fibre',
};

/**
 * One field, or null when it is not a number at all.
 *
 * `Number('')` is 0 and `Number(' ')` is 0, which is the trap this exists to
 * close: both are "nothing typed", and both would otherwise arrive downstream
 * as a confident zero. Callers decide what a blank means — refused for a macro,
 * null for fibre — but they can only decide it if the parse tells them apart.
 */
function parseField(raw: string): number | null {
  // A comma is a decimal point. iOS's decimal-pad shows a comma key in many
  // locales, so without this a European athlete typing "2,5" is told it "needs
  // to be a number" — a locale-dependent input block, and inconsistent with the
  // ten other numeric inputs in this app that all normalise it (`draftNumber.ts`
  // and every screen built on it).
  const text = raw.trim().replace(',', '.');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
