"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { getProfile, updateUnitSystem } from "@/lib/api";
import type { UnitSystem } from "@/lib/units";

/**
 * The athlete's display units, read from their profile.
 *
 * An account preference rather than a browser one: someone who thinks in
 * pounds thinks in pounds on their phone too, so it follows them rather than
 * living in localStorage. Defaults to metric until the profile loads, which
 * is also what a new account gets.
 */
export function useUnits(): { units: UnitSystem; setUnits: (u: UnitSystem) => Promise<void> } {
  const { getToken } = useAuth();
  const [units, setLocal] = useState<UnitSystem>("metric");

  useEffect(() => {
    const controller = new AbortController();
    getProfile(getToken, controller.signal)
      .then((p) => {
        if (!controller.signal.aborted) setLocal(p.unit_system);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [getToken]);

  const setUnits = useCallback(
    async (u: UnitSystem) => {
      // Applied locally first so the page switches instantly.
      setLocal(u);
      await updateUnitSystem(getToken, u);
    },
    [getToken],
  );

  return { units, setUnits };
}
