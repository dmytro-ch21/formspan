import { Redirect } from 'expo-router';

/**
 * The target screen moved into the Goals tab; this keeps its old address alive.
 *
 * A route file rather than a deletion, and it is not ceremony. Three things
 * still point at `/food/target` and none of them is in this repo's control:
 * a push already in flight when the app updates, a deep link somebody saved,
 * and an installed build whose JS predates this change — the App Store updates
 * on its own schedule, which is the same reasoning that keeps `scope=shared`
 * accepted on the workouts endpoint.
 *
 * Deleting the file instead would make all three a "route not found" screen,
 * which is exactly the dead end N35 exists to prevent — and typed routes cannot
 * catch it, because the caller is a previous version of this app rather than a
 * literal in this tree.
 *
 * It is a redirect and not a copy of the screen: one implementation, at the new
 * address, so the two can never drift into answering differently.
 */
export default function TargetMoved() {
  return <Redirect href="/(tabs)/goals" />;
}
