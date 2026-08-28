"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  MAX_CLASS_PLAN_BLOCKS,
  createClassPlan,
  listTechniques,
  rankTechniques,
  updateClassPlan,
  type ClassPlan,
  type ClassPlanBlockWrite,
  type TechniqueSummary,
} from "@/lib/api";

/**
 * Building a class plan: catalog on the left, the schedule on the right.
 *
 * The same two-pane shape the sequence and curriculum builders use, for the
 * same reason — you are picking from a catalog too big to remember, so it has
 * to stay visible while you assemble. **Web, per the platform rule**: laying
 * out tonight's warmup/drilling/rounds split is a desk activity, not
 * something done between classes.
 *
 * WHAT MAKES THIS DIFFERENT FROM SequenceBuilder, and will bite a copy-paste:
 *
 *  - **A block's order is a SCHEDULE, not a chain.** Ten minutes of this, then
 *    fifteen of that — there is no "leaves you in" destination to draw between
 *    blocks, and no `start_position` concept at all. Reordering still matters
 *    (it changes when something happens in the hour), which is why the move
 *    controls are still as prominent as remove, but there is nothing to draw
 *    BETWEEN rows the way SequenceBuilder draws positions.
 *  - **Only one block type points at the catalog.** `warmup`, `live_rounds`
 *    and `notes` blocks are plain schedule entries — a duration and an
 *    optional note. Only `technique_drill` blocks reference a technique, and
 *    even then only sometimes: a drill not in the library is legitimate, and
 *    the backend enforces an XOR between a catalog pick and free text (see
 *    `ValidateBlocks` in classplan.go). That XOR is enforced HERE too, in the
 *    row's own rendering — a picked technique and the free-text input are
 *    never both on screen at once, so there is no state in which a save
 *    could disagree with itself about what a block is.
 *  - **The catalog can target an EXISTING row, not just append one.**
 *    SequenceBuilder's catalog only ever appends. Here, a `technique_drill`
 *    row with nothing picked yet can ask to be the catalog's next target
 *    (`pickingForUid`) — click "Pick from the library", then click a
 *    technique, and THAT ROW gets it rather than a new one being created.
 *    Clicking a technique with no row targeted still appends, matching the
 *    old behaviour, so the catalog does the right thing either way.
 *  - **A repeated technique is legal here too**, for the same reason it is on
 *    a sequence — "armbar drilling" can appear in both a technique_drill
 *    block and, worded differently, a notes block. Rows are keyed on a local
 *    `uid`, never on `technique_id`.
 */

/** One row of local state. `uid` exists only to key the list and to let the
 *  catalog address a specific row — see the header comment above. */
type Row = ClassPlanBlockWrite & { uid: string };

/**
 * A key that is unique and does not depend on call order.
 *
 * Matches SequenceBuilder's `nextUID()` for the identical reason: a
 * module-level counter is an impure read-modify-write inside a `useState`
 * initialiser and a `setRows` updater, which is exactly what StrictMode's
 * double-invocation exists to surface. `crypto.randomUUID()` is safe by
 * construction instead of safe because every call site was traced.
 */
function nextUID(): string {
  return crypto.randomUUID();
}

const BLOCK_TYPES: {
  key: ClassPlanBlockWrite["type"];
  label: string;
  addLabel: string;
  defaultMinutes: number;
}[] = [
  { key: "warmup", label: "Warmup", addLabel: "+ Warmup", defaultMinutes: 10 },
  {
    key: "technique_drill",
    label: "Technique drill",
    addLabel: "+ Technique drill",
    defaultMinutes: 15,
  },
  {
    key: "live_rounds",
    label: "Live rounds",
    addLabel: "+ Live rounds",
    defaultMinutes: 15,
  },
  { key: "notes", label: "Notes", addLabel: "+ Notes", defaultMinutes: 5 },
];

const BLOCK_LABEL: Record<ClassPlanBlockWrite["type"], string> = Object.fromEntries(
  BLOCK_TYPES.map((b) => [b.key, b.label]),
) as Record<ClassPlanBlockWrite["type"], string>;

/** The notes field means something different per block type — for a `notes`
 *  block it IS the content, for everything else it is supplementary. The
 *  placeholder is the cheapest way to say that without a second label. */
function notesPlaceholder(type: ClassPlanBlockWrite["type"]): string {
  switch (type) {
    case "notes":
      return "What to cover — announcements, reminders…";
    case "warmup":
      return "e.g. jog, shrimping, breakfalls (optional)";
    case "live_rounds":
      return "e.g. positional only, no subs below purple (optional)";
    case "technique_drill":
      return "How your coach does it, common mistakes (optional)";
  }
}

export function ClassPlanBuilder({ existing }: { existing?: ClassPlan }) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [rows, setRows] = useState<Row[]>(
    () =>
      existing?.blocks?.map((b) => ({
        uid: nextUID(),
        type: b.type,
        duration_minutes: b.duration_minutes,
        technique_id: b.technique_id ?? null,
        free_text: b.free_text ?? null,
        notes: b.notes,
      })) ?? [],
  );

  // null is "still loading" and [] is "genuinely empty" — collapsing them
  // shows "Nothing matches." while the catalog is in flight, which on a
  // builder reads as "the library is empty" for the duration of the fetch.
  const [catalog, setCatalog] = useState<TechniqueSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which row, if any, the catalog should fill on the next click — see the
   * header comment's "catalog can target an existing row" bullet. `null`
   * means the ordinary "click a technique, append a new block" behaviour.
   */
  const [pickingForUid, setPickingForUid] = useState<string | null>(null);
  const pickingForIndex = rows.findIndex((r) => r.uid === pickingForUid);

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
    () => new Map((catalog ?? []).map((t) => [t.id, t])),
    [catalog],
  );

  const results = useMemo(() => {
    // `rankTechniques`, not a hand-rolled filter — see SequenceBuilder's
    // comment on the same call for why an unranked cap is the bug and this
    // is the fix. No `chosen` exclusion, matching SequenceBuilder and unlike
    // CurriculumBuilder: a repeated technique is legal in a class plan too.
    return rankTechniques(catalog ?? [], query).slice(0, 60);
  }, [catalog, query]);

  const full = rows.length >= MAX_CLASS_PLAN_BLOCKS;
  const totalMinutes = rows.reduce(
    (sum, r) => sum + (Number.isFinite(r.duration_minutes) ? r.duration_minutes : 0),
    0,
  );

  const addBlock = useCallback((type: ClassPlanBlockWrite["type"]) => {
    setRows((prev) => {
      if (prev.length >= MAX_CLASS_PLAN_BLOCKS) return prev;
      const spec = BLOCK_TYPES.find((b) => b.key === type)!;
      return [
        ...prev,
        {
          uid: nextUID(),
          type,
          duration_minutes: spec.defaultMinutes,
          technique_id: null,
          free_text: null,
          notes: "",
        },
      ];
    });
  }, []);

  /**
   * A technique catalog click: fills the targeted row if one is armed,
   * otherwise appends a new `technique_drill` block — the same "add" a
   * sequence or curriculum catalog does. Clearing `free_text` on a fill is
   * the XOR enforcement: the row can never hold both after this.
   */
  const addOrPickTechnique = useCallback(
    (techniqueId: string) => {
      setRows((prev) => {
        const idx = prev.findIndex((r) => r.uid === pickingForUid);
        if (idx !== -1) {
          const next = [...prev];
          next[idx] = { ...next[idx], technique_id: techniqueId, free_text: null };
          return next;
        }
        if (prev.length >= MAX_CLASS_PLAN_BLOCKS) return prev;
        return [
          ...prev,
          {
            uid: nextUID(),
            type: "technique_drill",
            duration_minutes:
              BLOCK_TYPES.find((b) => b.key === "technique_drill")!.defaultMinutes,
            technique_id: techniqueId,
            free_text: null,
            notes: "",
          },
        ];
      });
      setPickingForUid(null);
    },
    [pickingForUid],
  );

  const removeAt = useCallback(
    (idx: number) => {
      // Clearing an armed target here rather than leaving it dangling: the
      // row it pointed at is gone, and a stale `pickingForUid` would either
      // silently fill the WRONG row (whatever shifted into that uid never
      // happens — uids don't get reused — so it would just fill nothing and
      // the banner below would keep naming a block that no longer exists).
      if (rows[idx]?.uid === pickingForUid) setPickingForUid(null);
      setRows((prev) => prev.filter((_, i) => i !== idx));
    },
    [rows, pickingForUid],
  );

  const move = useCallback((idx: number, delta: number) => {
    setRows((prev) => {
      const next = [...prev];
      const to = idx + delta;
      if (to < 0 || to >= next.length) return prev;
      [next[idx], next[to]] = [next[to], next[idx]];
      return next;
    });
  }, []);

  const patchRow = useCallback((idx: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }, []);

  const changeType = useCallback(
    (idx: number, type: ClassPlanBlockWrite["type"]) => {
      if (rows[idx]?.uid === pickingForUid && type !== "technique_drill") {
        setPickingForUid(null);
      }
      setRows((prev) =>
        prev.map((r, i) => {
          if (i !== idx) return r;
          if (type === "technique_drill") return { ...r, type };
          // Leaving technique_drill: technique_id/free_text have nowhere to
          // live on any other block type — ValidateBlocks on the backend
          // rejects either being set outside a technique_drill block, so
          // clear both here rather than let a stale pick survive a type
          // switch and reach the server as a 400 naming no field.
          return { ...r, type, technique_id: null, free_text: null };
        }),
      );
    },
    [rows, pickingForUid],
  );

  const save = useCallback(async () => {
    // Caught here so the failure names the actual block — the server's
    // whole-body 400 cannot say which of up to 40 rows disagrees with
    // itself about what it's drilling.
    const badIdx = rows.findIndex((r) => {
      if (r.type !== "technique_drill") return false;
      const techSet = !!r.technique_id;
      const freeSet = !!(r.free_text && r.free_text.trim() !== "");
      return techSet === freeSet; // both or neither is the invalid case
    });
    if (badIdx !== -1) {
      setError(
        `Block ${badIdx + 1} needs a technique — pick one from the library or type what you drilled.`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        // uid is local-only and must not reach the wire. technique_id/
        // free_text are forced null outside technique_drill as a second
        // guard alongside changeType's — belt and braces on the one field
        // pair the backend actually rejects a stale value for.
        blocks: rows.map((r) => ({
          type: r.type,
          duration_minutes: r.duration_minutes,
          technique_id: r.type === "technique_drill" ? (r.technique_id ?? null) : null,
          free_text: r.type === "technique_drill" ? (r.free_text ?? null) : null,
          notes: r.notes ?? "",
        })),
      };
      const saved = existing
        ? await updateClassPlan(getToken, existing.id, payload)
        : await createClassPlan(getToken, payload);
      router.push(`/dashboard/classplans/${saved.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }, [description, existing, getToken, name, rows, router]);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="font-display text-3xl font-bold">
          {existing ? "Edit class plan" : "New class plan"}
        </h1>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="eyebrow">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tuesday beginners — guard passing"
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-text-dim focus:border-lime"
            />
          </label>
          <label className="block">
            <span className="eyebrow">Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this class is for (optional)"
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-text-dim focus:border-lime"
            />
          </label>
        </div>
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <section className="lg:sticky lg:top-4 lg:self-start">
          <h2 className="eyebrow mb-2">Technique library</h2>
          {pickingForUid !== null && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-control border border-lime/40 bg-lime/10 px-3 py-2 text-xs">
              <span>
                Picking a technique for block{" "}
                {pickingForIndex === -1 ? "" : pickingForIndex + 1}
              </span>
              <button
                type="button"
                onClick={() => setPickingForUid(null)}
                className="font-medium underline"
              >
                Cancel
              </button>
            </div>
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search techniques…"
            aria-label="Search the technique library"
            className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-text-dim focus:border-lime"
          />
          {full && pickingForUid === null && (
            <p className="mt-2 rounded-control bg-surface-raised px-3 py-2 text-xs text-text-muted">
              {MAX_CLASS_PLAN_BLOCKS} blocks is the limit. A class plan this
              long is a curriculum wearing the wrong shape.
            </p>
          )}
          <ul className="mt-2 max-h-[28rem] space-y-1 overflow-y-auto pr-1">
            {results.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => addOrPickTechnique(t.id)}
                  disabled={pickingForUid === null && full}
                  className="w-full rounded-control px-2 py-1.5 text-left text-sm hover:bg-surface-raised disabled:opacity-40"
                >
                  <span className="font-medium">{t.name}</span>
                  <span className="block text-xs text-text-dim">{t.position}</span>
                </button>
              </li>
            ))}
            {catalog === null && (
              <li className="px-2 py-4 text-sm text-text-muted">Loading…</li>
            )}
            {catalog !== null && results.length === 0 && (
              <li className="px-2 py-4 text-sm text-text-muted">Nothing matches.</li>
            )}
          </ul>
        </section>

        <section>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="eyebrow">
              The plan ({rows.length} {rows.length === 1 ? "block" : "blocks"}
              {rows.length > 0 ? ` · ${totalMinutes} min` : ""})
            </h2>
            <div className="flex flex-wrap gap-2">
              {BLOCK_TYPES.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => addBlock(b.key)}
                  disabled={full}
                  className="rounded-pill border border-line px-3 py-1 text-xs font-medium transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {b.addLabel}
                </button>
              ))}
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="rounded-card border border-dashed border-line px-4 py-8 text-center text-sm text-text-muted">
              Add a block above — warmup, a technique drill, live rounds, or a
              note — in the order the class runs.
            </p>
          ) : (
            <ol className="space-y-2">
              {rows.map((r, idx) => (
                <BlockRow
                  key={r.uid}
                  row={r}
                  index={idx}
                  technique={r.technique_id ? byID.get(r.technique_id) : undefined}
                  isFirst={idx === 0}
                  isLast={idx === rows.length - 1}
                  picking={pickingForUid === r.uid}
                  onMove={(d) => move(idx, d)}
                  onRemove={() => removeAt(idx)}
                  onPatch={(patch) => patchRow(idx, patch)}
                  onChangeType={(type) => changeType(idx, type)}
                  onPickFromLibrary={() => setPickingForUid(r.uid)}
                />
              ))}
            </ol>
          )}
        </section>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || name.trim() === ""}
          className="rounded-pill bg-accent-fill px-5 py-2.5 text-sm font-bold text-accent-on-fill transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : existing ? "Save changes" : "Create class plan"}
        </button>
        {name.trim() === "" && (
          <span className="text-sm text-text-muted">
            A name is all a list card can show, so it is the one required
            field.
          </span>
        )}
      </div>
    </div>
  );
}

function BlockRow({
  row,
  index,
  technique,
  isFirst,
  isLast,
  picking,
  onMove,
  onRemove,
  onPatch,
  onChangeType,
  onPickFromLibrary,
}: {
  row: Row;
  index: number;
  technique?: TechniqueSummary;
  isFirst: boolean;
  isLast: boolean;
  /** Whether THIS row is the catalog's current target — drawn with a ring so
   *  "click a technique now" has somewhere to point. */
  picking: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onPatch: (patch: Partial<Row>) => void;
  onChangeType: (type: ClassPlanBlockWrite["type"]) => void;
  onPickFromLibrary: () => void;
}) {
  const rowLabel = `${BLOCK_LABEL[row.type]} block ${index + 1}`;

  return (
    <li
      className={`rounded-card border p-3 ${
        picking ? "border-lime" : "border-line"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 w-5 shrink-0 text-sm tabular-nums text-text-dim">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={row.type}
              onChange={(e) =>
                onChangeType(e.target.value as ClassPlanBlockWrite["type"])
              }
              aria-label={`Type for block ${index + 1}`}
              className="rounded-control border border-line bg-surface px-2 py-1.5 text-sm"
            >
              {BLOCK_TYPES.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="number"
                min={1}
                max={180}
                value={row.duration_minutes}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") return;
                  const n = Math.floor(Number(raw));
                  if (Number.isFinite(n) && n >= 1) {
                    onPatch({ duration_minutes: Math.min(n, 180) });
                  }
                }}
                aria-label={`Duration in minutes for ${rowLabel}`}
                className="w-16 rounded-control border border-line bg-surface px-2 py-1.5 text-sm tabular-nums"
              />
              <span className="text-text-muted">min</span>
            </label>
          </div>

          {row.type === "technique_drill" &&
            (row.technique_id ? (
              <div className="flex items-center justify-between gap-2 rounded-control border border-line bg-surface-raised px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {technique?.name ?? row.technique_id}
                  </p>
                  {technique?.position && (
                    <p className="text-xs text-text-dim">{technique.position}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onPatch({ technique_id: null, free_text: "" })}
                  aria-label={`Clear picked technique for ${rowLabel}`}
                  className="shrink-0 rounded px-2 py-1 text-sm text-text-muted hover:bg-surface-hover"
                >
                  ✕
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                <input
                  value={row.free_text ?? ""}
                  onChange={(e) =>
                    onPatch({ free_text: e.target.value, technique_id: null })
                  }
                  placeholder="Type the drill (not in the library)…"
                  aria-label={`Free-text drill for ${rowLabel}`}
                  className="w-full rounded-control border border-line bg-surface px-2 py-1.5 text-sm outline-none placeholder:text-text-dim focus:border-lime"
                />
                <button
                  type="button"
                  onClick={onPickFromLibrary}
                  className="text-xs font-medium text-lime hover:underline"
                >
                  {picking ? "Picking… click a technique on the left" : "Or pick from the library"}
                </button>
              </div>
            ))}

          <input
            value={row.notes ?? ""}
            onChange={(e) => onPatch({ notes: e.target.value })}
            placeholder={notesPlaceholder(row.type)}
            aria-label={
              row.type === "notes" ? `Content for ${rowLabel}` : `Notes for ${rowLabel}`
            }
            className="w-full rounded-control border border-line bg-surface px-2 py-1.5 text-sm outline-none placeholder:text-text-dim focus:border-lime"
          />
        </div>

        {/* Move controls are as prominent as remove — reordering a plan
            changes WHEN something happens in the hour, not merely its
            position on screen. */}
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={isFirst}
            aria-label={`Move ${rowLabel} earlier`}
            className="rounded px-2 py-1 text-sm hover:bg-surface-raised disabled:opacity-30"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={isLast}
            aria-label={`Move ${rowLabel} later`}
            className="rounded px-2 py-1 text-sm hover:bg-surface-raised disabled:opacity-30"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${rowLabel}`}
            className="rounded px-2 py-1 text-sm text-danger hover:bg-danger/10"
          >
            ✕
          </button>
        </div>
      </div>
    </li>
  );
}
