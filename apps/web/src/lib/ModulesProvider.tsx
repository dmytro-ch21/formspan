"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import type { Module } from "@/lib/api";

/**
 * The athlete's enabled disciplines, for the whole dashboard.
 *
 * **Fetched once, server-side, in `dashboard/layout.tsx`** and handed down as
 * an initial value — not fetched here. Two reasons, and the first is a bug this
 * codebase already paid for:
 *
 * 1. `useUnits` fetches the profile per call site with no shared cache, which
 *    cost *one `GET /v1/profile` per session rendered* — 200 identical requests
 *    for one account-level enum, documented at `dashboard/sessions/page.tsx`.
 *    Module state is needed by the sidebar AND every page, so repeating that
 *    shape would be worse.
 * 2. The layout is a Server Component, so the read is awaited before anything
 *    renders. A client-side read would paint the full navigation for one frame
 *    and then remove items — a visible flash of destinations the user doesn't
 *    have.
 *
 * The provider still holds state because Settings can change it, and the
 * sidebar has to follow without a reload.
 */

type ModulesState = {
  modules: Module[];
  /** Adopt a set the caller already has — what `PATCH /v1/modules` returns. */
  apply: (next: Module[]) => void;
};

const ModulesContext = createContext<ModulesState>({ modules: [], apply: () => {} });

export function ModulesProvider({
  initial,
  children,
}: {
  initial: Module[];
  children: React.ReactNode;
}) {
  const [modules, setModules] = useState<Module[]>(initial);
  const apply = useCallback((next: Module[]) => setModules(next), []);
  const value = useMemo(() => ({ modules, apply }), [modules, apply]);
  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

export function useModules(): ModulesState {
  return useContext(ModulesContext);
}
