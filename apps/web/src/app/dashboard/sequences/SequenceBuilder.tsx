"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  MAX_SEQUENCE_STEPS,
  createSequence,
  listPositions,
  listTechniques,
  rankTechniques,
  updateSequence,
  type Position,
  type Sequence,
  type SequenceStepWrite,
  type TechniqueSummary,
} from "@/lib/api";

/**
 * Building a sequence: catalog on the left, the chain on the right.
 *
 * The same two-pane shape the curriculum and workout builders use, for the same
 * reason — you are picking from a catalog too big to remember, so it has to
 * stay visible while you assemble. **Web, per the platform rule**: choosing
 * four techniques out of 634 and saying where each one leaves you is a desk
 * activity, not something done between rounds.
 *
 * WHAT THIS SCREEN HAS TO TEACH, because nothing else will:
 *
 *  - **A sequence is a chain, not a list.** The order is causal — this move
 *    puts you where the next one starts — so the builder draws the positions
 *    BETWEEN the steps rather than only the steps. That is also what makes a
 *    gap visible: a step whose destination is unrecorded shows the next step
 *    starting from nowhere, which is the prompt to fill it in.
 *  - **Chains are linear.** "…and if he defends, armbar or kimura" is two
 *    sequences sharing a prefix. There is deliberately no branch affordance.
 *
 * TWO THINGS THAT DIFFER FROM CurriculumBuilder AND WILL BITE A COPY-PASTE:
 *
 *  1. **A repeated technique is legal here** — sweep, get passed, sweep again
 *     is ordinary grappling. So the catalog never disables an already-used
 *     entry, and rows CANNOT be keyed on `technique_id`; they carry their own
 *     uid. Keyed on the technique, adding a duplicate makes React reuse one
 *     row's DOM for two steps and the notes swap between them.
 *  2. **Order is the content.** Reordering is not a convenience, it changes
 *     what the sequence claims, which is why the move controls are as
 *     prominent as the remove one.
 */

/** One row of local state. `uid` exists only to key the list — see above. */
type Row = SequenceStepWrite & { uid: string };

/**
 * A key that is unique and does not depend on call order.
 *
 * This was a module-level `uidCounter++`, which is an impure read-modify-write
 * inside a `useState` initialiser and a `setRows` updater — precisely what
 * StrictMode's double-invocation exists to surface. It happened to be safe
 * (monotonic, so a value can be burned but never reused), but "safe because I
 * traced every path" is worse than "safe by construction".
 */
function nextUID(): string {
  return crypto.randomUUID();
}

export function SequenceBuilder({ existing }: { existing?: Sequence }) {
  const { getToken } = useAuth();
  const router = useRouter();

  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [startPosition, setStartPosition] = useState<string>(
    existing?.start_position_id ?? "",
  );
  const [rows, setRows] = useState<Row[]>(
    () =>
      existing?.steps?.map((s) => ({
        uid: nextUID(),
        technique_id: s.technique_id,
        ends_at_position_id: s.ends_at_position_id,
        notes: s.notes,
      })) ?? [],
  );

  // null is "still loading" and [] is "genuinely empty". Collapsing them shows
  // "Nothing matches." while the catalog is in flight, which on a builder reads
  // as "the library is empty" — the exact confusion the fetch effect's own
  // comment warns about, just for the duration of the request.
  const [catalog, setCatalog] = useState<TechniqueSummary[] | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new AbortController();
    // Both fetched here rather than per-row: the position select appears once
    // per step, and a fetch inside the row component is the N+1 in its lazy
    // form. Failures are reported rather than swallowed — a builder that
    // silently offers an empty catalog looks like the library is empty.
    Promise.all([
      listTechniques(getToken, c.signal),
      listPositions(getToken, c.signal),
    ])
      .then(([t, p]) => {
        setCatalog(t);
        setPositions(p);
      })
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
  const positionName = useMemo(
    () => new Map(positions.map((p) => [p.id, p.name])),
    [positions],
  );

  const results = useMemo(() => {
    // `rankTechniques`, not `searchTechniques`: this is a capped picker, and a
    // cap over unranked results is what made "side control" (58 matches) look
    // like the library was missing the obvious ones.
    //
    // NOTE the absence of a `chosen` exclusion, unlike CurriculumBuilder — a
    // repeated technique is legal in a chain.
    return rankTechniques(catalog ?? [], query).slice(0, 60);
  }, [catalog, query]);

  const full = rows.length >= MAX_SEQUENCE_STEPS;

  const add = useCallback(
    (id: string) => {
      setRows((prev) =>
        prev.length >= MAX_SEQUENCE_STEPS
          ? prev
          : [
              ...prev,
              { uid: nextUID(), technique_id: id, ends_at_position_id: null, notes: "" },
            ],
      );
    },
    [],
  );

  const removeAt = useCallback((idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }, []);

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

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        // Empty select means "not recorded", which is null rather than "". The
        // API treats an explicit null as CLEAR, which is what makes it possible
        // to un-set a start position that was picked by mistake.
        start_position_id: startPosition === "" ? null : startPosition,
        // uid is local-only and must not reach the wire.
        steps: rows.map(({ technique_id, ends_at_position_id, notes }) => ({
          technique_id,
          ends_at_position_id: ends_at_position_id ?? null,
          notes: notes ?? "",
        })),
      };
      const saved = existing
        ? await updateSequence(getToken, existing.id, payload)
        : await createSequence(getToken, payload);
      router.push(`/dashboard/sequences/${saved.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }, [description, existing, getToken, name, rows, router, startPosition]);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">
          {existing ? "Edit sequence" : "New sequence"}
        </h1>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Closed guard to side control"
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Starts from</span>
            <select
              value={startPosition}
              onChange={(e) => setStartPosition(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              {/* "Not recorded" first and selected by default: a chain whose
                  start nobody named is still a chain, and forcing a guess here
                  would put invented data in front of the real steps. */}
              <option value="">Not recorded</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-medium">Notes</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Tuesday beginners class"
            className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
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
          {full && (
            <p className="mt-2 rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
              {MAX_SEQUENCE_STEPS} steps is the limit. A chain much longer than
              that is a curriculum wearing the wrong shape.
            </p>
          )}
          <ul className="mt-2 max-h-[28rem] space-y-1 overflow-y-auto pr-1">
            {results.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => add(t.id)}
                  disabled={full}
                  className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-900"
                >
                  <span className="font-medium">{t.name}</span>
                  <span className="block text-xs text-neutral-500">
                    {t.position}
                  </span>
                </button>
              </li>
            ))}
            {catalog === null && (
              <li className="px-2 py-4 text-sm text-neutral-500">Loading…</li>
            )}
            {catalog !== null && results.length === 0 && (
              <li className="px-2 py-4 text-sm text-neutral-500">
                Nothing matches.
              </li>
            )}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            The chain ({rows.length})
          </h2>

          {rows.length === 0 ? (
            <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
              Add techniques from the library, in the order the class taught
              them. Say where each one leaves you and the chain draws itself.
            </p>
          ) : (
            <ol className="space-y-2">
              {/* The opening node. Rendered as a position rather than a step so
                  the chain reads the way it was taught — "from closed guard,
                  break…" — and so step 1 has something to come from. */}
              <ChainNode
                label={
                  startPosition
                    ? (positionName.get(startPosition) ?? "Unknown position")
                    : "Start not recorded"
                }
                muted={!startPosition}
              />
              {rows.map((r, idx) => (
                <StepRow
                  key={r.uid}
                  row={r}
                  index={idx}
                  technique={byID.get(r.technique_id)}
                  positions={positions}
                  positionName={positionName}
                  isFirst={idx === 0}
                  isLast={idx === rows.length - 1}
                  onMove={(d) => move(idx, d)}
                  onRemove={() => removeAt(idx)}
                  onPatch={(patch) => patchRow(idx, patch)}
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
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          {saving ? "Saving…" : existing ? "Save changes" : "Create sequence"}
        </button>
        {name.trim() === "" && (
          <span className="text-sm text-neutral-500">
            A name is all a list row can show, so it is the one required field.
          </span>
        )}
      </div>
    </div>
  );
}

/** A position in the chain — the rails the steps run between. */
function ChainNode({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <li className="flex items-center gap-2 pl-1 text-sm">
      <span
        aria-hidden
        className="inline-block h-2 w-2 shrink-0 rounded-full bg-neutral-400 dark:bg-neutral-600"
      />
      <span
        className={
          muted
            ? "italic text-neutral-400 dark:text-neutral-600"
            : "font-medium text-neutral-600 dark:text-neutral-400"
        }
      >
        {label}
      </span>
    </li>
  );
}

function StepRow({
  row,
  index,
  technique,
  positions,
  positionName,
  isFirst,
  isLast,
  onMove,
  onRemove,
  onPatch,
}: {
  row: Row;
  index: number;
  technique?: TechniqueSummary;
  positions: Position[];
  positionName: Map<string, string>;
  isFirst: boolean;
  isLast: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onPatch: (patch: Partial<Row>) => void;
}) {
  const endsAt = row.ends_at_position_id ?? "";
  // A submission ends the exchange; anything else with no destination is simply
  // unrecorded. Both are a null id, and `function` is the only thing that tells
  // them apart — drawing them identically would tell the athlete a finished
  // armbar left them nowhere.
  const finishes = technique?.function === "finish";

  return (
    <>
      <li className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 w-5 shrink-0 text-sm tabular-nums text-neutral-400">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <p className="font-medium">
                {technique?.name ?? row.technique_id}
              </p>
              <p className="text-xs text-neutral-500">
                {technique?.position}
                {technique?.category ? ` · ${technique.category}` : ""}
              </p>
            </div>

            <label className="block">
              <span className="text-xs font-medium text-neutral-500">
                Leaves you in
              </span>
              <select
                value={endsAt}
                onChange={(e) =>
                  onPatch({
                    ends_at_position_id:
                      e.target.value === "" ? null : e.target.value,
                  })
                }
                className="mt-1 w-full rounded-lg border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="">
                  {finishes ? "Ends the exchange" : "Not recorded"}
                </option>
                {positions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <input
              value={row.notes ?? ""}
              onChange={(e) => onPatch({ notes: e.target.value })}
              placeholder="How your coach does it, what they were defending…"
              aria-label={`Notes for ${technique?.name ?? "this step"}`}
              className="w-full rounded-lg border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </div>

          {/* Move controls are as prominent as remove, because reordering a
              chain changes what it CLAIMS rather than merely tidying it. */}
          <div className="flex shrink-0 flex-col gap-1">
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={isFirst}
              aria-label={`Move ${technique?.name ?? "step"} earlier`}
              className="rounded px-2 py-1 text-sm hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={isLast}
              aria-label={`Move ${technique?.name ?? "step"} later`}
              className="rounded px-2 py-1 text-sm hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${technique?.name ?? "step"}`}
              className="rounded px-2 py-1 text-sm text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
            >
              ✕
            </button>
          </div>
        </div>
      </li>

      {/* Where this step leaves you, drawn as the next node so the chain reads
          continuously. A finish closes the chain; an unrecorded destination is
          shown as a gap on purpose — that is the prompt to fill it in, and the
          data the library is missing. */}
      <ChainNode
        label={
          endsAt
            ? (positionName.get(endsAt) ?? "Unknown position")
            : finishes
              ? "Ends the exchange"
              : "Not recorded"
        }
        // A finish is a definite outcome; only genuinely-missing data gets the
        // gap styling. See the detail view for the same call.
        muted={!endsAt && !finishes}
      />
    </>
  );
}
