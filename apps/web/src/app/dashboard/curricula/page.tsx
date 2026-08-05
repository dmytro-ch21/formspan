"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  archiveCurriculumEnrollment,
  enrollInCurriculum,
  listCurricula,
  type Curriculum,
} from "@/lib/api";

/**
 * Curricula and roadmaps, at desk depth.
 *
 * **Web, per the platform rule, and the design doc says so in as many words:**
 * "roadmap *building* and the full funnel on web", in on Plan and out on Today.
 * Choosing a dozen techniques out of a 466-entry catalog and setting what
 * mastering each one takes is not something anyone does between rounds.
 *
 * The two ideas this screen has to teach, because nothing else will:
 *
 *  - **A roadmap is a curriculum whose items carry criteria.** Not a separate
 *    kind of thing. That is why one card can read "12 techniques · 4 with
 *    criteria" without contradicting itself.
 *  - **Progress counts only the items that carry criteria.** The API ships
 *    `countable_items` precisely so no client divides by `items.length` and
 *    quietly reports a different number than the next one does.
 */

/** Belts in rank order, so a list sorts the way an athlete thinks. The API
 *  deliberately does not do this — `belt` is unconstrained TEXT so the kids
 *  belts stay an enum edit — which makes ordering the client's job. */
const BELT_ORDER = ["white", "blue", "purple", "brown", "black"];

function beltRank(belt: string | null): number {
  if (!belt) return BELT_ORDER.length;
  const i = BELT_ORDER.indexOf(belt.toLowerCase());
  return i === -1 ? BELT_ORDER.length : i;
}

type Scope = "mine" | "shared";

export default function CurriculaPage() {
  const { getToken } = useAuth();
  const [all, setAll] = useState<Curriculum[] | null>(null);
  const [scope, setScope] = useState<Scope>("mine");
  const [error, setError] = useState<string | null>(null);
  /** The id currently being enrolled/archived, so one card can show its own
   *  pending state without the whole list going inert. */
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setAll(await listCurricula(getToken, signal));
        setError(null);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [getToken],
  );

  useEffect(() => {
    const c = new AbortController();
    // Disabled for the same reason proficiency/page.tsx does: `load` awaits
    // the network before it setStates, so nothing here is synchronous — the
    // rule cannot see through the async boundary and flags the call site.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  /**
   * `editable` is the split, NOT `enrolled`.
   *
   * "Mine" means the ones you can change; a seeded belt syllabus you are
   * working is emphatically not yours to edit, and putting it under Mine would
   * promise an edit affordance that 403s.
   */
  const mine = useMemo(() => (all ?? []).filter((c) => c.editable), [all]);
  const shared = useMemo(() => (all ?? []).filter((c) => !c.editable), [all]);

  const shown = useMemo(() => {
    const list = scope === "mine" ? mine : shared;
    return [...list].sort(
      (a, b) =>
        Number(b.enrolled) - Number(a.enrolled) ||
        beltRank(a.belt) - beltRank(b.belt) ||
        a.name.localeCompare(b.name),
    );
  }, [scope, mine, shared]);

  const toggleEnrollment = useCallback(
    async (c: Curriculum) => {
      setBusy(c.id);
      try {
        if (c.enrolled) await archiveCurriculumEnrollment(getToken, c.id);
        else await enrollInCurriculum(getToken, c.id);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [getToken, load],
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Curricula</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
            An ordered set of techniques to learn. Give its entries completion
            criteria and it becomes a roadmap you can finish — worked over
            months, and marked off from what you log rather than by hand.
          </p>
        </div>
        <Link
          href="/dashboard/curricula/new"
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          New curriculum
        </Link>
      </header>

      {/* The same My / Shared strip Workouts uses. The sharing model is
          identical — nullable owner plus visibility — so a second idiom here
          would be a second thing to learn for no reason. */}
      <div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {(
          [
            ["mine", `Mine${mine.length ? ` (${mine.length})` : ""}`],
            ["shared", `Shared${shared.length ? ` (${shared.length})` : ""}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setScope(key)}
            aria-current={scope === key ? "page" : undefined}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              scope === key
                ? "border-neutral-900 text-neutral-900 dark:border-white dark:text-white"
                : "border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {all === null && !error && (
        <p className="text-sm text-neutral-500">Loading…</p>
      )}

      {all !== null && shown.length === 0 && (
        <EmptyState scope={scope} />
      )}

      <ul className="grid gap-4 sm:grid-cols-2">
        {shown.map((c) => (
          <CurriculumCard
            key={c.id}
            curriculum={c}
            busy={busy === c.id}
            onToggleEnrollment={() => toggleEnrollment(c)}
          />
        ))}
      </ul>
    </div>
  );
}

function EmptyState({ scope }: { scope: Scope }) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 px-6 py-10 text-center dark:border-neutral-700">
      {scope === "mine" ? (
        <>
          <p className="text-sm font-medium">No curricula yet.</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-neutral-600 dark:text-neutral-400">
            Build one from the technique library — a few things you want to own
            this year, and what landing them would have to look like.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium">Nothing shared with you yet.</p>
          {/* Honest about why, rather than implying the athlete has missed
              something. The belt syllabuses genuinely do not exist yet: the
              seed path for VOLA-authored curricula is unstarted work. */}
          <p className="mx-auto mt-1 max-w-md text-sm text-neutral-600 dark:text-neutral-400">
            The belt-level fundamentals are still being written. Anything
            another athlete publishes will show up here too.
          </p>
        </>
      )}
    </div>
  );
}

function CurriculumCard({
  curriculum: c,
  busy,
  onToggleEnrollment,
}: {
  curriculum: Curriculum;
  busy: boolean;
  onToggleEnrollment: () => void;
}) {
  const isRoadmap = c.countable_items > 0;

  return (
    <li className="flex flex-col rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-3">
        <Link
          href={`/dashboard/curricula/${c.id}`}
          className="text-base font-semibold hover:underline"
        >
          {c.name}
        </Link>
        {c.belt && (
          <span className="shrink-0 rounded-full border border-neutral-300 px-2 py-0.5 text-xs capitalize text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
            {c.belt}
          </span>
        )}
      </div>

      {c.description && (
        <p className="mt-1 line-clamp-2 text-sm text-neutral-600 dark:text-neutral-400">
          {c.description}
        </p>
      )}

      <div className="mt-3 grow">
        {isRoadmap ? (
          <Progress mastered={c.mastered_items} countable={c.countable_items} enrolled={c.enrolled} />
        ) : (
          /* Not "0%". A curriculum with no criteria cannot be completed, and a
             zeroed bar reads as failure at something that was never asked. */
          <p className="text-sm text-neutral-500">
            A reading list — no completion criteria.
          </p>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleEnrollment}
          disabled={busy}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
            c.enrolled
              ? "border border-neutral-300 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
              : "bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          }`}
        >
          {busy ? "…" : c.enrolled ? "Put down" : "Start working this"}
        </button>
        {c.enrolled && c.started_on && (
          <span className="text-xs text-neutral-500">
            since {c.started_on}
          </span>
        )}
      </div>
    </li>
  );
}

function Progress({
  mastered,
  countable,
  enrolled,
}: {
  mastered: number;
  countable: number;
  enrolled: boolean;
}) {
  /*
   * The denominator is `countable_items`, never `items.length`. A ten-item
   * curriculum with three roadmap steps is three items' worth of progress, not
   * three tenths — the API ships the count so this cannot drift between
   * clients.
   */
  const pct = countable === 0 ? 0 : Math.round((mastered / countable) * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">
          {enrolled ? `${mastered} of ${countable}` : `${countable} to master`}
        </span>
        {enrolled && (
          <span className="text-neutral-500">{pct}%</span>
        )}
      </div>
      {enrolled && (
        <div
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
          role="progressbar"
          aria-valuenow={mastered}
          aria-valuemin={0}
          aria-valuemax={countable}
          aria-label={`${mastered} of ${countable} techniques mastered`}
        >
          <div
            className="h-full rounded-full bg-lime-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
