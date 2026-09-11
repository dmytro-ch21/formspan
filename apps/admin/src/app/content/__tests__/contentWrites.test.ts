import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What each content write actually SENDS, and what a rejected one gives back
 * to the operator — N170/#547.
 *
 * `actionsAuthorization.test.ts` proves nobody unauthorized gets through.
 * This file proves that what does get through carries the right payload, and
 * that a refusal is something the operator can act on.
 *
 * ## Why these assertions and not others
 *
 * `bodyFrom` in both action files is a dense run of deliberate decisions, each
 * carrying a comment that names a specific silent failure — a malformed
 * `implements` fabricating a valid `1` and halving a stored pair; a checkbox
 * read by string comparison that writes `false` the moment somebody adds a
 * `value` attribute; `media` omitted so an edit cannot clear assets a deploy
 * attached. Every one of those is a data-loss path with a stated mechanism and,
 * until this file, no test. CLAUDE.md's backend section records the same class
 * three times over (`load_mode`, `implements`, `note` each blanked authored
 * data through a restore path) and says plainly: all three were caught in
 * review, none by the suite.
 *
 * These run through the ACTION rather than against `bodyFrom` directly — which
 * is not exported, and more importantly is not the thing at risk. The ticket
 * asks for tests that prove "the Next server action is correctly wired and
 * guarded", and a helper tested in isolation proves nothing about what the
 * endpoint sends.
 */

vi.mock("server-only", () => ({}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a), revalidateTag: vi.fn() }));

const currentUser = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({ currentUser: () => currentUser() }));

/** Recorded calls: [fn name, ...args]. */
const calls: { fn: string; args: unknown[] }[] = [];
let nextFailure: unknown = null;

function api(name: string) {
  return (...args: unknown[]) => {
    calls.push({ fn: name, args });
    if (nextFailure) return Promise.reject(nextFailure);
    return Promise.resolve({ id: "slug-from-name", name: String(args[0] ?? "x") });
  };
}

/** The real ApiError, so `explain`'s `instanceof` branch is exercised rather
 *  than a look-alike that would quietly take the fallback path. */
class ApiError extends Error {
  status: number;
  detail?: string;
  constructor(status: number, detail?: string) {
    super(`api ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

vi.mock("@/lib/api", () => ({
  ApiError,
  createTechnique: api("createTechnique"),
  updateTechnique: api("updateTechnique"),
  publishTechnique: api("publishTechnique"),
  retireTechnique: api("retireTechnique"),
  reactivateTechnique: api("reactivateTechnique"),
  restoreRevision: api("restoreRevision"),
  createExercise: api("createExercise"),
  updateExercise: api("updateExercise"),
  publishExercise: api("publishExercise"),
  restoreExerciseRevision: api("restoreExerciseRevision"),
}));

const ADMIN = "user_real_admin";

function exerciseForm(over: Record<string, string> = {}, omit: string[] = []): FormData {
  const base: Record<string, string> = {
    name: "Back Squat",
    sport: "strength",
    movement_pattern: "squat",
    movement_pattern_detail: "",
    primary_muscles: "quads\nglutes",
    secondary_muscles: "",
    equipment: "barbell",
    load_type: "external",
    load_mode: "bilateral",
    implements: "1",
    instructions: "Brace, sit down between your hips.",
    note: "",
    ...over,
  };
  const f = new FormData();
  for (const [k, v] of Object.entries(base)) if (!omit.includes(k)) f.set(k, v);
  return f;
}

beforeEach(() => {
  calls.length = 0;
  nextFailure = null;
  revalidatePath.mockClear();
  currentUser.mockReset().mockResolvedValue({ id: ADMIN });
  process.env.ADMIN_USER_IDS = ADMIN;
});

const sent = (fn: string) => calls.find((c) => c.fn === fn)?.args;

describe("exercise writes — the payload is the product", () => {
  it("a create sends every field the form carries", async () => {
    const { createExerciseAction } = await import("../exerciseActions");
    const res = await createExerciseAction({ status: "idle" }, exerciseForm());
    expect(res.status).toBe("ok");
    expect(sent("createExercise")?.[0]).toMatchObject({
      name: "Back Squat",
      sport: "strength",
      primary_muscles: ["quads", "glutes"],
      equipment: ["barbell"],
      is_unilateral: false,
    });
  });

  it("NEVER sends `media` — the field that would clear assets a deploy attached", async () => {
    const { updateExerciseAction } = await import("../exerciseActions");
    const form = exerciseForm();
    // Even when a caller pushes one in: this is a POST endpoint, so a
    // non-browser caller can send anything. The absence must come from the
    // request shape, not from the form not having the input.
    form.set("media", "https://example.com/evil.mp4");
    await updateExerciseAction("ex-1", { status: "idle" }, form);
    expect(Object.keys(sent("updateExercise")?.[1] as object)).not.toContain("media");
  });

  it("a malformed `implements` goes out as NaN, not as a fabricated 1", async () => {
    // The documented trap: `=== 2 ? 2 : 1` reads identically from the rendered
    // form and fails OPEN — a malformed submission writes a valid 1 and
    // silently halves a stored pair. NaN serialises to null, which the API
    // reads as absent and leaves the stored value alone.
    const { updateExerciseAction } = await import("../exerciseActions");
    await updateExerciseAction("ex-1", { status: "idle" }, exerciseForm({ implements: "banana" }));
    const body = sent("updateExercise")?.[1] as { implements: number };
    expect(Number.isNaN(body.implements)).toBe(true);
    expect(body.implements).not.toBe(1);
  });

  it("a real pair still goes out as 2", async () => {
    const { updateExerciseAction } = await import("../exerciseActions");
    await updateExerciseAction("ex-1", { status: "idle" }, exerciseForm({ implements: "2" }));
    expect((sent("updateExercise")?.[1] as { implements: number }).implements).toBe(2);
  });

  it("`is_unilateral` is presence, not the string \"on\"", async () => {
    // A `value` attribute added for styling would break a `=== "on"` read and
    // write false for every checked box, with no error anywhere.
    const { updateExerciseAction } = await import("../exerciseActions");
    await updateExerciseAction("ex-1", { status: "idle" }, exerciseForm({ is_unilateral: "yes-styled" }));
    expect((sent("updateExercise")?.[1] as { is_unilateral: boolean }).is_unilateral).toBe(true);
  });

  it("an emptied note CLEARS it, rather than being dropped from the request", async () => {
    // Deliberate and the opposite of `media`: the field is on the form and
    // rendered with its stored value, so "empty" is something the author saw.
    const { updateExerciseAction } = await import("../exerciseActions");
    await updateExerciseAction("ex-1", { status: "idle" }, exerciseForm({ note: "   " }));
    const body = sent("updateExercise")?.[1] as Record<string, unknown>;
    expect(body).toHaveProperty("note");
    expect(body.note).toBe("");
  });

  it("blank lines in a list never become nameless entries", async () => {
    const { createExerciseAction } = await import("../exerciseActions");
    await createExerciseAction({ status: "idle" }, exerciseForm({ primary_muscles: "quads\n\n  \nglutes\n" }));
    expect((sent("createExercise")?.[0] as { primary_muscles: string[] }).primary_muscles).toEqual([
      "quads",
      "glutes",
    ]);
  });
});

describe("publish and lifecycle", () => {
  it("publishing an exercise revalidates both the list and the detail page", async () => {
    const { publishExerciseAction } = await import("../exerciseActions");
    const res = await publishExerciseAction("ex-1", { status: "idle" }, new FormData());
    expect(res.status).toBe("ok");
    expect(revalidatePath).toHaveBeenCalledWith("/content/exercises");
    expect(revalidatePath).toHaveBeenCalledWith("/content/exercises/ex-1");
  });

  it("technique create, publish, retire and reactivate each reach their own endpoint", async () => {
    const a = await import("../actions");
    const form = new FormData();
    form.set("name", "Armbar from guard");
    await a.createTechniqueAction({ status: "idle" }, form);
    await a.publishTechniqueAction("t-1", { status: "idle" }, new FormData());
    await a.retireTechniqueAction("t-1", { status: "idle" }, new FormData());
    await a.reactivateTechniqueAction("t-1", { status: "idle" }, new FormData());
    expect(calls.map((c) => c.fn)).toEqual([
      "createTechnique",
      "publishTechnique",
      "retireTechnique",
      "reactivateTechnique",
    ]);
  });
});

describe("revision restore — the path that has blanked data three times", () => {
  it("restores the revision named in the form field", async () => {
    const { restoreExerciseRevisionAction } = await import("../exerciseActions");
    const form = new FormData();
    form.set("revision", "3");
    const res = await restoreExerciseRevisionAction("ex-1", { status: "idle" }, form);
    expect(res.status).toBe("ok");
    expect(sent("restoreExerciseRevision")).toEqual(["ex-1", 3]);
  });

  it("a missing or non-numeric revision writes NOTHING", async () => {
    // `revisionFrom` returns null rather than throwing so the caller can say
    // what happened — and the point is that a NaN must never travel as the
    // literal path segment "NaN" and come back a meaningless 404.
    const { restoreExerciseRevisionAction } = await import("../exerciseActions");
    for (const bad of [undefined, "", "NaN", "0", "-2", "1.5", "three"]) {
      calls.length = 0;
      const form = new FormData();
      if (bad !== undefined) form.set("revision", bad);
      const res = await restoreExerciseRevisionAction("ex-1", { status: "idle" }, form);
      expect({ bad, status: res.status, wrote: calls.map((c) => c.fn) }).toEqual({
        bad,
        status: "error",
        wrote: [],
      });
    }
  });

  it("the id comes from the page, never from the submitted form", async () => {
    // Stated in `revisionForm.ts`: "nothing a client sends may decide which row
    // gets written." A form field named `id` must not be able to redirect the
    // restore at another row.
    const { restoreExerciseRevisionAction } = await import("../exerciseActions");
    const form = new FormData();
    form.set("revision", "2");
    form.set("id", "some-other-exercise");
    await restoreExerciseRevisionAction("ex-1", { status: "idle" }, form);
    expect(sent("restoreExerciseRevision")?.[0]).toBe("ex-1");
  });
});

describe("a rejected write is something the operator can act on", () => {
  it("a 403 names the likely misconfiguration rather than saying \"failed\"", async () => {
    nextFailure = new ApiError(403);
    const { publishExerciseAction } = await import("../exerciseActions");
    const res = await publishExerciseAction("ex-1", { status: "idle" }, new FormData());
    expect(res.status).toBe("error");
    expect(res.status === "error" && res.message).toMatch(/ADMIN_USER_IDS/);
  });

  it("the API's own detail is surfaced when it sends one", async () => {
    nextFailure = new ApiError(400, "name is already taken");
    const { createExerciseAction } = await import("../exerciseActions");
    const res = await createExerciseAction({ status: "idle" }, exerciseForm());
    expect(res.status === "error" && res.message).toBe("name is already taken");
  });

  it("an unreachable API says so, instead of blaming the payload", async () => {
    nextFailure = new TypeError("fetch failed");
    const { createExerciseAction } = await import("../exerciseActions");
    const res = await createExerciseAction({ status: "idle" }, exerciseForm());
    expect(res.status === "error" && res.message).toMatch(/Could not reach the API/);
  });

  it("a rejected save hands the submission back, so React 19's form reset restores it", async () => {
    // Without `values`, the reset wipes every field and the console tells you
    // the name is taken while throwing away the prose you just wrote.
    nextFailure = new ApiError(400, "taken");
    const { createExerciseAction } = await import("../exerciseActions");
    const res = await createExerciseAction({ status: "idle" }, exerciseForm({ instructions: "Long prose." }));
    expect(res.status === "error" && res.values).toMatchObject({ instructions: "Long prose." });
  });

  it("consecutive failures increment `attempt`, so a repeat message is re-announced", async () => {
    nextFailure = new ApiError(400, "taken");
    const { createExerciseAction } = await import("../exerciseActions");
    const first = await createExerciseAction({ status: "idle" }, exerciseForm());
    const second = await createExerciseAction(first, exerciseForm());
    expect(first.status === "error" && first.attempt).toBe(1);
    expect(second.status === "error" && second.attempt).toBe(2);
  });

  it("a failed write revalidates nothing", async () => {
    nextFailure = new ApiError(500);
    const { publishExerciseAction } = await import("../exerciseActions");
    await publishExerciseAction("ex-1", { status: "idle" }, new FormData());
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
