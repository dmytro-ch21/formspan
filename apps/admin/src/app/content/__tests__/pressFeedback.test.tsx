/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { PublishResult } from "../actions";
import { PublishButton } from "../PublishButton";
import { ReactivateButton } from "../ReactivateButton";
import { RetireButton } from "../RetireButton";

/**
 * L14 — the console's three irreversible writes carry the press rule.
 *
 * What the rule DOES is asserted against the stylesheet in
 * `app/__tests__/reducedMotion.test.ts`, because jsdom computes neither
 * `:active` nor the cascade — a render test cannot see a scale. What only a
 * render can prove is that the class actually reaches the rendered button:
 * a rule nothing applies is the same defect as no rule.
 *
 * Deliberately not re-testing the in-flight state. All three already had it
 * (`useActionState` → `disabled={pending}`) before L14, and L14 does not touch
 * it — the ticket's premise that it was missing was wrong, and a test here
 * would imply this change added it.
 */

afterEach(cleanup);

const noop = (async () => ({ status: "ok" })) as unknown as (
  prev: PublishResult,
  form: FormData,
) => Promise<PublishResult>;

describe("L14 — press acknowledgement reaches the rendered button", () => {
  it("Publish carries .pressable", () => {
    render(<PublishButton action={noop} />);
    expect(screen.getByRole("button", { name: "Publish" }).className.split(/\s+/)).toContain("pressable");
  });

  it("Retire carries .pressable", () => {
    render(<RetireButton action={noop} />);
    expect(screen.getByRole("button", { name: "Retire" }).className.split(/\s+/)).toContain("pressable");
  });

  it("Reactivate carries .pressable", () => {
    render(<ReactivateButton action={noop} />);
    expect(screen.getByRole("button", { name: "Reactivate" }).className.split(/\s+/)).toContain("pressable");
  });
});
