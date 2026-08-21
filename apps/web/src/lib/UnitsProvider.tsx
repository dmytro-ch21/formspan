"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { updateUnitSystem } from "@/lib/api";
import type { UnitSystem } from "@/lib/units";

/**
 * The athlete's display units — once, for the whole dashboard.
 *
 * **This was a hook called from ten places, and that was the bug.** Every call
 * site got its own `useState<UnitSystem>("metric")` and its own
 * `GET /v1/profile`, so the app held ten independent copies of one
 * account-level enum, each starting at metric and resolving at its own pace.
 *
 * `apps/mobile` fixed exactly this shape first, and the report that prompted it
 * was precise about the symptom: *"when a workout is finished in today section
 * it shows volume as tonnage not the lbs? why it is not consistent?"* — from an
 * athlete whose account was already set to imperial. Two things went wrong at
 * once and one copy fixes both: every screen began at `metric` and corrected
 * itself a frame later, and screens disagreed with each other because ten
 * resolutions racing ten fetches do not land together.
 *
 * Web had the *additional* cost mobile did not, because a web page renders far
 * more rows: `dashboard/sessions/page.tsx` already documents this hook costing
 * **one `GET /v1/profile` per session rendered** — 200 identical requests for
 * one enum. And it had a defect mobile's version did not: `setUnits` on the
 * settings page updated only that component's state, so changing the
 * preference left every other mounted surface showing the old units until a
 * reload. N105's acceptance criterion is that changing it updates *every*
 * surface with no restart, which was simply unreachable before this.
 *
 * ## Why `initial` is fetched server-side rather than here
 *
 * Same reasoning as `ModulesProvider`, which this deliberately mirrors:
 * `dashboard/layout.tsx` is a Server Component, so the read is awaited before
 * anything renders and no unit-bearing number is ever painted in a unit we
 * have not established yet. A client-side read would reintroduce the
 * one-frame-of-metric flash for the whole dashboard at once, which is the more
 * visible half of the original complaint.
 *
 * Mobile solves the same problem with a `unitsReady` flag instead, because it
 * has no server render to hang the read on. Neither app needs the other's
 * mechanism.
 *
 * The provider still holds state because Settings can change it and every
 * surface has to follow without a reload — which is the whole point.
 */

type UnitsState = {
  units: UnitSystem;
  setUnits: (u: UnitSystem) => Promise<void>;
};

const UnitsContext = createContext<UnitsState>({
  units: "metric",
  setUnits: async () => {},
});

export function UnitsProvider({
  initial,
  children,
}: {
  initial: UnitSystem;
  children: React.ReactNode;
}) {
  const { getToken } = useAuth();
  const [units, setLocal] = useState<UnitSystem>(initial);

  const setUnits = useCallback(
    async (u: UnitSystem) => {
      // Applied locally first so every surface switches instantly, then
      // persisted. The optimistic order is carried over from the hook this
      // replaces; what is new is that "locally" now means EVERYWHERE — which
      // is also why the rollback below had to be added rather than inherited.
      //
      // In the old per-component hook a failed PATCH left one component
      // optimistically wrong. Sharing the state widened that blast radius to
      // the whole dashboard: every mounted surface would show a preference the
      // server never accepted, and the next navigation would silently snap them
      // all back. So a failure restores the previous value and rethrows, which
      // is what lets the caller say so.
      const previous = units;
      setLocal(u);
      try {
        await updateUnitSystem(getToken, u);
      } catch (err) {
        setLocal(previous);
        throw err;
      }
    },
    [getToken, units],
  );

  const value = useMemo(() => ({ units, setUnits }), [units, setUnits]);
  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>;
}

export function useUnits(): UnitsState {
  return useContext(UnitsContext);
}
