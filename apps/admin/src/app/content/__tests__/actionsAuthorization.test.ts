import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every content server action refuses an unauthorized caller — and, the part
 * that matters, WRITES NOTHING when it refuses.
 *
 * ## Why this file exists at all
 *
 * `src/lib/admin.ts`'s own doc comment states the hazard precisely: *"a server
 * action is a POST endpoint the router exposes on its own. Nothing about being
 * defined in a gated route segment protects it — an unauthorized caller who
 * never loads the page can still invoke it."* The gate is therefore one
 * `await assertAdmin()` line per action, and a missing line looks like
 * absolutely nothing: the action compiles, the page renders, the happy path is
 * unaffected, and the only symptom is that a stranger can publish content.
 *
 * This console had 3 test files and none of them touched a write path.
 *
 * ## Why it enumerates instead of listing
 *
 * The obvious version of this test names the ten actions that exist today.
 * That version passes forever while being silently wrong the moment an
 * eleventh is added — which is CLAUDE.md's own recorded lesson, in its words:
 * *"Nine guards mutation-tested, and the tenth did not exist... Testing the
 * guards you wrote says nothing about the one you did not."*
 *
 * So the suite reads the modules' exports at runtime and asserts over ALL of
 * them. A new action is covered the moment it is exported, without anybody
 * remembering this file exists. `EXPECTED_ACTION_COUNT` then guards the
 * enumeration itself — if the count drops, the enumeration broke and is
 * silently asserting over an empty list, which is the "a filter that matched
 * nothing" apparatus trap the same section warns about.
 *
 * ## Why the real gate runs
 *
 * `assertAdmin` is NOT mocked. Only Clerk's `currentUser` is, so the actual
 * allowlist logic in `isAllowedAdmin` executes — a stub of the gate would be a
 * test of the stub, and the repo has already been bitten by a suite that
 * confirmed its own assumption rather than the system's behaviour.
 */

vi.mock("server-only", () => ({}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...a: unknown[]) => revalidatePath(...a),
  revalidateTag: vi.fn(),
}));

const currentUser = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  currentUser: () => currentUser(),
}));

/**
 * Every write the actions can reach. Each is a spy that RECORDS rather than
 * throws, so a gate that failed to stop the call is caught by the call itself
 * having happened — not by an error the action might swallow into a tidy
 * `{ status: "error" }` that looks exactly like a correct refusal.
 */
const apiCalls: string[] = [];
function writeSpy(name: string) {
  return (...args: unknown[]) => {
    apiCalls.push(name);
    return Promise.resolve({ id: "x", name: "x", args });
  };
}

vi.mock("@/lib/api", () => ({
  createTechnique: writeSpy("createTechnique"),
  updateTechnique: writeSpy("updateTechnique"),
  publishTechnique: writeSpy("publishTechnique"),
  retireTechnique: writeSpy("retireTechnique"),
  reactivateTechnique: writeSpy("reactivateTechnique"),
  restoreRevision: writeSpy("restoreRevision"),
  createExercise: writeSpy("createExercise"),
  updateExercise: writeSpy("updateExercise"),
  publishExercise: writeSpy("publishExercise"),
  restoreExerciseRevision: writeSpy("restoreExerciseRevision"),
  getTechnique: writeSpy("getTechnique"),
  getExercise: writeSpy("getExercise"),
  listPositions: writeSpy("listPositions"),
  listExerciseVocabularies: writeSpy("listExerciseVocabularies"),
}));

/** Matches the ten exported today. A DROP means the enumeration broke. */
const EXPECTED_ACTION_COUNT = 10;

type AnyAction = (...args: never[]) => Promise<unknown>;

async function allActions(): Promise<{ name: string; fn: AnyAction }[]> {
  const mods = await Promise.all([import("../actions"), import("../exerciseActions")]);
  const out: { name: string; fn: AnyAction }[] = [];
  for (const m of mods) {
    for (const [name, value] of Object.entries(m)) {
      if (typeof value === "function" && name.endsWith("Action")) {
        out.push({ name, fn: value as AnyAction });
      }
    }
  }
  return out;
}

/**
 * Actions have two shapes — `(prev, form)` and `(id, prev, form)` — so the
 * arguments are supplied positionally-agnostically: an id string first is
 * harmless to the two-argument form, which reads `prev` for an attempt counter
 * it can survive not finding. Calling every action through one shim is what
 * keeps this test from having to know each signature, which is the same
 * staleness the enumeration exists to avoid.
 */
async function invoke(fn: AnyAction): Promise<unknown> {
  const form = new FormData();
  form.set("name", "Anything");
  form.set("id", "some-id");
  try {
    return await (fn as unknown as (...a: unknown[]) => Promise<unknown>)(
      "some-id",
      { status: "idle" },
      form,
    );
  } catch (err) {
    return { threw: err };
  }
}

beforeEach(() => {
  apiCalls.length = 0;
  revalidatePath.mockClear();
  currentUser.mockReset();
  process.env.ADMIN_USER_IDS = "user_real_admin";
});

describe("content server actions — the allowlist is the boundary", () => {
  it("exports the actions this suite believes it is covering", async () => {
    const actions = await allActions();
    // The apparatus check. Without it, a rename that stopped matching the
    // `*Action` suffix would empty the list and every assertion below would
    // pass over nothing at all.
    expect(actions.length).toBe(EXPECTED_ACTION_COUNT);
  });

  it("performs NO write for a signed-out caller", async () => {
    currentUser.mockResolvedValue(null);
    for (const { name, fn } of await allActions()) {
      apiCalls.length = 0;
      await invoke(fn);
      expect({ action: name, wrote: apiCalls }).toEqual({ action: name, wrote: [] });
    }
  });

  it("performs NO write for a signed-in caller who is not on the allowlist", async () => {
    // The likelier real case: a genuine athlete account, correctly signed in
    // to the product, POSTing to an action they found. Clerk is happy; the
    // allowlist is the only thing standing between them and published content.
    currentUser.mockResolvedValue({ id: "user_ordinary_athlete" });
    for (const { name, fn } of await allActions()) {
      apiCalls.length = 0;
      await invoke(fn);
      expect({ action: name, wrote: apiCalls }).toEqual({ action: name, wrote: [] });
    }
  });

  it("does not revalidate any path when it refuses", async () => {
    // A refusal that still calls `revalidatePath` would rebuild pages on
    // demand from an unauthorized POST — the cache side of the same hole.
    currentUser.mockResolvedValue({ id: "user_ordinary_athlete" });
    for (const { fn } of await allActions()) await invoke(fn);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an empty allowlist admits nobody, rather than admitting everyone", async () => {
    // The misconfiguration that fails open: an unset ADMIN_USER_IDS in a new
    // environment. `isAllowedAdmin` splits "" into [""] and filters it out, so
    // the list is empty and every id misses — asserted because "empty means
    // no restriction" is a very common and very quiet way to build this wrong.
    process.env.ADMIN_USER_IDS = "";
    currentUser.mockResolvedValue({ id: "user_real_admin" });
    for (const { name, fn } of await allActions()) {
      apiCalls.length = 0;
      await invoke(fn);
      expect({ action: name, wrote: apiCalls }).toEqual({ action: name, wrote: [] });
    }
  });

  it("lets a real admin through — so the refusals above mean something", async () => {
    // The other half of "verify a check can PASS". Without this, every
    // assertion above would still hold if the actions were broken outright and
    // refused everyone, and the suite would look thorough while proving the
    // gate does nothing but fail.
    currentUser.mockResolvedValue({ id: "user_real_admin" });
    const wrote: string[] = [];
    for (const { fn } of await allActions()) {
      apiCalls.length = 0;
      await invoke(fn);
      wrote.push(...apiCalls);
    }
    expect(wrote.length).toBeGreaterThan(0);
  });
});
