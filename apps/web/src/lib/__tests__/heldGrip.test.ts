import { describe, expect, it } from "vitest";

import { GRIPS, type Grip } from "@/lib/api";
import { heldGripLabel } from "@/lib/heldGrip";

/**
 * F27 (#715): a finished session's set table dropped nothing, but the grip it
 * printed was a three-letter short nobody found. These pin what the read-only
 * row reads; `app/dashboard/sessions/__tests__/finishedGripWiring.test.ts`
 * pins that the row reads it.
 */
describe("the grip a finished set was held in", () => {
  it("prints the full word", () => {
    expect(heldGripLabel("reverse")).toBe("Reverse");
  });

  it("uses the label, not the short, for every grip the server defines", () => {
    for (const g of GRIPS) {
      expect(heldGripLabel(g.key)).toBe(g.label);
    }
  });

  it("prints nothing for a set that recorded no grip", () => {
    expect(heldGripLabel(null)).toBeNull();
    expect(heldGripLabel(undefined)).toBeNull();
  });

  it("prints a grip this build does not know as its own id", () => {
    expect(heldGripLabel("mixed_left" as Grip)).toBe("mixed_left");
  });
});
