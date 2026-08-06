"use server";

import { revalidatePath } from "next/cache";

import { assertAdmin } from "@/lib/admin";
import {
  ApiError,
  createTechnique,
  publishTechnique,
  updateTechnique,
  type TechniqueWrite,
} from "@/lib/api";

/**
 * What the form renders after a submit.
 *
 * Generic over the write shape because both catalogs use it — the technique and
 * exercise forms share every behaviour that touches this type (restore on a
 * rejected save, re-announce on a repeat) and share none of their fields.
 *
 * `id` on success so the create screen can send the operator to the edit screen
 * for the row it just minted — the id is derived from the name, so seeing
 * it is how you confirm the slug is what you expected.
 */
export type SaveResult<TWrite = TechniqueWrite> =
  | { status: "idle" }
  | { status: "ok"; id: string; name: string }
  /**
   * `values` is what the operator submitted, handed straight back.
   *
   * React 19 RESETS a form after its action completes — uncontrolled fields
   * return to their `defaultValue`. On a rejected save that wiped all
   * seventeen fields and left only the error message, so the console told you
   * the name was taken and simultaneously threw away the paragraph of prose
   * you had just written. Returning the submission lets the form re-seed its
   * defaults with it, so the reset restores rather than erases.
   *
   * `attempt` counts consecutive failures, so the form can re-key the alert: a
   * second failure with the SAME message mutates nothing, so a screen reader
   * stays silent and the only visual change is the button flicking through
   * "Saving…". Counted here rather than in an effect — incrementing state
   * inside one is a cascading render, and the action already receives the
   * previous result, so it is free.
   */
  | { status: "error"; message: string; values: TWrite; attempt: number };

/**
 * Lists arrive from the form as one-per-line text.
 *
 * Blank lines are dropped and entries trimmed, so a trailing newline does not
 * become an empty alias. An empty box is `[]`, not `[""]` — the columns are
 * `TEXT[] NOT NULL` and an empty-string member is a row that renders as a
 * nameless chip in every client.
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
 * PATCH is a partial update on the wire, but sending only the dirty fields is
 * how a console erases prose it never showed. The backend's request type is
 * pointer-per-field precisely because an earlier version of that mistake wiped
 * fourteen columns; this sends the full form so the question never arises.
 */
function bodyFrom(form: FormData): TechniqueWrite {
  return {
    name: text(form.get("name")),
    aliases: lines(form.get("aliases")),
    category: text(form.get("category")),
    function: text(form.get("function")),
    position: text(form.get("position")),
    position_detail: text(form.get("position_detail")),
    to_position: text(form.get("to_position")),
    gi_no_gi: text(form.get("gi_no_gi")),
    typical_belt: text(form.get("typical_belt")),
    description: text(form.get("description")),
    when_to_use: text(form.get("when_to_use")),
    setup_from: lines(form.get("setup_from")),
    common_next_moves: lines(form.get("common_next_moves")),
    common_counters: lines(form.get("common_counters")),
    video_reference: text(form.get("video_reference")),
    source_notes: text(form.get("source_notes")),
    ibjjf_ruleset_id: text(form.get("ibjjf_ruleset_id")),
  };
}

/**
 * Turns a failed write into something an operator can act on.
 *
 * The API's validation messages name the offending field and the legal set, and
 * that is the whole point of showing them: eighteen fields, and "invalid input"
 * alone means guessing which one. Branching is on `code`, never on the message.
 */
function explain(err: unknown): string {
  // The only write surface in this console. Without this, a Clerk
  // misconfiguration or a bug in bodyFrom shows the operator "could not reach
  // the API" and leaves nothing on the server to search for.
  console.error("admin: technique write failed", err);
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      return "The API rejected this account. Check ADMIN_USER_IDS matches on both sides.";
    }
    return err.detail || `The API responded ${err.status}.`;
  }
  if (err instanceof Error && err.message === "Not authorized.") {
    return "Not authorized.";
  }
  // Never surface a raw internal error: it can carry infrastructure detail, and
  // an operator cannot act on it anyway.
  return "Could not reach the API. Is it running?";
}

export async function createTechniqueAction(
  prev: SaveResult,
  form: FormData,
): Promise<SaveResult> {
  try {
    await assertAdmin();
    const saved = await createTechnique(bodyFrom(form));
    // The list is server-rendered with `cache: "no-store"`, but the route
    // segment itself is still cached — without this the operator lands back on
    // a list that does not show what they just wrote.
    revalidatePath("/content");
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

/**
 * Publishing has its OWN result type rather than reusing SaveResult.
 *
 * SaveResult's error variant carries `values` so a rejected save can re-seed
 * the form React 19 has just reset. Publish submits no fields, so there is
 * nothing to preserve and nothing to hand back — forcing it into that shape
 * would mean inventing an empty `values` whose only purpose is satisfying a
 * type, which is how a comment ends up explaining a lie.
 */
export type PublishResult =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; message: string };

/**
 * Publishing is its own action for the same reason it is its own endpoint: it
 * is a decision, not a field. Nothing about the edit form can trigger it.
 */
export async function publishTechniqueAction(
  id: string,
  _prev: PublishResult,
  _form: FormData,
): Promise<PublishResult> {
  try {
    await assertAdmin();
    await publishTechnique(id);
    revalidatePath("/content");
    revalidatePath(`/content/${id}`);
    return { status: "ok" };
  } catch (err) {
    return { status: "error", message: explain(err) };
  }
}

export async function updateTechniqueAction(
  id: string,
  prev: SaveResult,
  form: FormData,
): Promise<SaveResult> {
  try {
    await assertAdmin();
    const saved = await updateTechnique(id, bodyFrom(form));
    revalidatePath("/content");
    revalidatePath(`/content/${id}`);
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
