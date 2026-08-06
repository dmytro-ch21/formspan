"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  CRITERIA_DEFAULTS,
  createCurriculum,
  listTechniques,
  rankTechniques,
  updateCurriculum,
  type Curriculum,
  type CurriculumItemWrite,
  type TechniqueSummary,
  type Visibility,
} from "@/lib/api";

/**
 * Building a curriculum: catalog on the left, your list on the right.
 *
 * The same two-pane shape the workout builder uses, for the same reason — you
 * are picking from a catalog too big to remember, so it has to stay visible
 * while you assemble.
 *
 * **The one genuinely new idea is per-item criteria**, and the interaction has
 * to make three things obvious:
 *
 *  - An item with no criteria is legitimate. It is reading, and the list is
 *    allowed to be a reading list — so criteria are opt-in per row rather than
 *    a form you must fill.
 *  - Defence-only is legitimate too, and it is the case that justified
 *    recording `defended` at all ("not get caught in guard pull N times"),
 *    so the offensive target has to be clearable rather than required.
 *  - The defaults are not arbitrary. 25 / 8 / 12 / 0.35 is roughly ten weeks
 *    per technique, and the defence figure is a third of the offence figure
 *    because you do not choose when a technique is attempted on you.
 */
export function CurriculumBuilder({ existing }: { existing?: Curriculum }) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [belt, setBelt] = useState(existing?.belt ?? "");
  const [visibility, setVisibility] = useState<Visibility>(
    existing?.visibility ?? "private",
  );
  const [items, setItems] = useState<CurriculumItemWrite[]>(
    () =>
      existing?.items?.map((it) => ({
        technique_id: it.technique_id,
        notes: it.notes,
        target_scored: it.criteria?.target_scored ?? null,
        target_defended: it.criteria?.target_defended ?? null,
        target_sessions: it.criteria?.target_sessions ?? null,
        min_hit_rate: it.criteria?.min_hit_rate ?? null,
      })) ?? [],
  );

  const [catalog, setCatalog] = useState<TechniqueSummary[]>([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    listTechniques(getToken, c.signal)
      .then(setCatalog)
      .catch((err) => {
        if ((err as Error)?.name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => c.abort();
  }, [getToken]);

  const byID = useMemo(
    () => new Map(catalog.map((t) => [t.id, t])),
    [catalog],
  );
  const chosen = useMemo(
    () => new Set(items.map((i) => i.technique_id)),
    [items],
  );

  const results = useMemo(() => {
    // `rankTechniques`, NOT a hand-rolled includes(). Its own doc records why:
    // "São Paulo Pass" had been in the catalog the whole time and was
    // unfindable, because a plain toLowerCase().includes() fails "sao paulo"
    // against "São Paulo". It also folds hyphens, so "half guard" matches
    // "Half-Guard" -- rolling our own here would make this picker disagree with
    // the Library screen about the same catalog.
    //
    // Capped at 60 rather than virtualised: this is a picker, and if what you
    // want is not in the first 60 the answer is a better search term. The
    // ranked variant is what makes that claim true — under the old unranked
    // filter the first 60 were whichever the seed file listed first, so a
    // better search term was not always available.
    return rankTechniques(catalog, query).slice(0, 60);
  }, [catalog, query]);

  const add = useCallback((id: string) => {
    setItems((prev) =>
      prev.some((i) => i.technique_id === id)
        ? prev
        : // Added as READING, criteria off. Making every addition a roadmap
          // step would put four numbers in front of someone who wanted a list,
          // and the schema is explicit that a criterion is opt-in.
          [...prev, { technique_id: id, notes: "" }],
    );
  }, []);

  const removeAt = useCallback((idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const move = useCallback((idx: number, delta: number) => {
    setItems((prev) => {
      const next = [...prev];
      const to = idx + delta;
      if (to < 0 || to >= next.length) return prev;
      [next[idx], next[to]] = [next[to], next[idx]];
      return next;
    });
  }, []);

  const patchItem = useCallback(
    (idx: number, patch: Partial<CurriculumItemWrite>) => {
      setItems((prev) =>
        prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
      );
    },
    [],
  );

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        // Empty select means "not a belt syllabus", which is null rather than
        // "". PATCH treats an explicit null as CLEAR, which is what makes it
        // possible to un-tag a curriculum that was mislabelled.
        belt: belt === "" ? null : belt,
        visibility,
        items,
      };
      const saved = existing
        ? await updateCurriculum(getToken, existing.id, payload)
        : await createCurriculum(getToken, payload);
      router.push(`/dashboard/curricula/${saved.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }, [belt, description, existing, getToken, items, name, router, visibility]);

  const countable = items.filter(
    (i) => i.target_scored != null || i.target_defended != null,
  ).length;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">
          {existing ? "Edit curriculum" : "New curriculum"}
        </h1>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Guard passing for the winter"
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Belt</span>
            <select
              value={belt}
              onChange={(e) => setBelt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              {/* "Not a belt syllabus" first, because most athlete-built lists
                  are not one. The belt is only ever a hint for ordering — it
                  never gates who may work this. */}
              <option value="">Not belt-specific</option>
              {["white", "blue", "purple", "brown", "black"].map((b) => (
                <option key={b} value={b} className="capitalize">
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="text-sm font-medium">Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={visibility === "public"}
              onChange={(e) =>
                setVisibility(e.target.checked ? "public" : "private")
              }
            />
            Share this with other athletes
          </label>
        </div>
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <section className="lg:sticky lg:top-4 lg:self-start">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Technique library
          </h2>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search techniques…"
            aria-label="Search the technique library"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <ul className="mt-2 max-h-[28rem] space-y-1 overflow-y-auto pr-1">
            {results.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => add(t.id)}
                  disabled={chosen.has(t.id)}
                  className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-900"
                >
                  <span className="font-medium">{t.name}</span>
                  <span className="block text-xs text-neutral-500">
                    {t.position}
                  </span>
                </button>
              </li>
            ))}
            {results.length === 0 && (
              <li className="px-2 py-4 text-sm text-neutral-500">
                Nothing matches.
              </li>
            )}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 flex items-baseline justify-between text-sm font-semibold uppercase tracking-wide text-neutral-500">
            <span>
              In this curriculum ({items.length})
            </span>
            {/* States the progress rule while they build, so the denominator
                is never a surprise later. */}
            <span className="font-normal normal-case tracking-normal text-neutral-500">
              {countable} with criteria
            </span>
          </h2>

          {items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
              Pick techniques from the library. Add criteria to the ones you
              want to be able to finish.
            </p>
          ) : (
            <ul className="space-y-2">
              {items.map((it, idx) => (
                <BuilderRow
                  key={it.technique_id}
                  item={it}
                  technique={byID.get(it.technique_id)}
                  isFirst={idx === 0}
                  isLast={idx === items.length - 1}
                  onMove={(d) => move(idx, d)}
                  onRemove={() => removeAt(idx)}
                  onPatch={(patch) => patchItem(idx, patch)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="flex items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <button
          type="button"
          onClick={save}
          disabled={saving || name.trim() === ""}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {saving ? "Saving…" : existing ? "Save changes" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="text-sm text-neutral-600 hover:underline dark:text-neutral-400"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function BuilderRow({
  item,
  technique,
  isFirst,
  isLast,
  onMove,
  onRemove,
  onPatch,
}: {
  item: CurriculumItemWrite;
  technique: TechniqueSummary | undefined;
  isFirst: boolean;
  isLast: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onPatch: (patch: Partial<CurriculumItemWrite>) => void;
}) {
  const [open, setOpen] = useState(false);
  /*
   * AN EXPLICIT FLAG, not a derivation from the volume fields.
   *
   * Derived, clearing both anchors collapsed the row to "+ Add criteria" — so
   * it LOOKED like a clean reading item while the state still carried
   * `target_sessions` and `min_hit_rate`. The server then rejected the save on
   * the anchoring rule and blamed nothing in particular. Worse in daily use:
   * on an item with one anchor set, clearing that field to retype it unmounted
   * the editor under the cursor mid-keystroke.
   *
   * Now only "Remove criteria" clears state, and it nulls all four.
   */
  const hasCriteria =
    open ||
    item.target_scored != null ||
    item.target_defended != null ||
    item.target_sessions != null ||
    item.min_hit_rate != null;

  return (
    <li className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">{technique?.name ?? item.technique_id}</p>
          {technique && (
            <p className="text-xs text-neutral-500">{technique.position}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={isFirst}
            aria-label="Move up"
            className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-900"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={isLast}
            aria-label="Move down"
            className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-900"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${technique?.name ?? item.technique_id}`}
            className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            ✕
          </button>
        </div>
      </div>

      {!hasCriteria ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            onPatch({
              target_scored: CRITERIA_DEFAULTS.target_scored,
              target_defended: CRITERIA_DEFAULTS.target_defended,
              target_sessions: CRITERIA_DEFAULTS.target_sessions,
              min_hit_rate: CRITERIA_DEFAULTS.min_hit_rate,
            });
          }}
          className="mt-2 text-sm text-neutral-600 hover:underline dark:text-neutral-400"
        >
          + Add completion criteria
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Num
              label="Land it"
              value={item.target_scored}
              // Clearing this clears the hit rate WITH it. The rate divides the
              // offensive attempt count, so the server refuses the pair
              // (curriculum_items_hit_rate_needs_volume) -- and the refusal
              // arrives as a generic "items must be unique techniques with
              // positive targets", naming neither the field nor which of up to
              // 60 rows. Defence-only is the case that justified recording
              // `defended` at all; it has to be reachable without a 400.
              onChange={(v) =>
                onPatch(v == null ? { target_scored: null, min_hit_rate: null } : { target_scored: v })
              }
            />
            <Num
              label="Stop theirs"
              value={item.target_defended}
              onChange={(v) => onPatch({ target_defended: v })}
            />
            <Num
              label="Sessions"
              value={item.target_sessions}
              onChange={(v) => onPatch({ target_sessions: v })}
            />
            <Num
              label="Hit rate %"
              // Meaningless without something to be a rate OF, and the schema
              // says so too. Disabled rather than hidden, so the reason is
              // visible rather than the field just vanishing.
              disabled={item.target_scored == null}
              value={
                item.min_hit_rate == null
                  ? null
                  : Math.round(item.min_hit_rate * 100)
              }
              onChange={(v) =>
                onPatch({ min_hit_rate: v == null ? null : v / 100 })
              }
            />
          </div>
          <p className="text-xs text-neutral-500">
            {/* Says why the defence figure is smaller, because it looks like a
                typo otherwise — and why the rate is there at all. */}
            Counted from the day you start this. Stopping theirs is set lower on
            purpose: you choose when to attack, not when you are attacked. The
            hit rate is what separates landing it 25 times from throwing it 400.
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onPatch({
                target_scored: null,
                target_defended: null,
                target_sessions: null,
                min_hit_rate: null,
              });
            }}
            className="text-xs text-neutral-500 hover:underline"
          >
            Remove criteria — just something to study
          </button>
        </div>
      )}
    </li>
  );
}

function Num({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs text-neutral-500">{label}</span>
      <input
        type="number"
        min={1}
        value={value ?? ""}
        // Empty clears the target rather than sending 0, which the schema
        // refuses (targets must be positive) and which would mean something
        // different anyway.
        disabled={disabled}
        // Clamped here, not left to `min={1}`: these inputs are not inside a
        // <form> -- Create is a plain button -- so HTML validation never runs,
        // and 0, a negative or 2.5 would each reach the wire and come back as
        // an unactionable 400 (the decimal as "invalid JSON body", since the
        // field is a Go *int).
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(null);
          const n = Math.floor(Number(raw));
          onChange(Number.isFinite(n) && n > 0 ? n : null);
        }}
        className="mt-0.5 w-full rounded-lg border border-neutral-300 px-2 py-1 text-sm tabular-nums disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900"
      />
    </label>
  );
}
