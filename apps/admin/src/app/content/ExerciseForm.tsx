"use client";

import React, { useActionState, useState } from "react";
import Link from "next/link";

import type { Exercise, ExerciseVocabularies, ExerciseWrite } from "@/lib/api";
import { previewSlug } from "@/lib/slug";
import type { SaveResult } from "./actions";

const inputClass =
  "w-full rounded-[10px] border border-border-strong bg-card px-3 py-2 text-[13.5px] text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark";

/** See TechniqueForm's Field — same reasoning, same aria-describedby wiring. */
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
      {hint && React.isValidElement<{ "aria-describedby"?: string }>(children)
        ? React.cloneElement(children, { "aria-describedby": hintID })
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

/** See TechniqueForm.withCurrent — shows a stored value the vocabulary does not
 *  contain, rather than silently coercing it to the first option and then
 *  persisting that on the next save. */
function withCurrent(options: readonly string[], current: string | undefined): string[] {
  if (!current || options.includes(current)) return [...options];
  return [current, ...options];
}

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
            ? "The id is derived from this and can never be changed afterwards — it becomes a foreign key in workout items and logged sets."
            : "Renaming is safe: the id stays as it is, so existing workouts and training records keep pointing at this exercise."
        }
      >
        <input
          id="name"
          name="name"
          required
          maxLength={200}
          defaultValue={initialName}
          onChange={(e) => setName(e.target.value)}
          placeholder="Zercher Squat"
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

export function ExerciseForm({
  vocabularies,
  action,
  initial,
  mode,
}: {
  vocabularies: ExerciseVocabularies;
  action: (
    prev: SaveResult<ExerciseWrite>,
    form: FormData,
  ) => Promise<SaveResult<ExerciseWrite>>;
  initial?: Exercise;
  mode: "create" | "edit";
}) {
  const [result, submit, pending] = useActionState<SaveResult<ExerciseWrite>, FormData>(
    action,
    { status: "idle" },
  );

  /**
   * What the fields default to. After a REJECTED save this is the submission
   * itself — React 19 resets an uncontrolled form once its action completes, so
   * without it a refusal wipes everything the operator typed. Each `<select>`
   * additionally carries a `key`, because a select does not pick up a changed
   * `defaultValue` on re-render the way a text input does; it applies its
   * default by marking the matching option at MOUNT.
   */
  const shown: Partial<Exercise> =
    result.status === "error" ? result.values : (initial ?? {});

  return (
    <form action={submit} className="flex flex-col gap-6">
      {result.status === "error" && (
        <p
          key={result.attempt}
          ref={(el) => el?.focus()}
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
              <Link href={`/content/exercises/${result.id}`} className="underline">
                Open it
              </Link>{" "}
              or{" "}
              <Link href="/content/exercises" className="underline">
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
          key={result.status === "ok" ? `saved-${result.id}` : `editing-${result.status}`}
          mode={mode}
          initialName={shown.name ?? ""}
          storedID={initial?.id}
        />
      </Section>

      <Section title="Classification">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Sport" htmlFor="sport" hint="From the discipline registry.">
            <select
              key={`sport-${shown.sport ?? ""}`}
              id="sport"
              name="sport"
              required
              defaultValue={shown.sport ?? ""}
              className={inputClass}
            >
              <option value="" disabled>
                Pick one…
              </option>
              {withCurrent(vocabularies.sports, shown.sport).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Load type"
            htmlFor="load_type"
            hint="Which target inputs this takes — both clients render the set logger from it."
          >
            <select
              key={`load_type-${shown.load_type ?? ""}`}
              id="load_type"
              name="load_type"
              required
              defaultValue={shown.load_type ?? ""}
              className={inputClass}
            >
              <option value="" disabled>
                Pick one…
              </option>
              {withCurrent(vocabularies.load_types, shown.load_type).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label="Movement pattern"
          htmlFor="movement_pattern"
          hint="The COARSE vocabulary the cross-sport rules are written against. Getting this wrong is the one mistake that looks identical to getting it right: the exercise renders perfectly and is silently invisible to every rule. Use “isolation” for the single-joint long tail rather than reaching for the closest big lift."
        >
          <select
            key={`movement_pattern-${shown.movement_pattern ?? ""}`}
            id="movement_pattern"
            name="movement_pattern"
            required
            defaultValue={shown.movement_pattern ?? ""}
            className={inputClass}
          >
            <option value="" disabled>
              Pick one…
            </option>
            {withCurrent(vocabularies.movement_patterns, shown.movement_pattern).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Movement pattern detail"
          htmlFor="movement_pattern_detail"
          hint="The granular label, for display and filtering only — no rule reads it."
        >
          <input
            id="movement_pattern_detail"
            name="movement_pattern_detail"
            defaultValue={shown.movement_pattern_detail ?? ""}
            placeholder="Front-loaded squat"
            className={inputClass}
          />
        </Field>

        <Field
          label="Load mode"
          htmlFor="load_mode"
          hint="Which number the athlete types. Per side means ONE dumbbell or kettlebell of a pair — get this wrong and the exercise reports half its real tonnage, or double it."
        >
          <select
            key={`load_mode-${shown.load_mode ?? ""}`}
            id="load_mode"
            name="load_mode"
            required
            defaultValue={shown.load_mode ?? "total"}
            className={inputClass}
          >
            <option value="total">total — the weight IS the whole load</option>
            <option value="per_side">per_side — one implement of a pair</option>
          </select>
        </Field>

        <div className="flex items-center gap-2">
          <input
            key={`is_unilateral-${String(shown.is_unilateral ?? false)}`}
            id="is_unilateral"
            name="is_unilateral"
            type="checkbox"
            defaultChecked={shown.is_unilateral ?? false}
            className="size-4 rounded border-border-strong"
          />
          <label htmlFor="is_unilateral" className="text-[13px]">
            Unilateral — one limb at a time
          </label>
        </div>
        {/* Two different questions, and the console is where they get confused.
            `load_mode` says which number is typed; `is_unilateral` says whether
            one limb works at a time. 34 catalog rows are BOTH — a one-arm
            dumbbell row is entered per hand and does not double — so neither
            implies the other and the tonnage rule reads them together:
            per_side AND NOT unilateral is the only combination that doubles. */}
        <p className="text-[12px] text-text-secondary">
          These two are independent. A one-arm dumbbell row is <em>per_side</em> (you enter one
          dumbbell) <em>and</em> unilateral (only that hand works), so its load does not double —
          only per_side movements that are <em>not</em> unilateral do.
        </p>
      </Section>

      <Section title="Anatomy and equipment">
        <p className="text-[12px] text-text-secondary">
          One per line, matching the names the rest of the catalog uses — these are what the
          library&apos;s muscle and equipment filters group on, so a new spelling makes its own
          bucket of one.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Primary muscles" htmlFor="primary_muscles">
            <textarea
              id="primary_muscles"
              name="primary_muscles"
              rows={4}
              defaultValue={(shown.primary_muscles ?? []).join("\n")}
              className={inputClass}
            />
          </Field>
          <Field label="Secondary muscles" htmlFor="secondary_muscles">
            <textarea
              id="secondary_muscles"
              name="secondary_muscles"
              rows={4}
              defaultValue={(shown.secondary_muscles ?? []).join("\n")}
              className={inputClass}
            />
          </Field>
          <Field label="Equipment" htmlFor="equipment">
            <textarea
              id="equipment"
              name="equipment"
              rows={4}
              defaultValue={(shown.equipment ?? []).join("\n")}
              className={inputClass}
            />
          </Field>
        </div>
      </Section>

      <Section title="Instructions">
        <Field
          label="Instructions"
          htmlFor="instructions"
          hint="How to perform it. Empty on 443 of the 504 seeded entries, so it is genuinely optional."
        >
          <textarea
            id="instructions"
            name="instructions"
            rows={5}
            defaultValue={shown.instructions ?? ""}
            className={inputClass}
          />
        </Field>
      </Section>

      {mode === "edit" && (
        <Section title="Media">
          <p className="text-[12px] text-text-secondary">
            Media is not editable here — it lives in object storage with no upload path from
            this console. Saving cannot clear it: the write does not carry the field, so
            anything a deploy attaches survives every edit made here.
          </p>
          <p className="text-[12px] text-text-muted">
            Whether this exercise has any is deliberately not stated. The admin list does not
            select media, so a count here would always read zero — including for a row a
            deploy has attached assets to, which is a reachable state while it is exported but
            not yet adopted. Saying nothing beats stating a fact from data this screen does
            not have.
          </p>
        </Section>
      )}

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-[10px] bg-accent-dark px-6 py-3 text-[13px] font-semibold text-page disabled:opacity-50"
        >
          {pending ? "Saving…" : mode === "create" ? "Create exercise" : "Save changes"}
        </button>
        <Link href="/content/exercises" className="text-[13px] text-text-secondary underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}
