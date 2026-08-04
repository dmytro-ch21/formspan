"use client";

import React, { useActionState, useState } from "react";
import Link from "next/link";

import type { Technique } from "@/lib/api";
import { previewSlug } from "@/lib/slug";
import type { SaveResult } from "./actions";

/**
 * The nine the importer knows.
 *
 * A SELECT rather than a text box, and this is the one place the console is
 * deliberately stricter than the API. `ValidateFields` does not constrain
 * `category` — the comment there says the vocabulary is still settling — but
 * `derive_function` in scripts/import-exercise-catalog.py exits on anything
 * outside these nine. Before the console existed, authored content never
 * reached the importer; now it does, so a technique filed as "Guard Pass"
 * would seed, render and export perfectly and then break the next spreadsheet
 * re-import, long after anyone connects the two.
 *
 * If the vocabulary really does move, it moves in the importer first.
 */
const CATEGORIES = [
  "Control/Pin",
  "Escape",
  "Guard Retention",
  "Other",
  "Pass",
  "Submission",
  "Sweep",
  "Takedown",
  "Transition",
] as const;

/** The queryable verb. Empty is legal and means "not a technique" — the
 *  breakfalls and the grappling stance are library content with no verb. */
const FUNCTIONS = ["advance", "reverse", "escape", "control", "finish"] as const;

const GI_NO_GI = ["Both", "Gi Only", "No-Gi Only"] as const;

/** Advisory — "commonly taught from", never a rule. It sits beside IBJJF
 *  legality, which is a rule you can be disqualified for breaking. */
const BELTS = ["White", "Blue", "Purple", "Brown", "Black"] as const;

/**
 * Renders the current value as an extra option when the vocabulary does not
 * contain it.
 *
 * Without this a `<select>` falls back to its first non-disabled option, so a
 * technique stored with a category this list has never heard of would display
 * as something else entirely — and because the form always sends every field,
 * the next save would write that substitution to the database. The API allows
 * values the console does not offer (`ValidateFields` constrains `gi_no_gi` and
 * `function` but deliberately not `category` or `typical_belt`), so this is
 * reachable by anything that writes over the API directly.
 *
 * Showing it is the honest option: the operator sees what is actually stored
 * and can decide, rather than having it quietly replaced.
 */
function withCurrent(options: readonly string[], current: string | undefined): string[] {
  if (!current || options.includes(current)) return [...options];
  return [current, ...options];
}

const inputClass =
  "w-full rounded-[10px] border border-border-strong bg-card px-3 py-2 text-[13.5px] text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark";

/**
 * The hint carries the load-bearing semantics on this screen — "the id can
 * never be changed afterwards", "empty means not recorded, never goes
 * nowhere" — so it is wired to the control with `aria-describedby` rather than
 * left as adjacent text. Without it a screen-reader user tabbing the form hears
 * seventeen labels and none of the reasoning.
 */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  const hintID = `${htmlFor}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="font-barlow-condensed text-[10px] font-bold tracking-[0.14em] text-text-muted uppercase"
      >
        {label}
      </label>
      {hint
        ? React.isValidElement<{ "aria-describedby"?: string }>(children)
          ? React.cloneElement(children, { "aria-describedby": hintID })
          : children
        : children}
      {hint && (
        <p id={hintID} className="text-[11.5px] text-text-secondary">
          {hint}
        </p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
      <h2 className="font-barlow-condensed text-[13px] font-bold tracking-[0.12em] uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The name, and the id that follows from it.
 *
 * Its own component because the slug preview needs state and the parent must be
 * able to reset that state by remounting — see the `key` at the call site.
 */
function NameField({
  mode,
  initialName,
  storedID,
}: {
  mode: "create" | "edit";
  initialName: string;
  storedID?: string;
}) {
  const [name, setName] = useState(initialName);
  return (
    <>
      <Field
        label="Name"
        htmlFor="name"
        hint={
          mode === "create"
            ? "The id is derived from this and can never be changed afterwards — it becomes a foreign key in athletes' training records."
            : "Renaming is safe: the id stays as it is, so existing training records keep pointing at this technique."
        }
      >
        <input
          id="name"
          name="name"
          required
          maxLength={200}
          defaultValue={initialName}
          onChange={(e) => setName(e.target.value)}
          placeholder="São Paulo Pass"
          className={inputClass}
        />
      </Field>

      {mode === "create" ? (
        <p className="text-[12px] text-text-secondary">
          Id preview: <code className="font-mono text-text">{previewSlug(name) || "—"}</code>{" "}
          <span className="text-text-muted">
            (a preview — the API derives the real one, and it is shown after saving)
          </span>
        </p>
      ) : (
        <p className="text-[12px] text-text-secondary">
          Id: <code className="font-mono text-text">{storedID}</code>{" "}
          <span className="text-text-muted">(permanent)</span>
        </p>
      )}
    </>
  );
}

export function TechniqueForm({
  positions,
  action,
  initial,
  mode,
}: {
  positions: string[];
  action: (prev: SaveResult, form: FormData) => Promise<SaveResult>;
  initial?: Technique;
  mode: "create" | "edit";
}) {
  const [result, submit, pending] = useActionState<SaveResult, FormData>(action, {
    status: "idle",
  });

  /**
   * What the fields default to.
   *
   * After a REJECTED save this is the submission itself, not the stored row.
   * React 19 resets an uncontrolled form once its action completes, so without
   * this a 409 on the name wiped every other field the operator had filled in —
   * it told you what was wrong and threw away the work in the same render. The
   * reset still happens; it now restores what was typed.
   *
   * Each `<select>` additionally carries a `key` derived from its own value.
   * Text inputs pick up a changed `defaultValue` on re-render; a select does
   * not — React applies a select\'s default by marking the matching option at
   * MOUNT, so after the reset it fell back to the placeholder while every text
   * field around it restored correctly. Keying on the value remounts just that
   * select when its default actually changes, which is only on an error render:
   * during ordinary editing the key is stable, so nothing remounts underneath
   * someone mid-selection.
   */
  const shown: Partial<Technique> =
    result.status === "error" ? result.values : (initial ?? {});

  return (
    <form action={submit} className="flex flex-col gap-6">
      {result.status === "error" && (
        <p
          key={result.attempt}
          ref={(el) => {
            // Focus on mount. The alert sits at the top of a seven-section form
            // whose submit button is at the bottom, so without this a rejected
            // save looks like nothing happened on a normal viewport. Re-keying
            // on `attempt` remounts it, so an identical repeat re-announces
            // and re-scrolls too.
            el?.focus();
          }}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-[13px] text-danger-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger-text"
        >
          {result.message}
        </p>
      )}
      {result.status === "ok" && (
        <p
          role="status"
          className="rounded-lg border border-border bg-success-bg px-4 py-3 text-[13px] text-success-text"
        >
          Saved <strong>{result.name}</strong> as{" "}
          <code className="font-mono">{result.id}</code>.{" "}
          {mode === "create" ? (
            <>
              <Link href={`/content/${result.id}`} className="underline">
                Open it
              </Link>{" "}
              or{" "}
              <Link href="/content" className="underline">
                back to the list
              </Link>
              . It is live in the catalog now — run{" "}
              <code className="font-mono">cmd/exportcontent</code> to carry it into the seed
              files so a deploy keeps it.
            </>
          ) : (
            <>
              Still <code className="font-mono">source=admin</code>, so the next deploy will
              not revert it — and will not carry it either until it is exported.
            </>
          )}
        </p>
      )}

      <Section title="Identity">
        <NameField
          // Remounts when the outcome changes, which is what resets the slug
          // preview after a successful create. React clears the input on reset
          // but cannot clear component state, so without the key the form ends
          // up showing an empty Name above "Id preview: sao-paulo-pass" — a
          // state that lies. Keyed rather than reset in an effect, because
          // setState inside one is a cascading render.
          key={result.status === "ok" ? `saved-${result.id}` : `editing-${result.status}`}
          mode={mode}
          initialName={shown.name ?? ""}
          storedID={initial?.id}
        />

        <Field
          label="Aliases"
          htmlFor="aliases"
          hint="One per line. What people actually call it — this is how search finds a technique nobody knows the formal name of."
        >
          <textarea
            id="aliases"
            name="aliases"
            rows={3}
            defaultValue={(shown.aliases ?? []).join("\n")}
            placeholder={"Tozi pass\nWilson guard pass"}
            className={inputClass}
          />
        </Field>
      </Section>

      <Section title="Classification">
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Category"
            htmlFor="category"
            hint="The colloquial label a coach would say."
          >
            <select
              key={`category-${shown.category ?? ""}`}
              id="category"
              name="category"
              required
              defaultValue={shown.category ?? ""}
              className={inputClass}
            >
              <option value="" disabled>
                Pick one…
              </option>
              {withCurrent(CATEGORIES, shown.category).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Function"
            htmlFor="function"
            hint="What it does. Leave empty for movement fundamentals, which have no verb."
          >
            <select
              key={`function-${shown.function ?? ""}`}
              id="function"
              name="function"
              defaultValue={shown.function ?? ""}
              className={inputClass}
            >
              <option value="">— none —</option>
              {withCurrent(FUNCTIONS, shown.function).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Gi / No-Gi" htmlFor="gi_no_gi">
            <select
              key={`gi_no_gi-${shown.gi_no_gi ?? "Both"}`}
              id="gi_no_gi"
              name="gi_no_gi"
              required
              defaultValue={shown.gi_no_gi ?? "Both"}
              className={inputClass}
            >
              {withCurrent(GI_NO_GI, shown.gi_no_gi).map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Typical belt"
            htmlFor="typical_belt"
            hint="Commonly taught from — advisory, not a rule."
          >
            <select
              key={`typical_belt-${shown.typical_belt ?? ""}`}
              id="typical_belt"
              name="typical_belt"
              defaultValue={shown.typical_belt ?? ""}
              className={inputClass}
            >
              <option value="">— none —</option>
              {withCurrent(BELTS, shown.typical_belt).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <Section title="Position">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Position" htmlFor="position" hint="Where it happens.">
            <select
              key={`position-${shown.position ?? ""}`}
              id="position"
              name="position"
              required
              defaultValue={shown.position ?? ""}
              className={inputClass}
            >
              <option value="" disabled>
                Pick one…
              </option>
              {withCurrent(positions, shown.position).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="To position"
            htmlFor="to_position"
            hint="Where it leaves you. Empty means not recorded — never “goes nowhere”."
          >
            <select
              key={`to_position-${shown.to_position ?? ""}`}
              id="to_position"
              name="to_position"
              defaultValue={shown.to_position ?? ""}
              className={inputClass}
            >
              <option value="">— not recorded —</option>
              {withCurrent(positions, shown.to_position).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="Position detail"
          htmlFor="position_detail"
          hint="The specific configuration — “Closed guard”, “Knee shield”."
        >
          <input
            id="position_detail"
            name="position_detail"
            defaultValue={shown.position_detail ?? ""}
            className={inputClass}
          />
        </Field>
      </Section>

      <Section title="Explanation">
        <Field label="Description" htmlFor="description" hint="The mechanics.">
          <textarea
            id="description"
            name="description"
            rows={4}
            defaultValue={shown.description ?? ""}
            className={inputClass}
          />
        </Field>
        <Field
          label="When to use"
          htmlFor="when_to_use"
          hint="The decision about when the mechanics apply. Kept apart from the description on purpose — merged, they answer neither question well."
        >
          <textarea
            id="when_to_use"
            name="when_to_use"
            rows={3}
            defaultValue={shown.when_to_use ?? ""}
            className={inputClass}
          />
        </Field>
      </Section>

      <Section title="Graph">
        <p className="text-[12px] text-text-secondary">
          Names, one per line, matching other techniques&apos; names exactly — these are the
          edges that make the library traversable rather than a list.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Setup from" htmlFor="setup_from">
            <textarea
              id="setup_from"
              name="setup_from"
              rows={4}
              defaultValue={(shown.setup_from ?? []).join("\n")}
              className={inputClass}
            />
          </Field>
          <Field label="Common next moves" htmlFor="common_next_moves">
            <textarea
              id="common_next_moves"
              name="common_next_moves"
              rows={4}
              defaultValue={(shown.common_next_moves ?? []).join("\n")}
              className={inputClass}
            />
          </Field>
          <Field label="Common counters" htmlFor="common_counters">
            <textarea
              id="common_counters"
              name="common_counters"
              rows={4}
              defaultValue={(shown.common_counters ?? []).join("\n")}
              className={inputClass}
            />
          </Field>
        </div>
      </Section>

      <Section title="Provenance">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Video reference" htmlFor="video_reference">
            <input
              id="video_reference"
              name="video_reference"
              defaultValue={shown.video_reference ?? ""}
              className={inputClass}
            />
          </Field>
          <Field
            label="IBJJF ruleset id"
            htmlFor="ibjjf_ruleset_id"
            hint="Legality by belt and age division."
          >
            <input
              id="ibjjf_ruleset_id"
              name="ibjjf_ruleset_id"
              defaultValue={shown.ibjjf_ruleset_id ?? ""}
              className={inputClass}
            />
          </Field>
        </div>
        <Field
          label="Source notes"
          htmlFor="source_notes"
          hint="Where this came from — the class, the instructional, the academy that names it differently."
        >
          <input
            id="source_notes"
            name="source_notes"
            defaultValue={shown.source_notes ?? ""}
            className={inputClass}
          />
        </Field>
      </Section>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[10px] bg-accent-dark px-6 py-3 text-[13px] font-semibold text-page disabled:opacity-50"
        >
          {pending ? "Saving…" : mode === "create" ? "Create technique" : "Save changes"}
        </button>
        <Link href="/content" className="text-[13px] text-text-secondary underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}
