/**
 * `useTrackEffort` moved to `lib/TrackEffortProvider.tsx`.
 *
 * It was a hook that two screens instantiated separately — two copies of one
 * account-level boolean, two profile fetches — and, more importantly, it had
 * no record of a local choice that hadn't reached the account, so turning it
 * off offline silently reverted. See the provider for both.
 *
 * Re-exported so existing call sites keep working.
 */
export { useTrackEffort, TrackEffortProvider } from './TrackEffortProvider';
