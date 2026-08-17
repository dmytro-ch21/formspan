"use server";

import { revalidatePath } from "next/cache";

import { assertAdmin } from "@/lib/admin";
import {
  ApiError,
  createExercise,
  publishExercise,
  restoreExerciseRevision,
  updateExercise,
  type ExerciseWrite,
} from "@/lib/api";
import type { PublishResult, SaveResult } from "./actions";
import { revisionFrom } from "./revisionForm";

type ExerciseResult = SaveResult<ExerciseWrite>;

/**
 * The exercise half of the write path. Same shape as `actions.ts`, and
 * separate rather than generic because the two bodies share no fields — a
 * `bodyFrom` that handled both would be a switch pretending to be a function.
 *
 * These are their own endpoints and check `assertAdmin` themselves. A server
 * action is a POST the router exposes independently of the page it was declared
 * beside, so neither `proxy.ts` nor the layout protects it.
 */

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function text(value: FormDataEntryValue | null): string {
  return String(value ?? "").trim();
}

/**
 * The whole form, every field, on every save.
 *
 * `media` is deliberately absent — the request type has no such field, which is
 * what guarantees an edit cannot clear media a deploy added.
 */
function bodyFrom(form: FormData): ExerciseWrite {
  return {
    name: text(form.get("name")),
    sport: text(form.get("sport")),
    movement_pattern: text(form.get("movement_pattern")),
    movement_pattern_detail: text(form.get("movement_pattern_detail")),
    primary_muscles: lines(form.get("primary_muscles")),
    secondary_muscles: lines(form.get("secondary_muscles")),
    equipment: lines(form.get("equipment")),
    load_type: text(form.get("load_type")),
    // Always sent, like every other field here — the select has a value in both
    // states, so there is no unchecked-box ambiguity to handle. The API would
    // preserve the stored value if this were omitted, but this action's whole
    // contract is "the whole form, every save", and relying on the server's
    // merge instead would make the console the one caller whose behaviour
    // depends on a field being absent.
    load_mode: text(form.get("load_mode")),
    // Number, not text: the API types this as an integer enum and a string
    // would be rejected. Falls back to 1, which is both the column default and
    // the right answer for the overwhelming majority.
    implements: Number(form.get("implements")) === 2 ? 2 : 1,
    // `has`, not `=== "on"`. An unchecked box sends nothing, so presence IS the
    // value — and comparing to the browser's default string breaks silently the
    // moment someone adds a `value` attribute for styling, writing false for
    // every checked box with no error anywhere. It also makes this action, which
    // is a POST endpoint in its own right, agree with a non-browser caller.
    is_unilateral: form.has("is_unilateral"),
    instructions: text(form.get("instructions")),
  };
}

function explain(err: unknown): string {
  console.error("admin: exercise write failed", err);
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      return "The API rejected this account. Check ADMIN_USER_IDS matches on both sides.";
    }
    return err.detail || `The API responded ${err.status}.`;
  }
  if (err instanceof Error && err.message === "Not authorized.") {
    return "Not authorized.";
  }
  return "Could not reach the API. Is it running?";
}

export async function createExerciseAction(
  prev: ExerciseResult,
  form: FormData,
): Promise<ExerciseResult> {
  try {
    await assertAdmin();
    const saved = await createExercise(bodyFrom(form));
    revalidatePath("/content/exercises");
    return { status: "ok", id: saved.id, name: saved.name };
  } catch (err) {
    return {
      status: "error",
      message: explain(err),
      values: bodyFrom(form),
      attempt: (prev.status === "error" ? prev.attempt : 0) + 1,
    };
  }
}

export async function publishExerciseAction(
  id: string,
  _prev: PublishResult,
  _form: FormData,
): Promise<PublishResult> {
  try {
    await assertAdmin();
    await publishExercise(id);
    revalidatePath("/content/exercises");
    revalidatePath(`/content/exercises/${id}`);
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: explain(err) };
  }
}

/** Same split as the technique restore — see `revisionForm.ts`. */
export async function restoreExerciseRevisionAction(
  id: string,
  _prev: PublishResult,
  form: FormData,
): Promise<PublishResult> {
  try {
    await assertAdmin();
    const revision = revisionFrom(form);
    if (revision === null) {
      return { status: "error", message: "That restore button sent no revision." };
    }
    await restoreExerciseRevision(id, revision);
    revalidatePath("/content/exercises");
    revalidatePath(`/content/exercises/${id}`);
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: explain(err) };
  }
}

export async function updateExerciseAction(
  id: string,
  prev: ExerciseResult,
  form: FormData,
): Promise<ExerciseResult> {
  try {
    await assertAdmin();
    const saved = await updateExercise(id, bodyFrom(form));
    revalidatePath("/content/exercises");
    revalidatePath(`/content/exercises/${id}`);
    return { status: "ok", id: saved.id, name: saved.name };
  } catch (err) {
    return {
      status: "error",
      message: explain(err),
      values: bodyFrom(form),
      attempt: (prev.status === "error" ? prev.attempt : 0) + 1,
    };
  }
}
