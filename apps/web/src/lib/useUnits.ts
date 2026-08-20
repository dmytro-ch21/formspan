/**
 * `useUnits` moved to `lib/UnitsProvider.tsx`.
 *
 * It used to be a hook that each of ten surfaces instantiated separately — ten
 * copies of one account-level enum, ten `GET /v1/profile` calls (one per
 * *session rendered* on the sessions list), each starting at `metric` and
 * correcting itself a frame later. Worse, `setUnits` updated only the calling
 * component, so changing the preference in Settings left every other mounted
 * surface on the old units until a reload.
 *
 * Re-exported from here so the existing call sites keep working; the state now
 * lives once, in the provider mounted in `app/dashboard/layout.tsx`, seeded
 * server-side so nothing is ever painted in units we have not established.
 *
 * This mirrors `apps/mobile/lib/useUnits.ts`, which did the same thing first
 * and for the same reason.
 */
export { useUnits, UnitsProvider } from "./UnitsProvider";
