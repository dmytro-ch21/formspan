"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  BJJ_BELTS,
  BJJ_MAX_DEGREE,
  BJJ_MAX_STRIPES,
  createBjjPromotion,
  deleteBjjPromotion,
  describeTimeAtBjjBelt,
  getBjjStanding,
  nextBjjRank,
  updateBjjPromotion,
  type BjjBelt,
  type BjjPromotion,
  type BjjPromotionInput,
  type BjjRank,
  type BjjStanding,
} from "@/lib/api";
import { BeltSwatch, describeBelt } from "./Belt";

/** Matches the server's own date layout (`2006-01-02`). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type FormState = {
  mode: "new" | "edit";
  id?: string;
  belt: BjjBelt;
  stripes: number;
  degree: number;
  promoted_on: string;
  academy: string;
  instructor: string;
  note: string;
};

function emptyForm(): FormState {
  return {
    mode: "new",
    belt: "white",
    stripes: 0,
    degree: 0,
    promoted_on: "",
    academy: "",
    instructor: "",
    note: "",
  };
}

/**
 * A new-mode form pre-filled with a suggested rank — one more stripe, or the
 * next belt once a stripe run is full. See `nextBjjRank`; every field here
 * is still editable before saving.
 */
function formFromSuggestion(rank: BjjRank): FormState {
  return {
    mode: "new",
    belt: rank.belt,
    stripes: rank.stripes,
    degree: rank.degree,
    promoted_on: "",
    academy: "",
    instructor: "",
    note: "",
  };
}

function formFrom(p: BjjPromotion): FormState {
  return {
    mode: "edit",
    id: p.id,
    belt: p.belt,
    stripes: p.stripes,
    degree: p.degree,
    promoted_on: p.promoted_on ?? "",
    academy: p.academy,
    instructor: p.instructor,
    note: p.note,
  };
}

/**
 * BJJ rank, on the desk.
 *
 * Recording a promotion happens after class or at a desk, not mid-roll — the
 * same reasoning that put the promotion `id` server-side rather than
 * client-generated (see docs/decisions/history.md). So unlike the in-session
 * affordances this app deliberately doesn't have, full add/edit/delete
 * belongs here.
 *
 * `current` is never a field in this form — there isn't one. It's derived
 * server-side from the promotion list, so the only way to change it is to
 * add, correct or remove a row below, same as the backend's `StandingFrom`.
 */
export function BjjRankSection() {
  const { getToken } = useAuth();
  const [standing, setStanding] = useState<BjjStanding | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    getBjjStanding(getToken, c.signal)
      .then((s) => {
        setStanding(s);
        setLoadError(null);
      })
      .catch((err) => {
        if (c.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => c.abort();
  }, [getToken]);

  async function refresh() {
    try {
      setStanding(await getBjjStanding(getToken));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  async function save() {
    if (!form || saving) return;
    const trimmedDate = form.promoted_on.trim();
    // Checked here rather than left to the server: a malformed date shares
    // the server's one `invalid_input` sentinel with a bad rank, so a round
    // trip would come back describing belts and stripes — correct advice for
    // a mistake the athlete didn't make. Catching the actual mistake here
    // means the message they see is about the field they actually got wrong.
    if (trimmedDate && !DATE_RE.test(trimmedDate)) {
      setFormError("Date must be YYYY-MM-DD, or left blank if you don't remember.");
      return;
    }
    setSaving(true);
    setFormError(null);
    // Degree is only a thing on a black belt — the server rejects one on any
    // other belt, so a coloured-belt edit never carries a stale value from
    // before the athlete switched belts in this same form.
    const isBlack = form.belt === "black";
    const input: BjjPromotionInput = {
      belt: form.belt,
      stripes: isBlack ? 0 : form.stripes,
      degree: isBlack ? form.degree : 0,
      promoted_on: trimmedDate || null,
      academy: form.academy.trim(),
      instructor: form.instructor.trim(),
      note: form.note.trim(),
    };
    try {
      if (form.mode === "edit" && form.id) {
        await updateBjjPromotion(getToken, form.id, input);
      } else {
        await createBjjPromotion(getToken, input);
      }
      setForm(null);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: BjjPromotion) {
    if (
      !confirm(
        `Remove ${describeBelt(p.belt, p.stripes, p.degree)} from your history? This can't be undone.`,
      )
    ) {
      return;
    }
    try {
      await deleteBjjPromotion(getToken, p.id);
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="eyebrow">BJJ rank</h2>

      {loadError && (
        <p role="alert" className="text-sm text-danger">
          {loadError}
        </p>
      )}

      {standing === null ? (
        !loadError && <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <>
          <div className="flex items-center gap-4 rounded-card border border-line bg-surface px-5 py-4">
            {standing.current ? (
              <>
                <BeltSwatch
                  belt={standing.current.belt}
                  stripes={standing.current.stripes}
                  degree={standing.current.degree}
                  width={140}
                />
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {describeBelt(
                      standing.current.belt,
                      standing.current.stripes,
                      standing.current.degree,
                    )}
                  </span>
                  {standing.time_at_current_days !== null && (
                    <span className="text-sm text-text-muted">
                      {describeTimeAtBjjBelt(standing.time_at_current_days)} at this rank
                    </span>
                  )}
                </div>
              </>
            ) : (
              <span className="text-sm text-text-muted">No rank recorded yet.</span>
            )}
          </div>

          {standing.promotions.length > 0 && (
            <div className="flex flex-col gap-2">
              {standing.promotions.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-4 rounded-card border border-line bg-surface px-5 py-3"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="font-medium">{describeBelt(p.belt, p.stripes, p.degree)}</p>
                    <p className="text-sm text-text-muted">
                      {[p.promoted_on, p.academy, p.instructor].filter(Boolean).join(" · ") ||
                        "No date, academy or instructor recorded"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-3 text-sm">
                    <button
                      type="button"
                      onClick={() => setForm(formFrom(p))}
                      className="text-text-muted hover:underline"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(p)}
                      className="text-danger hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {form ? (
            <PromotionFormCard
              form={form}
              onChange={setForm}
              onCancel={() => setForm(null)}
              onSave={save}
              saving={saving}
              error={formError}
            />
          ) : (
            <button
              type="button"
              onClick={() =>
                setForm(
                  standing.current ? formFromSuggestion(nextBjjRank(standing.current)) : emptyForm(),
                )
              }
              className="self-start rounded-pill border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-hover"
            >
              Add promotion
            </button>
          )}
        </>
      )}
    </section>
  );
}

function PromotionFormCard({
  form,
  onChange,
  onCancel,
  onSave,
  saving,
  error,
}: {
  form: FormState;
  onChange: (f: FormState) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
}) {
  const isBlack = form.belt === "black";

  return (
    <div className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex items-center gap-4">
        <BeltSwatch belt={form.belt} stripes={form.stripes} degree={form.degree} width={120} />
        <span className="text-sm text-text-muted">
          {describeBelt(form.belt, form.stripes, form.degree)}
        </span>
      </div>

      <PickerGroup label="Belt">
        <div role="radiogroup" aria-label="Belt" className="flex flex-wrap gap-2">
          {BJJ_BELTS.map((b) => {
            const selected = form.belt === b;
            return (
              <button
                key={b}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() =>
                  onChange({
                    ...form,
                    belt: b,
                    // Only one of these is ever meaningful at a time — leaving
                    // the other's stale value in state is invisible in the
                    // stepper (it's hidden) but not in the preview label,
                    // which reads whichever field `describeBelt` checks first.
                    degree: b === "black" ? form.degree : 0,
                    stripes: b === "black" ? 0 : form.stripes,
                  })
                }
                className={`rounded-pill border px-4 py-1.5 text-sm font-medium ${
                  selected ? "border-lime bg-lime/20" : "border-line hover:bg-surface-hover"
                }`}
              >
                {b.charAt(0).toUpperCase() + b.slice(1)}
              </button>
            );
          })}
        </div>
      </PickerGroup>

      <PickerGroup label={isBlack ? "Degree" : "Stripes"}>
        <div
          role="radiogroup"
          aria-label={isBlack ? "Degree" : "Stripes"}
          className="flex flex-wrap gap-2"
        >
          {Array.from(
            { length: (isBlack ? BJJ_MAX_DEGREE : BJJ_MAX_STRIPES) + 1 },
            (_, n) => n,
          ).map((n) => {
            const value = isBlack ? form.degree : form.stripes;
            const selected = value === n;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() =>
                  onChange(isBlack ? { ...form, degree: n } : { ...form, stripes: n })
                }
                className={`h-9 w-9 rounded-pill border text-sm font-semibold ${
                  selected ? "border-lime bg-lime/20" : "border-line hover:bg-surface-hover"
                }`}
              >
                {n}
              </button>
            );
          })}
        </div>
      </PickerGroup>

      <FieldGroup label="Date">
        <input
          type="text"
          value={form.promoted_on}
          onChange={(e) => onChange({ ...form, promoted_on: e.target.value })}
          placeholder="YYYY-MM-DD — leave blank if you don't remember"
          className="rounded-control border border-line bg-surface px-3 py-2 text-sm"
        />
      </FieldGroup>
      <FieldGroup label="Academy">
        <input
          type="text"
          value={form.academy}
          onChange={(e) => onChange({ ...form, academy: e.target.value })}
          className="rounded-control border border-line bg-surface px-3 py-2 text-sm"
        />
      </FieldGroup>
      <FieldGroup label="Instructor">
        <input
          type="text"
          value={form.instructor}
          onChange={(e) => onChange({ ...form, instructor: e.target.value })}
          className="rounded-control border border-line bg-surface px-3 py-2 text-sm"
        />
      </FieldGroup>
      <FieldGroup label="Note">
        <textarea
          value={form.note}
          onChange={(e) => onChange({ ...form, note: e.target.value })}
          rows={2}
          className="rounded-control border border-line bg-surface px-3 py-2 text-sm"
        />
      </FieldGroup>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="rounded-pill bg-accent-fill px-5 py-2 text-sm font-bold text-accent-on-fill transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-pill border border-line px-5 py-2 text-sm font-medium hover:bg-surface-hover"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-text-dim">{label}</span>
      {children}
    </label>
  );
}

/**
 * For a group of several buttons rather than one input.
 *
 * A `<label>` forwards a click anywhere on it — including the caption text —
 * to its first labelable descendant. Wrapping a whole belt-chip row in one
 * meant clicking the word "Belt" silently clicked "White", resetting
 * whatever the athlete had picked. `<fieldset>`/`<legend>` carries no such
 * forwarding, which is exactly why `workouts/page.tsx`'s discipline picker
 * already uses it for the same shape of control.
 */
function PickerGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs uppercase tracking-wide text-text-dim">{label}</legend>
      {children}
    </fieldset>
  );
}
