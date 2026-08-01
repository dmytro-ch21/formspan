"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  edgeKey,
  executionSteps,
  getTechnique,
  indexTechniques,
  listExercises,
  listRulesets,
  listTechniques,
  pickImage,
  searchTechniques,
  SPORTS,
  type Exercise,
  type Ruleset,
  type Technique,
  type TechniqueSummary,
} from "@/lib/api";
import {
  ACCENT_CLASS,
  categoryBadge,
  inPositionFamily,
  patternBadge,
  POSITIONS,
  type Accent,
} from "@/lib/libraryTiles";

const LOAD_LABEL: Record<Exercise["load_type"], string> = {
  weight_reps: "Weight × reps",
  reps: "Reps",
  time: "Time",
  distance: "Distance",
  distance_time: "Distance & time",
};

/**
 * The Library on desktop — the exercise catalog **and** the 466 BJJ techniques,
 * in one grid.
 *
 * One library, matching the phone. Techniques are not a separate destination
 * here for the same reason they aren't there: they'd need a second search box,
 * and the "BJJ" chip would return twenty bear-crawl drills while the actual
 * techniques lived somewhere else.
 *
 * What the wide screen adds, and the phone can't: the detail panel sits beside
 * the grid rather than replacing it, so **following a technique's graph costs
 * nothing.** Tapping "Armbar from Closed Guard" under Common next moves swaps
 * the panel and leaves your list, scroll position and search exactly where they
 * were. On a phone that same tap is a push-navigation you have to unwind. This
 * is the desk surface doing the thing a desk surface is for — reading around a
 * subject — which is why the full prose, the legality table and the graph all
 * live in the panel rather than being trimmed for width.
 *
 * Fetch shape: exercises are filtered server-side (debounced, cancellable);
 * techniques are fetched **once** (~65 KB for all 466) and filtered in memory.
 * Same search box, different plumbing.
 */

/** Sports whose content includes techniques. */
const HAS_TECHNIQUES = new Set(["", "bjj"]);

/**
 * Position is a BJJ-only axis, so its chips render only under the BJJ filter —
 * which means the filter may only be *applied* there too. Applying it whenever
 * techniques were on screen (which includes "All") would leave a stale
 * selection narrowing the grid with its control nowhere in sight.
 */
function usesPosition(sport: string): boolean {
  return sport === "bjj";
}

/**
 * One collator, built once. `localeCompare` re-enters ICU per call; the sources
 * are kept pre-sorted and merged linearly so a keystroke costs ~990
 * comparisons rather than a full re-sort.
 */
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

type Row =
  | { kind: "exercise"; key: string; name: string; ex: Exercise }
  | { kind: "technique"; key: string; name: string; t: TechniqueSummary };

type Selection =
  { kind: "exercise"; ex: Exercise } | { kind: "technique"; id: string };

export default function LibraryPage() {
  const { getToken } = useAuth();

  const [sport, setSport] = useState("");
  const [position, setPosition] = useState("");
  const [query, setQuery] = useState("");

  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [techniques, setTechniques] = useState<TechniqueSummary[]>([]);
  const [rulesets, setRulesets] = useState<Map<string, Ruleset>>(new Map());
  const [techniquesFailed, setTechniquesFailed] = useState(false);

  const [selected, setSelected] = useState<Selection | null>(null);
  const [everLoaded, setEverLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by the retry button to re-run the debounced exercise effect. */
  const [retryTick, setRetryTick] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* ── exercises: server-filtered, debounced ─────────────────────────────── */
  useEffect(() => {
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      // Same reason the technique loader has one: a captive portal accepts the
      // connection and never answers, and without a deadline `everLoaded` stays
      // false forever — blank grid, blank count, no error, no spinner.
      const deadline = setTimeout(() => controller.abort(), 10_000);
      try {
        const list = await listExercises(
          getToken,
          { sport: sport || undefined, q: query.trim() || undefined },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setExercises(list);
        setEverLoaded(true);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setEverLoaded(true);
      } finally {
        clearTimeout(deadline);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [getToken, sport, query, retryTick]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /* ── techniques: once, with its own deadline and its own failure ───────── */
  const techniqueAbortRef = useRef<AbortController | null>(null);

  const loadTechniques = useCallback(async () => {
    techniqueAbortRef.current?.abort();
    const ac = new AbortController();
    techniqueAbortRef.current = ac;
    // A captive portal accepts the connection and never answers; without a
    // deadline this half is simply absent, with nothing on screen saying so.
    const deadline = setTimeout(() => ac.abort(), 10_000);
    try {
      const [list, rs] = await Promise.all([
        listTechniques(getToken, ac.signal),
        listRulesets(getToken, ac.signal),
      ]);
      setTechniques(list);
      setRulesets(rs);
      setTechniquesFailed(false);
    } catch {
      // A supersede is not a failure; a timeout is. The only way to tell them
      // apart is whether this controller is still the current one.
      if (techniqueAbortRef.current === ac) setTechniquesFailed(true);
    } finally {
      clearTimeout(deadline);
    }
  }, [getToken]);

  useEffect(() => {
    // Matching the convention in sessions/page.tsx: the setState calls inside
    // live after an await, so they are not the cascading render the rule is
    // guarding against — but the rule can't see across the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTechniques();
    return () => techniqueAbortRef.current?.abort();
  }, [loadTechniques]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const showTechniques = HAS_TECHNIQUES.has(sport);

  // Sorted once per source, not once per keystroke; filtering preserves order,
  // so the filtered halves stay sorted and merge linearly below.
  const sortedExercises = useMemo(
    () => [...exercises].sort((a, b) => collator.compare(a.name, b.name)),
    [exercises],
  );
  const sortedTechniques = useMemo(
    () => [...techniques].sort((a, b) => collator.compare(a.name, b.name)),
    [techniques],
  );

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    // Filtered locally as well as server-side: the server is the authority but
    // is 200 ms + a round trip behind, and without this pass every technique
    // match appears interleaved through the full stale exercise catalog, which
    // then vanishes when the response lands — two visible settling phases per
    // keystroke, which reads as jank however fast it actually is.
    const ex = q
      ? sortedExercises.filter((e) => e.name.toLowerCase().includes(q))
      : sortedExercises;

    let tq: TechniqueSummary[] = [];
    if (showTechniques) {
      const scoped =
        usesPosition(sport) && position
          ? sortedTechniques.filter((t) =>
              inPositionFamily(t.position, position),
            )
          : sortedTechniques;
      tq = searchTechniques(scoped, query);
    }

    const out: Row[] = [];
    let i = 0;
    let j = 0;
    while (i < ex.length || j < tq.length) {
      const takeExercise =
        j >= tq.length ||
        (i < ex.length && collator.compare(ex[i].name, tq[j].name) <= 0);
      if (takeExercise) {
        const e = ex[i++];
        out.push({ kind: "exercise", key: `e:${e.id}`, name: e.name, ex: e });
      } else {
        const t = tq[j++];
        out.push({ kind: "technique", key: `t:${t.id}`, name: t.name, t });
      }
    }
    return out;
  }, [
    sortedExercises,
    sortedTechniques,
    showTechniques,
    sport,
    position,
    query,
  ]);

  const byName = useMemo(() => indexTechniques(techniques), [techniques]);

  /**
   * Below `lg` the panel stacks *after* the entire grid, so on a narrow window
   * clicking a card appeared to do nothing — the detail landed hundreds of rows
   * down. Above `lg` it is already beside the grid and must not move.
   */
  useEffect(() => {
    if (!selected) return;
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    document
      .getElementById("library-detail")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selected]);
  const isFiltered = query.trim() !== "" || sport !== "" || position !== "";

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Reference</p>
          <h1 className="font-display text-4xl font-bold">Library</h1>
        </div>
        <p className="stat text-sm text-text-dim">
          {everLoaded ? `${rows.length} shown` : ""}
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-64 flex-1">
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={100}
              placeholder={
                showTechniques
                  ? "Search exercises and techniques"
                  : "Search exercises"
              }
              aria-label="Search exercises and techniques by name"
              className="w-full rounded-card border border-line bg-surface px-4 py-2.5 pr-10 text-sm outline-none placeholder:text-text-dim focus:border-lime"
            />
            <kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border border-line px-1.5 py-0.5 text-[0.625rem] text-text-dim">
              /
            </kbd>
          </div>
          <div className="flex gap-2">
            <Chip
              active={sport === ""}
              onClick={() => {
                setSport("");
                setPosition("");
              }}
            >
              All
            </Chip>
            {SPORTS.map((s) => (
              <Chip
                key={s.key}
                active={sport === s.key}
                onClick={() => {
                  setSport(s.key);
                  // Returning to BJJ should start unfiltered rather than
                  // resuming a selection last seen several screens ago.
                  if (!usesPosition(s.key)) setPosition("");
                }}
              >
                {s.label}
              </Chip>
            ))}
          </div>
        </div>

        {usesPosition(sport) && (
          <div
            role="group"
            aria-label="Filter by position"
            className="flex flex-wrap gap-2"
          >
            <SmallChip active={position === ""} onClick={() => setPosition("")}>
              All positions
            </SmallChip>
            {POSITIONS.map((p) => (
              <SmallChip
                key={p.key}
                active={position === p.key}
                onClick={() => setPosition(p.key)}
              >
                {p.label}
              </SmallChip>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          {error}
          {/* The exercise fetch is driven by a debounced effect on
              [getToken, sport, query], so there was no way to re-run it without
              editing the query — and when BOTH halves failed the technique
              banner was suppressed too, leaving no retry anywhere on screen. */}
          <button
            type="button"
            onClick={() => setRetryTick((n) => n + 1)}
            className="font-medium text-lime-ink underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      )}
      {/* Named separately from the exercise error: the halves fail
          independently, and "techniques couldn't load" is not the same claim as
          "the library is down". */}
      {/* Deliberately NOT gated on `!error` any more: both halves can fail at
          once, and hiding this one then hid its retry along with it. */}
      {techniquesFailed && showTechniques && (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-card border border-warn/40 bg-warn/10 px-4 py-3 text-sm"
        >
          BJJ techniques couldn&apos;t load.
          <button
            type="button"
            onClick={() => void loadTechniques()}
            className="font-medium text-lime-ink underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      )}

      <div className={selected ? "grid gap-6 lg:grid-cols-[1fr_26rem]" : ""}>
        {everLoaded && rows.length === 0 && !error ? (
          <p className="text-sm text-text-muted">
            {isFiltered ? "Nothing matches this filter." : "Nothing here yet."}
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((r) =>
              r.kind === "exercise" ? (
                <li key={r.key}>
                  <Card
                    name={r.ex.name}
                    meta={`${r.ex.movement_pattern.replace(/_/g, " ")} · ${LOAD_LABEL[r.ex.load_type]}`}
                    badge={patternBadge(r.ex.movement_pattern)}
                    image={pickImage(r.ex, "thumbnail")}
                    active={
                      selected?.kind === "exercise" &&
                      selected.ex.id === r.ex.id
                    }
                    onClick={() =>
                      setSelected(
                        selected?.kind === "exercise" &&
                          selected.ex.id === r.ex.id
                          ? null
                          : { kind: "exercise", ex: r.ex },
                      )
                    }
                  />
                </li>
              ) : (
                <li key={r.key}>
                  <Card
                    name={r.t.name}
                    meta={
                      r.t.position +
                      (r.t.position_detail ? ` · ${r.t.position_detail}` : "")
                    }
                    badge={categoryBadge(r.t.category)}
                    // The tile is aria-hidden, so the category reaches a screen
                    // reader only if it is said here — the same standard the
                    // mobile row already holds itself to.
                    srSuffix={`${r.t.category}. BJJ technique.`}
                    restricted={
                      rulesets.get(r.t.ibjjf_ruleset_id)?.is_restricted ?? false
                    }
                    active={
                      selected?.kind === "technique" && selected.id === r.t.id
                    }
                    onClick={() =>
                      setSelected(
                        selected?.kind === "technique" && selected.id === r.t.id
                          ? null
                          : { kind: "technique", id: r.t.id },
                      )
                    }
                  />
                </li>
              ),
            )}
          </ul>
        )}

        {selected?.kind === "exercise" && (
          <ExercisePanel
            exercise={selected.ex}
            onClose={() => setSelected(null)}
          />
        )}
        {selected?.kind === "technique" && (
          <TechniquePanel
            // Keyed, so selecting a different technique REMOUNTS rather than
            // resetting state by hand in an effect. That also closes the window
            // where the previous technique's body renders under the new one's
            // title while the new fetch is still in flight.
            key={selected.id}
            id={selected.id}
            name={byName.get(selected.id)?.name ?? "Loading…"}
            byName={byName}
            onOpen={(id) => setSelected({ kind: "technique", id })}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

/* ── cards ─────────────────────────────────────────────────────────────── */

function Card({
  name,
  meta,
  badge,
  image,
  srSuffix,
  restricted = false,
  active,
  onClick,
}: {
  name: string;
  meta: string;
  badge: readonly [string, Accent];
  image?: string | null;
  srSuffix?: string;
  restricted?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const [code, accent] = badge;
  const cls = ACCENT_CLASS[accent];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full items-center gap-3 rounded-card border p-3 text-left transition ${
        active
          ? "border-lime bg-surface-raised"
          : // surface-hover, not surface-raised: the latter is #ffffff in light
            // mode, identical to the card, so the hover state did nothing at all.
            "border-line bg-surface hover:bg-surface-hover"
      }`}
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote R2 host
        <img
          src={image}
          alt=""
          className="h-14 w-14 shrink-0 rounded-lg bg-surface-raised object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border text-xs font-extrabold tracking-wider ${cls.tile} ${cls.text}`}
        >
          {code}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-xs capitalize text-text-dim">
          {meta}
        </span>
      </span>
      {/* Straight from the API's is_restricted. Never inferred from belt counts
          — adult no-gi has no white belt division, so counting flags ~130
          ordinary techniques instead of the real 20. */}
      {restricted && (
        <span className="shrink-0 rounded border border-warn px-1.5 py-0.5 text-[0.625rem] font-bold tracking-wide text-warn">
          IBJJF
        </span>
      )}
      {srSuffix && <span className="sr-only">{srSuffix}</span>}
    </button>
  );
}

/* ── panels ────────────────────────────────────────────────────────────── */

function PanelShell({
  title,
  eyebrow,
  onClose,
  children,
}: {
  title: string;
  eyebrow?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <aside
      id="library-detail"
      // Sticky without a height bound pins a long panel — full prose, legality
      // table and three edge lists routinely exceed the viewport — and its
      // bottom then can't be reached at all.
      className="flex h-fit max-h-none flex-col gap-4 overflow-y-auto rounded-card border border-line bg-surface p-5 lg:sticky lg:top-10 lg:max-h-[calc(100vh-5rem)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow}
          <h2 className="font-display text-2xl font-semibold leading-tight">
            {title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="shrink-0 text-text-dim hover:text-text"
        >
          ✕
        </button>
      </div>
      {children}
    </aside>
  );
}

function ExercisePanel({
  exercise,
  onClose,
}: {
  exercise: Exercise;
  onClose: () => void;
}) {
  const image = pickImage(exercise, "demo");
  const isPlaceholder = exercise.media.every((m) => m.is_default);

  return (
    <PanelShell title={exercise.name} onClose={onClose}>
      {image && (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element -- remote R2 host */}
          <img
            src={image}
            alt={exercise.name}
            className="w-full rounded-lg bg-surface-raised object-contain"
          />
          {isPlaceholder && (
            // Saying so matters: 463 of 523 entries have no photo of their own,
            // and a placeholder that passes for the real thing makes that gap
            // invisible and therefore permanent.
            <span className="absolute bottom-2 left-2 rounded-pill bg-black/70 px-2 py-0.5 text-[0.625rem] text-text-muted">
              Placeholder image
            </span>
          )}
        </div>
      )}

      <dl className="flex flex-col gap-2 text-sm">
        <Row label="Pattern">
          {exercise.movement_pattern_detail ||
            exercise.movement_pattern.replace(/_/g, " ")}
        </Row>
        <Row label="Tracks">{LOAD_LABEL[exercise.load_type]}</Row>
        {exercise.is_unilateral && <Row label="Sides">Per side</Row>}
        {exercise.equipment.length > 0 && (
          <Row label="Equipment">
            {exercise.equipment.join(", ").replace(/-/g, " ")}
          </Row>
        )}
        {exercise.primary_muscles.length > 0 && (
          <Row label="Primary">
            {exercise.primary_muscles.join(", ").replace(/-/g, " ")}
          </Row>
        )}
      </dl>

      {exercise.instructions ? (
        <p className="border-t border-line-soft pt-4 text-sm leading-relaxed text-text-muted">
          {exercise.instructions}
        </p>
      ) : (
        <p className="border-t border-line-soft pt-4 text-sm text-text-dim">
          No coaching notes yet.
        </p>
      )}
    </PanelShell>
  );
}

/**
 * A technique, in full.
 *
 * Fetched per selection rather than held: the summary the grid draws from
 * deliberately carries no prose (65 KB for all 466 against 274 KB), so the
 * panel is where the detail arrives.
 */
function TechniquePanel({
  id,
  name,
  byName,
  onOpen,
  onClose,
}: {
  /** Known from the card that opened this, so the shell never says "Loading…". */
  name: string;
  id: string;
  byName: Map<string, TechniqueSummary>;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const { getToken } = useAuth();
  const [t, setT] = useState<Technique | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    getTechnique(getToken, id, ac.signal)
      .then(setT)
      .catch(() => {
        if (!ac.signal.aborted) setFailed(true);
      });
    return () => ac.abort();
  }, [getToken, id]);

  if (failed) {
    return (
      <PanelShell title="Couldn't load" onClose={onClose}>
        <p className="text-sm text-text-muted">
          This technique couldn&apos;t be loaded. Check your connection and
          select it again.
        </p>
      </PanelShell>
    );
  }

  if (!t) {
    return (
      <PanelShell title={name} onClose={onClose}>
        {/* Same reason as the hover state: surface-raised is invisible on a
            light surface, so the skeleton was blank white space. */}
        <div
          className="h-24 animate-pulse rounded-lg bg-surface-hover"
          role="status"
          aria-label="Loading technique details"
        />
      </PanelShell>
    );
  }

  const [code, accent] = categoryBadge(t.category);
  const steps = executionSteps(t.description);
  const rs = t.ibjjf ?? null;

  return (
    <PanelShell
      title={t.name}
      eyebrow={
        <p className={`eyebrow ${ACCENT_CLASS[accent].text}`}>
          {code} · {t.category}
        </p>
      }
      onClose={onClose}
    >
      {t.aliases.length > 0 && (
        <p className="-mt-2 text-sm text-text-muted">
          Also called {t.aliases.join(" · ")}
        </p>
      )}

      <dl className="flex flex-col gap-2 text-sm">
        <Row label="Position">
          {t.position}
          {t.position_detail ? ` · ${t.position_detail}` : ""}
        </Row>
        <Row label="Ruleset">{t.gi_no_gi}</Row>
      </dl>

      {/* The mechanics and the decision are separate sections because they
          answer separate questions. Merged, neither reads well.

          And the mechanics are a *sequence*, not a paragraph — the library just
          authors them as one comma-separated sentence. Same split as the phone,
          same 8-of-466 prose fallback, so the two screens never disagree about
          where a step ends. */}
      {steps.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-line-soft pt-4">
          <p className="eyebrow">How it works</p>
          <ol className="flex flex-col gap-2">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={`mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[0.6875rem] font-bold ${ACCENT_CLASS[accent].tile} ${ACCENT_CLASS[accent].text}`}
                >
                  {i + 1}
                </span>
                <span className="text-sm leading-relaxed text-text-muted">
                  {s}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        t.description && <Section title="How it works">{t.description}</Section>
      )}
      {t.when_to_use && (
        <Section title="When to use it">{t.when_to_use}</Section>
      )}

      {rs && <Legality ruleset={rs} />}

      {/* The reason this page beats the phone: following the graph costs
          nothing, because the grid never moves. */}
      <Edges
        label="Set up from"
        items={t.setup_from}
        byName={byName}
        onOpen={onOpen}
      />
      <Edges
        label="Common next moves"
        items={t.common_next_moves}
        byName={byName}
        onOpen={onOpen}
      />
      <Edges
        label="Common counters"
        items={t.common_counters}
        byName={byName}
        onOpen={onOpen}
      />

      {/* Deliberately last and deliberately quiet. An observation about where
          this is usually taught, NOT a rule and NOT a prerequisite — the rule
          is the legality panel above. */}
      {t.typical_belt && (
        <p className="border-t border-line-soft pt-4 text-xs text-text-dim">
          Commonly taught from {t.typical_belt} belt onwards.
        </p>
      )}
      {t.source_notes && (
        <p className="text-xs text-text-dim">{t.source_notes}</p>
      )}
    </PanelShell>
  );
}

/**
 * IBJJF competition legality.
 *
 * `is_restricted` comes from the API and is NOT re-derived here. Adult no-gi has
 * no white belt division, so a no-gi list of "Blue, Purple, Brown, Black" is
 * the baseline rather than a restriction — inferring from belt counts marks
 * ~130 ordinary techniques as restricted when the real number is 20.
 */
function Legality({ ruleset }: { ruleset: Ruleset }) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-card border p-4 ${
        ruleset.is_restricted ? "border-warn/50 bg-warn/5" : "border-line-soft"
      }`}
    >
      <p className={`eyebrow ${ruleset.is_restricted ? "text-warn" : ""}`}>
        {ruleset.is_restricted
          ? "Restricted in IBJJF competition"
          : "IBJJF competition"}
      </p>
      <p className="text-sm font-medium">{ruleset.rule_class}</p>
      <div className="grid grid-cols-2 gap-3 pt-1">
        <Division
          label="Gi"
          belts={ruleset.gi_allowed_belts}
          note={ruleset.gi_note}
        />
        <Division
          label="No-Gi"
          belts={ruleset.no_gi_allowed_belts}
          note={ruleset.no_gi_note}
        />
      </div>
      {ruleset.notes && (
        <p className="pt-1 text-xs leading-relaxed text-text-muted">
          {ruleset.notes}
        </p>
      )}
    </div>
  );
}

/**
 * An empty belt list means "this division does not apply" — a gi-only technique
 * has no no-gi belts — and must never render as "allowed at no belt", which
 * would read as prohibited. The note carries the real reason.
 */
function Division({
  label,
  belts,
  note,
}: {
  label: string;
  belts: string[];
  note: string;
}) {
  return (
    <div>
      <p className="text-[0.625rem] font-bold tracking-wide text-text-dim uppercase">
        {label}
      </p>
      <p className="text-xs text-text-muted">
        {belts.length > 0 ? belts.join(", ") : note || "Not specified"}
      </p>
    </div>
  );
}

function Edges({
  label,
  items,
  byName,
  onOpen,
}: {
  label: string;
  items: string[];
  byName: Map<string, TechniqueSummary>;
  onOpen: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="eyebrow">{label}</p>
      <div className="flex flex-wrap gap-2">
        {items.map((raw) => {
          const hit = byName.get(edgeKey(raw)) ?? null;
          if (!hit) {
            // Most of these name something that isn't a library entry — 71% of
            // next-moves, 94% of counters are prose like "establish inside
            // ties". Plain text, and it must LOOK like plain text: a dead link
            // is worse than honest text.
            return (
              <span key={raw} className="text-xs text-text-muted">
                {raw}
              </span>
            );
          }
          // Show what the author wrote, EXCEPT when they wrote an id — the only
          // unreadable form. Substituting the target's canonical name on an
          // alias match silently rewrites the content: "Straight Armbar" became
          // "Armbar from Closed Guard", a different technique from a different
          // position, presented as if the author had said it.
          const display = edgeKey(raw) === hit.id ? hit.name : raw;
          return (
            <button
              key={raw}
              type="button"
              onClick={() => onOpen(hit.id)}
              className="rounded-pill border border-lime/40 px-2.5 py-1 text-xs font-medium text-lime-ink transition hover:bg-lime/10"
            >
              {display}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── bits ──────────────────────────────────────────────────────────────── */

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-line-soft pt-4">
      <p className="eyebrow">{title}</p>
      <p className="text-sm leading-relaxed text-text-muted">{children}</p>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-right capitalize text-text-muted">{children}</dd>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-pill border px-4 py-1.5 text-sm font-medium transition ${
        active
          ? "border-lime bg-lime/10 text-lime"
          : "border-line text-text-muted hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

function SmallChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded border px-2.5 py-1 text-xs font-medium transition ${
        active
          ? "border-text-muted bg-surface-raised text-text"
          : "border-line-soft text-text-dim hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
