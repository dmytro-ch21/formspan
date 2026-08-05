"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  archiveCurriculumEnrollment,
  deleteCurriculum,
  enrollInCurriculum,
  getCurriculum,
  type Curriculum,
  type CurriculumItem,
} from "@/lib/api";

/**
 * One curriculum, and — if you are working it — how far along you are.
 *
 * **What this screen has to get right is the honesty of the numbers.** Three
 * properties of the model are surprising enough that showing them badly would
 * be worse than not showing them:
 *
 *  1. **Progress is measured since you enrolled.** Somebody who has drilled the
 *     arm drag for two years starts at zero on the day they take on a roadmap
 *     containing it. That is correct — over all time the hit rate includes the
 *     months they could not do it, which is the learning phase the criterion
 *     exists to exclude — but it looks like a bug unless the screen says so.
 *  2. **Mastery can be lost.** It is derived on every read, not stored, so a
 *     long enough bad run takes it back. The copy therefore says "your record
 *     shows", never "you have earned".
 *  3. **Not every item counts.** Items without criteria are reading, and the
 *     denominator is `countable_items`.
 */
export default function CurriculumDetailPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [c, setC] = useState<Curriculum | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setC(await getCurriculum(getToken, id, signal));
        setError(null);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [getToken, id],
  );

  useEffect(() => {
    if (!id) return;
    const ctl = new AbortController();
    // Disabled for the same reason proficiency/page.tsx does: `load` awaits
    // the network before it setStates, so nothing here is synchronous — the
    // rule cannot see through the async boundary and flags the call site.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(ctl.signal);
    return () => ctl.abort();
  }, [id, load]);

  const toggleEnrollment = useCallback(async () => {
    if (!c) return;
    setBusy(true);
    try {
      if (c.enrolled) await archiveCurriculumEnrollment(getToken, c.id);
      else await enrollInCurriculum(getToken, c.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [c, getToken, load]);

  const remove = useCallback(async () => {
    if (!c) return;
    setBusy(true);
    try {
      await deleteCurriculum(getToken, c.id);
      router.push("/dashboard/curricula");
    } catch (err) {
      // The API refuses with 409 when other athletes are working this — their
      // enrollment is their record, not the publisher's. Surfacing the API's
      // own message is right here: it says exactly that.
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [c, getToken, router]);

  if (error && !c) {
    return (
      <div className="space-y-4">
        <Back />
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      </div>
    );
  }
  if (!c) return <p className="text-sm text-neutral-500">Loading…</p>;

  const items = c.items ?? [];
  const isRoadmap = c.countable_items > 0;

  return (
    <div className="space-y-6">
      <Back />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{c.name}</h1>
            {c.belt && (
              <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs capitalize text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
                {c.belt}
              </span>
            )}
          </div>
          {c.description && (
            <p className="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
              {c.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {c.editable && (
            <Link
              href={`/dashboard/curricula/${c.id}/edit`}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Edit
            </Link>
          )}
          <button
            type="button"
            onClick={toggleEnrollment}
            disabled={busy}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
              c.enrolled
                ? "border border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                : "bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            }`}
          >
            {c.enrolled ? "Put down" : "Start working this"}
          </button>
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

      {isRoadmap && c.enrolled && (
        <section className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm">
            <span className="text-2xl font-semibold">{c.mastered_items}</span>
            <span className="text-neutral-500"> of {c.countable_items} mastered</span>
          </p>
          {/*
            The two sentences this whole screen exists to say. Both are
            surprising, both are correct, and neither is discoverable.
          */}
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
            Counted from what you have logged since {c.started_on} — anything
            before that does not count toward this, because a rate measured over
            your whole history mostly measures the months you were still
            learning. Your record decides these, so a long run of misses can
            take one back.
          </p>
        </section>
      )}

      {isRoadmap && !c.enrolled && (
        <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
          {c.countable_items} of these have completion criteria. Start working
          this to begin counting — the clock runs from the day you take it on.
        </p>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {items.length} technique{items.length === 1 ? "" : "s"}
        </h2>
        {items.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing in it yet.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((it) => (
              <ItemRow key={it.technique_id} item={it} enrolled={c.enrolled} />
            ))}
          </ul>
        )}
      </section>

      {c.editable && (
        <section className="border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="text-sm text-red-700 hover:underline disabled:opacity-50 dark:text-red-400"
          >
            Delete this curriculum
          </button>
        </section>
      )}
    </div>
  );
}

function Back() {
  return (
    <Link
      href="/dashboard/curricula"
      className="text-sm text-neutral-500 hover:underline"
    >
      ← Curricula
    </Link>
  );
}

function ItemRow({ item, enrolled }: { item: CurriculumItem; enrolled: boolean }) {
  const { criteria: crit, progress: p } = item;
  const mastered = p?.mastered ?? false;

  return (
    <li
      className={`rounded-xl border p-3 ${
        mastered
          ? "border-lime-300 bg-lime-50 dark:border-lime-900 dark:bg-lime-950/30"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">
            {item.name}
            {mastered && (
              <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-lime-700 dark:text-lime-400">
                Mastered
              </span>
            )}
          </p>
          <p className="text-xs text-neutral-500">
            {item.position}
            {item.category ? ` · ${item.category}` : ""}
          </p>
          {item.notes && (
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {item.notes}
            </p>
          )}
        </div>
      </div>

      {!crit && (
        /* Reading, not a roadmap step. Said explicitly so its lack of numbers
           reads as deliberate rather than as missing data. */
        <p className="mt-2 text-xs text-neutral-500">
          No completion criteria — something to study.
        </p>
      )}

      {crit && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          {crit.target_scored !== null && (
            <Bar label="Landed" have={p?.scored} need={crit.target_scored} enrolled={enrolled} />
          )}
          {crit.target_defended !== null && (
            <Bar label="Stopped theirs" have={p?.defended} need={crit.target_defended} enrolled={enrolled} />
          )}
          {crit.target_sessions !== null && (
            <Bar label="Sessions" have={p?.sessions} need={crit.target_sessions} enrolled={enrolled} />
          )}
          {crit.min_hit_rate !== null && (
            <HitRate have={p?.hit_rate ?? null} need={crit.min_hit_rate} enrolled={enrolled} />
          )}
        </dl>
      )}
    </li>
  );
}

function Bar({
  label,
  have,
  need,
  enrolled,
}: {
  label: string;
  have: number | undefined;
  need: number;
  enrolled: boolean;
}) {
  const got = have ?? 0;
  const pct = Math.min(100, Math.round((got / need) * 100));
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">
        {enrolled ? `${got} / ${need}` : need}
      </dd>
      {enrolled && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div
            className={`h-full rounded-full ${got >= need ? "bg-lime-500" : "bg-neutral-400"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function HitRate({
  have,
  need,
  enrolled,
}: {
  have: number | null;
  need: number;
  enrolled: boolean;
}) {
  const pctOf = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div>
      <dt className="text-xs text-neutral-500">Hit rate</dt>
      <dd className="text-sm font-medium tabular-nums">
        {/*
          `—`, not `0%`. Zero from zero is not a rate, and rendering it as a
          zero reports a failure the athlete has not had. The API sends null
          for exactly this reason; throwing that away here would undo it.
        */}
        {enrolled ? `${have === null ? "—" : pctOf(have)} / ${pctOf(need)}` : pctOf(need)}
      </dd>
      {enrolled && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div
            className={`h-full rounded-full ${have !== null && have >= need ? "bg-lime-500" : "bg-neutral-400"}`}
            style={{ width: `${have === null ? 0 : Math.min(100, Math.round((have / need) * 100))}%` }}
          />
        </div>
      )}
    </div>
  );
}
