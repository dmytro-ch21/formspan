"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  archiveCurriculumEnrollment,
  deleteCurriculum,
  enrollInCurriculum,
  getBjjFocus,
  getCurriculum,
  setBjjFocus,
  type BjjFocus,
  type Curriculum,
  type CurriculumItem,
} from "@/lib/api";
import { groupByPhase } from "@/lib/curriculumPhases";
import { proposeFocus } from "@/lib/roadmapFocus";

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
  const [focus, setFocus] = useState<BjjFocus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        // Both, because the focus panel is a comparison: what the roadmap
        // wants against what the athlete already holds. One without the other
        // can only render half the answer.
        const [curriculum, current] = await Promise.all([
          getCurriculum(getToken, id, signal),
          getBjjFocus(getToken, signal),
        ]);
        setC(curriculum);
        setFocus(current);
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

  const applyFocus = useCallback(async () => {
    if (!c || !focus) return;
    setBusy(true);
    try {
      const p = proposeFocus(c.items ?? [], focus, c.id);
      // `fromRoadmap`, never `next` — the difference is the athlete's own
      // entries, which this roadmap carries along but does not own. Attributing
      // those to it would delete them when it is deactivated.
      await setBjjFocus(getToken, p.next, {
        curriculum_id: c.id,
        technique_ids: p.fromRoadmap,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [c, focus, getToken, load]);

  const remove = useCallback(async () => {
    if (!c) return;
    // Confirmed, matching every other destructive action on this dashboard
    // (workouts, sessions, the rank section) — all of which use this phrasing.
    // A single click destroying a syllabus somebody spent months on is not a
    // house idiom worth breaking.
    if (
      !window.confirm(
        `Delete "${c.name}"? This can't be undone.`,
      )
    ) {
      return;
    }
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
            {/* Keyed on `countable_items` — the real property — and NOT on the
            track, which CLAUDE.md calls a grouping hint that must never gate
            anything. "Start working this" on a list with nothing completable
            promises progress that can never arrive; on a reference syllabus
            that is 73 items of it. Enrolment still works and is still worth
            having: on a list with no criteria it is a bookmark, which is what
            an athlete's own curriculum has always been. */}
            {c.enrolled
              ? "Put down"
              : c.countable_items > 0
                ? "Start working this"
                : "Keep this handy"}
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
            Counted from what you have logged since{" "}
            {c.started_on ? formatDay(c.started_on) : "you started"} — anything
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

      {isRoadmap && c.enrolled && focus && (
        <FocusPanel
          proposal={proposeFocus(c.items ?? [], focus, c.id)}
          busy={busy}
          onApply={applyFocus}
        />
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {items.length} item{items.length === 1 ? "" : "s"}
        </h2>
        {items.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing in it yet.</p>
        ) : (
          <div className="space-y-6">
            {groupByPhase(c.phases ?? [], items).map((group) => (
              <div key={group.phase?.order ?? -1}>
                {group.phase ? (
                  <header className="mb-2">
                    <h3 className="font-semibold">{group.phase.title}</h3>
                    {group.phase.description && (
                      <p className="mt-0.5 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
                        {group.phase.description}
                      </p>
                    )}
                  </header>
                ) : (
                  (c.phases?.length ?? 0) > 0 && (
                    /* Only in a MIXED curriculum. Unphased items lead the
                       page, and without a heading they read as an untitled
                       preamble of the first phase rather than as items nobody
                       assigned. A flat curriculum keeps no chrome at all. */
                    <h3 className="mb-2 text-sm font-medium text-neutral-500">
                      Unassigned
                    </h3>
                  )
                )}
                <ul className="space-y-2">
                  {group.items.map((it) => (
                    <ItemRow key={it.order} item={it} enrolled={c.enrolled} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
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

/** Local-time construction, not `new Date("2026-08-05")` — that parses as UTC
 *  midnight and renders as the previous day for anyone west of Greenwich, which
 *  is the bug `Focus.StartedOn` carries a string for in the first place. */
function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
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

  if (item.kind === "concept") {
    // A concept is authored text — an idea the phase is teaching, not a step
    // the record can complete. No criteria block, no "something to study"
    // footer: its whole body IS the content, and dressing it as an incomplete
    // technique would misreport it.
    return (
      <li className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900/50">
        <p className="font-medium">{item.title}</p>
        {item.notes && (
          <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            {item.notes}
          </p>
        )}
      </li>
    );
  }

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
          {crit.target_drilled_sessions !== null && (
            <Bar
              label="Classes drilled"
              have={p?.drilled_sessions}
              need={crit.target_drilled_sessions}
              enrolled={enrolled}
            />
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

/**
 * The bridge, made visible before it is taken.
 *
 * This is the loop the whole feature rests on: a roadmap's next techniques
 * become focus rows, focus rows already render as one-tap chips in the mobile
 * reflection wizard, those chips write technique-tagged events, and those
 * events are precisely what the completion criteria read. Everything but this
 * selection shipped months ago.
 *
 * **It shows the consequence first because `PUT /v1/bjj/focus` replaces the
 * list wholesale.** A one-tap "put my roadmap in focus" that quietly dropped
 * three techniques the athlete had chosen by hand would be the app taking
 * something without asking. So the panel names what leaves, and distinguishes
 * the two reasons — a mastered technique leaving is the machine working, an
 * evicted one is the athlete losing a choice to the five-slot cap.
 */
function FocusPanel({
  proposal,
  busy,
  onApply,
}: {
  proposal: ReturnType<typeof proposeFocus>;
  busy: boolean;
  onApply: () => void;
}) {
  const evicted = proposal.dropped.filter((d) => d.reason === "evicted");
  const finished = proposal.dropped.filter((d) => d.reason === "mastered");

  if (proposal.unchanged) {
    return (
      <section className="rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <h2 className="font-semibold">Focus</h2>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          {proposal.next.length === 0
            ? // Every step mastered, or none has criteria. Either way there is
              // nothing to work, and offering a button that writes an identical
              // list would be an action that does nothing.
              "Nothing left to work on this one."
            : "Your focus already matches this roadmap — these show as one-tap chips when you log a session."}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      {/* N100's claim-only case: `unchanged` is false (this roadmap has a
          real claim left to register) but `added` is empty — every one of
          its techniques is already in focus, via a first roadmap or by hand.
          "Work these next" over an empty chip list reads as broken; say what
          the button actually does instead. Mirrors the mobile menu's own
          `proposal.added.length > 0 ? … : 'Update your focus for this
          roadmap'` split in `curriculum/[id].tsx`. */}
      <h2 className="text-sm font-semibold">
        {proposal.added.length > 0 ? "Work these next" : "Update your focus for this roadmap"}
      </h2>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
        {proposal.added.length > 0
          ? "Putting them in your focus list makes them one-tap chips in the phone's reflection wizard — which is what records the evidence these criteria read. Otherwise you would be naming them by hand out of 542."
          : "Every technique here is already in your focus — this registers this roadmap as a reason for it, so deactivating a different roadmap that shares it won't take it out of your focus while you're still working it."}
      </p>

      {proposal.added.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {proposal.added.map((it) => (
            <li
              key={it.technique_id}
              className="rounded-full border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700"
            >
              {it.name}
            </li>
          ))}
        </ul>
      )}

      {finished.length > 0 && (
        <p className="mt-3 text-xs text-neutral-600 dark:text-neutral-400">
          Making room by retiring{" "}
          {finished.map((d) => d.focus.name).join(", ")} — your record already
          clears {finished.length === 1 ? "it" : "them"}.
        </p>
      )}

      {evicted.length > 0 && (
        /* The only destructive case, said plainly. Five slots is the cap, and
           the cap is the feature — a focus list of twenty is the library
           again. But which five is the athlete's call, so this cannot be a
           surprise. */
        <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          This will drop {evicted.map((d) => d.focus.name).join(", ")} from your
          focus list to stay within five. You can put{" "}
          {evicted.length === 1 ? "it" : "them"} back from the technique funnel.
        </p>
      )}

      <button
        type="button"
        onClick={onApply}
        disabled={busy}
        className="mt-3 rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        {busy
          ? "Saving…"
          : proposal.added.length > 0
            ? "Put these in my focus"
            : "Update my focus"}
      </button>
    </section>
  );
}
