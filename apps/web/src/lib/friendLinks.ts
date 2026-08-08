import type { FriendCard, FriendRequests } from "./api";

/**
 * What relationship, if any, you already have with a handle.
 *
 * Extracted rather than inlined into the screen because it is the one piece of
 * this feature `apps/web`'s test setup can actually reach — vitest here is
 * node-only and pure-logic by deliberate policy, so a predicate in a module is
 * testable and the same condition written inside a component is not.
 *
 * It is also the piece most worth pinning. Getting it wrong shows an **Add
 * friend** button for somebody you have already asked, and the athlete taps it
 * and gets a 409 for their trouble. The server refuses correctly either way —
 * this exists so the screen does not offer an action it knows will fail.
 */
export type LinkState = "none" | "friends" | "incoming" | "outgoing";

/**
 * `null` for either list means NOT LOADED, and it is answered as such rather
 * than as "no relationship".
 *
 * That distinction is the whole reason this returns a four-state value instead
 * of a boolean. Treating a not-yet-loaded list as empty is indistinguishable
 * from "no link", so the screen would offer Add during the first moments of
 * every visit — including to people already in the list underneath. Mobile
 * records the same reasoning: "saying nothing is better than saying wrong".
 */
export function linkState(
  username: string,
  friends: FriendCard[] | null,
  requests: FriendRequests | null,
): LinkState | "unknown" {
  if (friends === null || requests === null) return "unknown";
  // Handles are lowercase-canonical server-side, but a caller may hold one
  // typed by a person. Compared case-insensitively so a link is never missed
  // on capitalisation alone — which would be the false negative that offers
  // Add to an existing friend.
  const handle = username.trim().toLowerCase();
  const has = (list: FriendCard[]) =>
    list.some((c) => c.username.trim().toLowerCase() === handle);

  if (has(friends)) return "friends";
  // Incoming before outgoing: if somehow both exist, the actionable one is the
  // request waiting on YOU, and that is what the screen should offer.
  if (has(requests.incoming)) return "incoming";
  if (has(requests.outgoing)) return "outgoing";
  return "none";
}

/**
 * What the result card should say about an existing link, or null when there
 * is nothing to say and the Add button belongs there instead.
 *
 * Copy rather than a state name, because each of these is a different thing
 * the athlete might do next and a single "already linked" would hide that.
 */
export function linkLabel(state: LinkState | "unknown"): string | null {
  switch (state) {
    case "unknown":
      return "Checking…";
    case "friends":
      return "Already your friend.";
    case "incoming":
      return "They have asked you — answer below.";
    case "outgoing":
      return "You have already asked. Waiting on them.";
    default:
      return null;
  }
}
