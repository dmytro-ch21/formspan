/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RevisionHistory } from "../RevisionHistory";
import type { PublishResult } from "../actions";

/**
 * What the operator actually SEES — N170/#547, review round two.
 *
 * The action-level suites prove a refusal returns the right shape and a
 * restore sends the right revision. Neither proves the operator ever sees any
 * of it, and the ticket's own Steps to test are explicit about the difference:
 * *"the failure renders as a real error state the console operator can act on,
 * and is asserted by a test."* `ac-verifier` named the same gap, plus
 * `RevisionHistory`'s "no restore on the newest revision" rule, which had no
 * coverage of any kind.
 *
 * **This is the first render test in `apps/web` or `apps/admin`.** CLAUDE.md
 * records the standing gap as "0 of 40 web/admin pages have a test that renders
 * them", and `vitest.config.mts` deliberately had no jsdom, on the argument
 * that no defect had lived in the render path. That argument was reasonable
 * and is also the one that held right up until three columns were blanked by a
 * restore path with no test watching.
 *
 * Kept to the two behaviours that carry a rule. This is not a licence to
 * snapshot the console.
 */

afterEach(cleanup);

const noop = (async () => ({ status: "ok" })) as unknown as (
  prev: PublishResult,
  form: FormData,
) => Promise<PublishResult>;

function revision(n: number, name: string) {
  return {
    revision: n,
    actor: "user_admin",
    created_at: "2026-09-01T10:00:00Z",
    payload: { name },
  } as never;
}

describe("RevisionHistory — the newest revision offers no restore", () => {
  it("renders a restore control for every entry EXCEPT the newest", () => {
    // The rule, in the component's own words: the newest "is already the
    // current state, so the button would do nothing but add a revision saying
    // so." An off-by-one here (`i >= 0`) is invisible in review and produces a
    // button that silently writes a no-op revision into the audit trail.
    render(
      <RevisionHistory
        revisions={[revision(3, "Newest"), revision(2, "Middle"), revision(1, "Oldest")]}
        restore={noop}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: /restore/i });
    expect(buttons).toHaveLength(2);
  });

  it("a single-revision history offers no restore at all", () => {
    render(<RevisionHistory revisions={[revision(1, "Only")]} restore={noop} />);
    expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
  });

  it("an empty history explains itself rather than rendering a bare list", () => {
    // "No history" and "history failed to load" look identical as an empty
    // list, and only one of them is normal. The shipped catalog has none.
    render(<RevisionHistory revisions={[]} restore={noop} />);
    expect(screen.getByText(/No history yet/i)).toBeTruthy();
    expect(screen.queryByRole("listitem")).toBeNull();
  });
});

/**
 * The forms call `useActionState`, which owns the result — so rather than
 * driving a real submission through React's action plumbing (which needs a
 * server reference), the hook is stubbed to return the state under test. What
 * is being asserted is the RENDER BRANCH: given an error result, does the
 * operator get something they can act on.
 */
const actionState = vi.hoisted(() => ({ current: { status: "idle" } as unknown }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useActionState: () => [actionState.current, vi.fn(), false],
  };
});

vi.mock("@/lib/api", () => ({ ApiError: class extends Error {} }));

const VOCAB = {
  sports: ["strength", "running"],
  movement_patterns: ["squat", "hinge"],
  load_types: ["external", "bodyweight"],
};

async function renderExerciseForm(state: unknown) {
  actionState.current = state;
  const { ExerciseForm } = await import("../ExerciseForm");
  return render(<ExerciseForm vocabularies={VOCAB} action={noop as never} mode="create" />);
}

describe("a rejected save is on screen, not just in the result object", () => {
  const rejected = {
    status: "error",
    message: "name is already taken",
    values: { name: "Back Squat", instructions: "Brace, then sit down." },
    attempt: 1,
  };

  it("renders the API's reason in an alert the screen reader announces", async () => {
    await renderExerciseForm(rejected);
    expect(screen.getByRole("alert").textContent).toBe("name is already taken");
  });

  it("re-seeds the form with the submission, so React 19's reset restores rather than erases", async () => {
    // The documented failure: React 19 resets an uncontrolled form once its
    // action completes, so a refusal that did not hand the submission back
    // wiped every field and left only the error — telling the operator the
    // name was taken while throwing away the paragraph they had just written.
    //
    // Rendered fresh rather than leaning on the previous test's DOM: a test
    // that depends on another having run is one that passes or fails by
    // ordering, which is its own kind of apparatus that cannot be trusted.
    await renderExerciseForm(rejected);
    expect(screen.getByDisplayValue("Back Squat")).toBeTruthy();
    expect(screen.getByDisplayValue("Brace, then sit down.")).toBeTruthy();
  });

  it("shows no alert at all in the idle state", async () => {
    await renderExerciseForm({ status: "idle" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
