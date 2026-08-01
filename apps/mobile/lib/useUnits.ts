/**
 * `useUnits` moved to `lib/UnitsProvider.tsx`.
 *
 * It used to be a hook that each of six screens instantiated separately —
 * six copies of one account-level enum, six `GET /v1/profile` calls, each
 * starting at `metric` and correcting itself a frame later. That is why an
 * athlete set to imperial saw a finished session's volume in tonnes, and why
 * screens disagreed with each other.
 *
 * Re-exported from here so the existing call sites keep working; the state now
 * lives once, in the provider mounted in `app/_layout.tsx`.
 */
export { useUnits, UnitsProvider } from './UnitsProvider';
