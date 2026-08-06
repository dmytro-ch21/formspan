"use client";

import Image from "next/image";
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
 * Choosing a dozen techniques out of a 542-entry catalog and setting what
 * mastering each one takes is not something anyone does between rounds.
 *
 * The two ideas this screen has to teach, because nothing else will:
 *
 *  - **A roadmap is a curriculum whose items carry criteria.** Not a separate
 *    kind of thing, which is why a card reads "12 techniques · 4 to master"
 *    rather than picking one label for the whole row.
 *  - **Progress counts only the items that carry criteria.** The API ships
 *    `countable_items` precisely so no client divides by `items.length` and
 *    quietly reports a different number than the next one does.
 */

/** Belts in rank order, so a list sorts the way an athlete thinks. The API
 *  deliberately does not do this — `belt` is unconstrained TEXT so the kids
 *  belts stay an enum edit — which makes ordering the client's job. */
const BELT_ORDER = ["white", "blue", "purple", "brown", "black"] as const;

type Belt = (typeof BELT_ORDER)[number];

/**
 * The belt renders, as card covers.
 *
 * The artwork is a cut-out on a TRANSPARENT ground, so it needs something
 * behind it — hence the band colour per belt. These are deliberately muted
 * rather than the belt's own colour at full strength: the card is mostly text,
 * and a saturated purple band would make the syllabus harder to read than the
 * one next to it, which is the opposite of what a cover is for.
 *
 * White gets a warm grey rather than white-on-white, and black a lifted
 * charcoal rather than pure black, so both belts stay visible against the
 * card in either theme.
 */
const BELT_BAND: Record<Belt, string> = {
  white: "bg-stone-200 dark:bg-stone-800",
  blue: "bg-sky-100 dark:bg-sky-950",
  purple: "bg-violet-100 dark:bg-violet-950",
  brown: "bg-amber-100 dark:bg-amber-950",
  black: "bg-neutral-200 dark:bg-neutral-800",
};

function beltOf(belt: string | null): Belt | null {
  if (!belt) return null;
  const b = belt.toLowerCase();
  return (BELT_ORDER as readonly string[]).includes(b) ? (b as Belt) : null;
}

function beltRank(belt: string | null): number {
  const b = beltOf(belt);
  // Unranked belts sort last rather than first: an athlete's own curriculum has
  // no belt at all, and `indexOf` returning -1 would float it above white.
  return b === null ? BELT_ORDER.length : BELT_ORDER.indexOf(b);
}

type Scope = "mine" | "shared";

/** A DATE column, rendered in the reader's locale rather than as the wire's
 *  `YYYY-MM-DD` — the idiom every other dashboard screen uses. */
function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  // Constructed in LOCAL time, not `new Date("2026-08-05")`, which parses as
  // UTC midnight and renders as the previous day for anyone west of Greenwich.
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

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
            // `aria-pressed`, not `aria-current="page"` — these filter in
            // place rather than navigating, and "page" tells a screen reader
            // this links to where you already are. Matches workouts/page.tsx.
            aria-pressed={scope === key}
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
  const belt = beltOf(c.belt);

  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
      {belt && (
        /*
          Only for belt syllabuses. An athlete's own "guard passing for the
          winter" has no belt and gets no cover — putting one there would imply
          a rank it never claimed, and the belt field is explicitly a hint for
          ordering rather than a statement about who may work this.
        */
        <div className={`flex h-24 items-center justify-center ${BELT_BAND[belt]}`}>
          <Image
            src={`/belts/${belt}.webp`}
            // Decorative: the belt is named in the pill beside the title and
            // again in the card's own text, so announcing it here would make a
            // screen reader say it three times.
            alt=""
            aria-hidden="true"
            width={1024}
            height={683}
            // The render is 1024×683; this draws it at ~220px, so the intrinsic
            // size is for aspect and the sizes hint stops Next serving the full
            // width to a card two-up on a phone.
            sizes="(max-width: 640px) 90vw, 320px"
            className="h-auto w-[70%] max-w-[220px] object-contain drop-shadow-sm"
          />
        </div>
      )}
      <div className="flex grow flex-col p-4">
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
        {/*
          WHAT IT IS, NOT HOW FAR ALONG. `mastered_items` is zero on the list
          response by design — computing it needs the per-curriculum evidence
          aggregate, which is not run once per row — so a progress bar here
          would render a placeholder as fact. An earlier version of this card
          did exactly that in reverse: it read `countable_items`, which was also
          absent then, and told every athlete their roadmap was a reading list.
          Progress lives on the detail screen, which has the numbers.
        */}
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {c.item_count} technique{c.item_count === 1 ? "" : "s"}
          {isRoadmap ? (
            <> · {c.countable_items} to master</>
          ) : (
            /* Not "0 to master", which reads as a roadmap you have failed at.
               A curriculum with no criteria was never asking to be completed. */
            <> · a reading list</>
          )}
        </p>
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
            since {formatDay(c.started_on)}
          </span>
        )}
      </div>
      </div>
    </li>
  );
}
