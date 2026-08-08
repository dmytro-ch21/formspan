import { describe, expect, it } from "vitest";

import type { FriendCard, FriendRequests } from "../api";
import { linkLabel, linkState } from "../friendLinks";

/**
 * Whether a handle is already linked to you.
 *
 * The failure this prevents is small and constant: an **Add friend** button
 * offered for somebody already asked, tapped, and answered with a 409. The
 * server refuses correctly either way — the point is not to offer an action
 * that is known to fail.
 *
 * The case that matters most is the one a boolean cannot express: a list that
 * has not loaded yet is NOT "no relationship". Every assertion below was
 * checked by breaking the rule it covers and confirming it went red.
 */

const card = (username: string): FriendCard => ({
  username,
  display_name: null,
  since: "2026-01-01T00:00:00Z",
});

const requests = (over: Partial<FriendRequests> = {}): FriendRequests => ({
  incoming: [],
  outgoing: [],
  ...over,
});

describe("what link you already have", () => {
  it("says UNKNOWN while either list is still loading", () => {
    // The whole reason this is not a boolean. `null` is loading; treating it
    // as empty means the screen offers Add for the first moments of every
    // visit, including to people already in the list underneath.
    expect(linkState("rhonda", null, requests())).toBe("unknown");
    expect(linkState("rhonda", [], null)).toBe("unknown");
    expect(linkState("rhonda", null, null)).toBe("unknown");
  });

  it("says NONE once both lists are in and neither holds them", () => {
    // The arm that makes the previous test mean something: loaded-and-absent
    // must be distinguishable from not-yet-loaded, or a constant "unknown"
    // would satisfy it.
    expect(linkState("rhonda", [], requests())).toBe("none");
  });

  it("finds an existing friend, an incoming ask, and an outgoing one", () => {
    expect(linkState("rhonda", [card("rhonda")], requests())).toBe("friends");
    expect(
      linkState("rhonda", [], requests({ incoming: [card("rhonda")] })),
    ).toBe("incoming");
    expect(
      linkState("rhonda", [], requests({ outgoing: [card("rhonda")] })),
    ).toBe("outgoing");
  });

  it("is not fooled by capitalisation", () => {
    // Handles are lowercase-canonical server-side, but this is compared
    // against something a person typed. A case-sensitive check is a false
    // NEGATIVE — it offers Add to an existing friend, which is the exact bug
    // this function exists to prevent.
    expect(linkState("Rhonda", [card("rhonda")], requests())).toBe("friends");
    expect(linkState("  RHONDA  ", [card("rhonda")], requests())).toBe(
      "friends",
    );
    expect(linkState("rhonda", [card("Rhonda")], requests())).toBe("friends");
  });

  it("does not match a handle that merely contains the query", () => {
    // Exact, like the API's own lookup. A substring match would claim you are
    // already friends with `rhonda` because you know `rhonda_bjj`.
    expect(linkState("rhonda", [card("rhonda_bjj")], requests())).toBe("none");
    expect(linkState("rhonda_bjj", [card("rhonda")], requests())).toBe("none");
  });

  it("prefers the request waiting on YOU when somehow both exist", () => {
    // Not reachable through the API today — the friendship table holds one row
    // per pair — but if it were, the actionable one is the one you can answer.
    expect(
      linkState(
        "rhonda",
        [],
        requests({ incoming: [card("rhonda")], outgoing: [card("rhonda")] }),
      ),
    ).toBe("incoming");
  });
});

describe("what the card says about it", () => {
  it("says nothing at all when there is no link, so Add can take the space", () => {
    // `null` is the signal the screen branches on. A string here — even an
    // empty one — would render an empty line where the button belongs.
    expect(linkLabel("none")).toBeNull();
  });

  it("distinguishes the three links rather than collapsing them", () => {
    // Each is a different thing to do next: nothing, answer below, or wait. A
    // single "already linked" would hide which.
    const labels = [
      linkLabel("friends"),
      linkLabel("incoming"),
      linkLabel("outgoing"),
      linkLabel("unknown"),
    ];
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((l) => l !== null && l.length > 0)).toBe(true);
    // Each arm pinned individually. Distinctness plus two spot-checks left
    // `friends` and `unknown` swappable — four different strings stay four
    // different strings however they are shuffled, so "all distinct" is not
    // the same claim as "each one right".
    expect(linkLabel("unknown")).toMatch(/Checking/);
    expect(linkLabel("friends")).toMatch(/Already your friend/);
    expect(linkLabel("incoming")).toMatch(/answer below/);
    expect(linkLabel("outgoing")).toMatch(/Waiting on them/);
  });
});
