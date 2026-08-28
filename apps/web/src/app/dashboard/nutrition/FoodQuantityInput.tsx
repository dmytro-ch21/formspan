"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { parseQuantity } from "@/lib/foodQuantity";
import { useUnits } from "@/lib/UnitsProvider";
import { foodUnitLabel, fromDisplayGrams, toDisplayGrams, type FoodUnit } from "@/lib/units";

const UNITS: FoodUnit[] = ["g", "oz"];

/**
 * "How much" in grams, with a g/oz toggle (N90) — the web half of the
 * control `apps/mobile/components/FoodQuantity.tsx` renders on the phone.
 *
 * **Grams are the prop.** `grams` in, `onGramsChange` out, always in grams —
 * this component owns the display transform and nothing else, the same
 * contract `units.ts` states for every other quantity in this app. Wherever a
 * caller stores its own quantity (a recipe item's `quantity` against a
 * `serving_label`, a day entry's `servings`), the CALLER converts to and from
 * grams around this component; it never sees or stores the caller's own unit.
 *
 * The toggle CONVERTS the field rather than relabelling it — typing "150" at
 * grams and tapping "oz" shows "5.29", not "150" beside a lit oz. Same rule,
 * same reason, as the mobile control it mirrors.
 */
export function FoodQuantityInput({
  grams,
  onGramsChange,
  disabled,
  label = "Quantity",
}: {
  grams: number;
  onGramsChange: (grams: number) => void;
  disabled?: boolean;
  label?: string;
}) {
  const { foodUnit, setFoodUnit } = useUnits();
  const [text, setText] = useState(String(toDisplayGrams(grams, foodUnit)));
  const [unitError, setUnitError] = useState<string | null>(null);

  // The field tracks `grams` from ABOVE only when it changes for a reason
  // other than this component's own `commit` below — a portion chip picked
  // by the caller, or a fresh row. Comparing against the last grams THIS
  // component reported prevents an effect that fires on every keystroke:
  // `commit` already calls `onGramsChange`, so without the guard the parent's
  // re-render would feed the same number straight back in and fight typing.
  //
  // The comparison is a TOLERANCE, not `===`: every caller here round-trips
  // through a caller-owned quantity (`grams / basis`, stored, then
  // `Number(stored) * basis` next render), and that division-then-
  // multiplication is not always bit-exact — measured: basis 172, grams
  // 91.2, comes back 91.19999999999999. A strict equality treats that as an
  // external change and resets the field on every keystroke for any basis
  // that does not divide evenly.
  const lastReported = useRef(grams);
  useEffect(() => {
    if (Math.abs(grams - lastReported.current) < 1e-6) return;
    lastReported.current = grams;
    setText(String(toDisplayGrams(grams, foodUnit)));
    // `foodUnit` deliberately absent — the unit-change effect below owns that
    // case, and both watching it here would double-convert on a toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grams]);

  // Re-renders the field when the unit changes from OUTSIDE this instance —
  // Settings, or another FoodQuantityInput on the same page — same mechanism
  // as mobile's `FoodQuantity`. Keyed on the unit alone so it cannot fight
  // the athlete's own typing.
  const lastUnit = useRef(foodUnit);
  useEffect(() => {
    if (lastUnit.current === foodUnit) return;
    lastUnit.current = foodUnit;
    setText(String(toDisplayGrams(grams, foodUnit)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foodUnit]);

  const commit = useCallback(
    (next: string) => {
      setText(next);
      const typed = parseQuantity(next);
      if (typed == null) return;
      const g = fromDisplayGrams(typed, foodUnit);
      lastReported.current = g;
      onGramsChange(g);
    },
    [foodUnit, onGramsChange],
  );

  const switchUnit = useCallback(
    async (u: FoodUnit) => {
      if (u === foodUnit) return;
      // Read the current quantity out under the OLD unit, redisplay it under
      // the new one, THEN persist the choice — reading the number out of the
      // text box and relabelling it is the bug this ordering avoids.
      setText(String(toDisplayGrams(grams, u)));
      setUnitError(null);
      try {
        await setFoodUnit(u);
      } catch (err) {
        // `setFoodUnit` rolls back and RETHROWS on a failed PATCH — same
        // contract `UnitsProvider.setUnits` has, and dropping this the way a
        // bare `void switchUnit(u)` onClick would is the exact silent-failure
        // shape `dashboard/settings/page.tsx` already had to fix for that
        // sibling call. The rollback itself still re-fires the unit-change
        // effect above and converts the field back, so nothing on screen
        // lies — but the athlete typed a real request that failed, and
        // deserves to be told.
        setUnitError(err instanceof Error ? err.message : "Could not change the unit.");
      }
    },
    [foodUnit, grams, setFoodUnit],
  );

  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="text-text-muted">{label}</span>
      <div className="flex items-stretch gap-2">
        <input
          type="text"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          onChange={(e) => commit(e.target.value)}
          aria-label={`${label} in ${foodUnit === "oz" ? "ounces" : "grams"}`}
          className="w-full rounded-control border border-line bg-bg px-3 py-2 text-sm text-text disabled:opacity-60"
        />
        <div
          className="flex overflow-hidden rounded-control border border-line"
          role="group"
          aria-label="Quantity unit"
        >
          {UNITS.map((u) => (
            <button
              key={u}
              type="button"
              disabled={disabled}
              onClick={() => void switchUnit(u)}
              aria-pressed={u === foodUnit}
              className={
                u === foodUnit
                  ? "bg-accent-fill px-3 text-sm font-semibold text-accent-on-fill"
                  : "bg-surface px-3 text-sm font-semibold text-text-muted disabled:opacity-60"
              }
            >
              {foodUnitLabel(u)}
            </button>
          ))}
        </div>
      </div>
      {unitError && (
        <p role="alert" className="text-xs text-danger-ink">
          {unitError}
        </p>
      )}
    </div>
  );
}
