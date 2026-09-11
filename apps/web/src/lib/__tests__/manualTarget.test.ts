import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAX_KCAL, MAX_MACRO_G, MIN_KCAL, parseManualTarget, type ManualDraft } from "../manualTarget";

/**
 * N127 (#531) — the typed-target rails on web.
 *
 * The first block is the one that matters most: the rails are only right if
 * they are the SERVER'S, and a copy is only a copy until somebody edits one
 * side. So the server's `Target.Validate` and the phone's constants are read
 * from source and compared number for number.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const num = (src: string, re: RegExp): number => {
  const m = src.match(re);
  expect(m, `no match for ${re}`).not.toBeNull();
  return Number(m![1]);
};

describe("the rails are the server's, and the phone's", () => {
  const go = read("../../../../../backend/internal/modules/nutrition/nutrition.go");
  const phone = read("../../../../mobile/lib/manualTarget.ts");

  it("read both files", () => {
    expect(go).toContain("func (t *Target) Validate() error");
    expect(phone).toContain("export function parseManualTarget");
  });

  it("calories match Target.Validate", () => {
    expect(num(go, /minTargetKcal\s*=\s*(\d+)/)).toBe(MIN_KCAL);
    expect(num(go, /maxTargetKcal\s*=\s*(\d+)/)).toBe(MAX_KCAL);
  });

  it("every macro ceiling matches Target.Validate", () => {
    expect(num(go, /\{"protein", t\.ProteinG, (\d+)\}/)).toBe(MAX_MACRO_G.protein_g);
    expect(num(go, /\{"carbs", t\.CarbG, (\d+)\}/)).toBe(MAX_MACRO_G.carb_g);
    expect(num(go, /\{"fat", t\.FatG, (\d+)\}/)).toBe(MAX_MACRO_G.fat_g);
    expect(num(go, /\*t\.FibreG > (\d+)/)).toBe(MAX_MACRO_G.fibre_g);
  });

  it("and the phone's constants agree", () => {
    expect(num(phone, /export const MIN_KCAL = (\d+)/)).toBe(MIN_KCAL);
    expect(num(phone, /export const MAX_KCAL = (\d+)/)).toBe(MAX_KCAL);
    const table = phone.slice(phone.indexOf("export const MAX_MACRO_G"));
    expect(num(table, /protein_g: (\d+)/)).toBe(MAX_MACRO_G.protein_g);
    expect(num(table, /carb_g: (\d+)/)).toBe(MAX_MACRO_G.carb_g);
    expect(num(table, /fat_g: (\d+)/)).toBe(MAX_MACRO_G.fat_g);
    expect(num(table, /fibre_g: (\d+)/)).toBe(MAX_MACRO_G.fibre_g);
  });
});

const draft = (over: Partial<ManualDraft> = {}): ManualDraft => ({
  kcal: "2500",
  protein_g: "180",
  carb_g: "250",
  fat_g: "80",
  fibre_g: "",
  ...over,
});
const problem = (d: ManualDraft): string | null => {
  const r = parseManualTarget(d);
  return r.ok ? null : r.problem;
};

describe("parseManualTarget", () => {
  it("accepts the server's own edges", () => {
    expect(parseManualTarget(draft({ kcal: "800" })).ok).toBe(true);
    expect(parseManualTarget(draft({ kcal: "8000" })).ok).toBe(true);
    expect(
      parseManualTarget(draft({ protein_g: "500", carb_g: "1200", fat_g: "400", fibre_g: "120" })).ok,
    ).toBe(true);
  });

  it("refuses a dropped or an extra digit on calories, naming the limit", () => {
    expect(problem(draft({ kcal: "799" }))).toBe(
      "A target has to be between 800 and 8000 kcal. Check that number.",
    );
    expect(problem(draft({ kcal: "8001" }))).toBe(
      "A target has to be between 800 and 8000 kcal. Check that number.",
    );
  });

  it.each([
    ["protein_g", "501", "Protein tops out at 500 g. Check that number."],
    ["carb_g", "1201", "Carbs tops out at 1200 g. Check that number."],
    ["fat_g", "401", "Fat tops out at 400 g. Check that number."],
    ["fibre_g", "121", "Fibre tops out at 120 g. Check that number."],
  ] as const)("refuses %s one over its ceiling", (field, value, message) => {
    expect(parseManualTarget(draft({ [field]: value }))).toEqual({ ok: false, field, problem: message });
  });

  it("refuses a non-numeric fibre, instead of saving it as 'not stated'", () => {
    expect(parseManualTarget(draft({ fibre_g: "abc" }))).toEqual({
      ok: false,
      field: "fibre_g",
      problem: "Fibre needs to be a number.",
    });
  });

  it("reads a blank fibre as null, not zero", () => {
    const r = parseManualTarget(draft({ fibre_g: "   " }));
    expect(r.ok && r.input.fibre_g).toBeNull();
  });

  it("refuses a blank macro rather than storing 0 g", () => {
    expect(problem(draft({ protein_g: "" }))).toBe("Protein needs to be a number.");
  });

  it("refuses blank or zero calories, and negatives", () => {
    expect(problem(draft({ kcal: "" }))).toBe("Calories need to be a number.");
    expect(problem(draft({ kcal: "0" }))).toBe("A target needs some calories in it.");
    expect(problem(draft({ fat_g: "-5" }))).toBe("Fat cannot be negative.");
  });

  it("rounds, and reads a comma as a decimal point", () => {
    expect(parseManualTarget(draft({ kcal: "2500,4", fat_g: "80.6", fibre_g: "30" }))).toEqual({
      ok: true,
      input: { kcal: 2500, protein_g: 180, carb_g: 250, fat_g: 81, fibre_g: 30 },
    });
  });
});
