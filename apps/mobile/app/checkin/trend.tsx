import { Redirect } from 'expo-router';

/**
 * The trend moved to `/goals/trend` (N56).
 *
 * A redirect rather than a deletion, for two reasons.
 *
 * **The door stays open.** Logging your weight and then seeing the line is the
 * natural gesture, and the mobile-first rule makes "harder to reach on the
 * phone than it was" a defect rather than a tidy-up. Two doors, one screen —
 * the same shape `/food/target` uses.
 *
 * **Installed builds still work.** `EXPO_PUBLIC_*` aside, a device carrying a
 * bundle that predates this move still pushes `/checkin/trend` from its own
 * `CheckinCard`, and a deleted route would land it on `+not-found` — which is
 * exactly the N32 failure, just arrived at from the other direction.
 */
export default function CheckinTrendRedirect() {
  return <Redirect href="/goals/trend" />;
}
