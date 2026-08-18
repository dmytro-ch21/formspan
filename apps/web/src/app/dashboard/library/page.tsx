"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

import {
  buildEdgeIndex,
  resolveEdge,
  executionSteps,
  getBjjStanding,
  getPosition,
  getTechnique,
  listExercises,
  listPositions,
  listRulesets,
  listTechniques,
  pickImage,
  searchTechniques,
  techniquesInPosition,
  type Exercise,
  type Position,
  type Ruleset,
  type Technique,
  type TechniqueSummary,
  enabledSports,
  type Module,
} from "@/lib/api";
import { useModules } from "@/lib/ModulesProvider";
import {
  ACCENT_CLASS,
  atOrBelowBelt,
  BELT_CAPS,
  categoryBadge,
  inPositionFamily,
  patternBadge,
  positionBadge,
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
 * The Library on desktop — the exercise catalog **and** the 542 BJJ techniques,
 * in one grid.
 *
 * One library, matching the phone. Techniques are not a separate destination
 * here for the same reason they aren't there: they'd need a second search box,
 * and the "BJJ" chip would return twenty bear-crawl drills while the actual
 * techniques lived somewhere else.
 *
 * What the wide screen adds, and the phone can't: the detail panel sits beside
 * the grid rather than replacing it, so selecting a technique never costs you
 * your place in the list, your scroll position or your search. That is why the
 * full prose and the legality table live here rather than being trimmed for
 * width — reading around a subject is what a desk is for.
 *
 * The graph lists used to be buttons that swapped the panel. They are plain
 * text now; see the `Edges` docstring for the coverage numbers that killed the
 * links.
 *
 * Fetch shape: exercises are filtered server-side (debounced, cancellable);
 * techniques are fetched **once** (~197 KB for all 542) and filtered in memory.
 * Same search box, different plumbing.
 */

/** Sports whose content includes techniques. */

/**
 * Position is a BJJ-only axis, so its chips render only under the BJJ filter —
 * which means the filter may only be *applied* there too. Applying it whenever
 * techniques were on screen (which includes "All") would leave a stale
 * selection narrowing the grid with its control nowhere in sight.
 */
function usesPosition(sport: string, mods: Module[]): boolean {
  const m = mods.find((x) => x.key === sport);
  // Enabled as well as the facet: otherwise this answers "does BJJ have
  // positions" rather than "should position chips be reachable".
  return (m?.enabled && m.capabilities.facets.includes("position")) ?? false;
}

/** Same reasoning as {@link usesPosition}, for the belt cap. */
function usesBelt(sport: string, mods: Module[]): boolean {
  const m = mods.find((x) => x.key === sport);
  return (m?.enabled && m.capabilities.facets.includes("belt")) ?? false;
}

/**
 * One collator, built once. `localeCompare` re-enters ICU per call; the sources
 * are kept pre-sorted and merged linearly so a keystroke costs ~1046
 * comparisons rather than a full re-sort.
 */
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

type Row =
  | { kind: "exercise"; key: string; name: string; ex: Exercise }
  | { kind: "technique"; key: string; name: string; t: TechniqueSummary };

// Positions carry an id rather than the object, like techniques and unlike
// exercises: the panel resolves it, so a deep link or a stale card can't put a
// half-populated entry on screen.
type Selection =
  | { kind: "exercise"; ex: Exercise }
  | { kind: "technique"; id: string }
  | { kind: "position"; id: string };

export default function LibraryPage() {
  const { modules, known } = useModules();
  /** Chips from the registry, All first. */
  const sportChips = [{ key: "", label: "All" }, ...enabledSports(modules)];
  /**
   * The enabled discipline that carries techniques, if any. Gates the FETCH,
   * not just the chips — the technique list is ~197 KB and was pulled on every
   * Library visit regardless of whether this athlete does BJJ.
   */
  // When modules are UNKNOWN (the fetch failed), fetch anyway — same
  // fail-open direction as the rail. Silently hiding the technique library
  // because a preference endpoint blinked is the worse of the two outcomes.
  // A boolean, not the module: nothing here needs the module itself, and a
  // boolean keeps the useCallback dependency stable (an object identity would
  // rebuild `loadTechniques` on every render).
  //
  // When modules are UNKNOWN — the fetch failed — this is true, the same
  // fail-open direction as the rail. Silently hiding the technique library
  // because a preference endpoint blinked is the worse of the two outcomes.
  const techniqueKey = modules.find(
    (m) => m.enabled && m.capabilities.catalog === "techniques",
  )?.key;
  const wantsTechniques = !known || techniqueKey !== undefined;
  const { getToken } = useAuth();

  /**
   * The one deep link into this page: `?position=<glossary id>`, which the
   * round map emits so "read about side control" opens that position's panel.
   *
   * **It opens the PANEL, not the chip filter, and that distinction is the bug
   * review found.** The position chips are keyed on FAMILY — "Mount", "Side
   * Control", "Back" — while the glossary and the map speak in ids (`mount`,
   * `side-control`, `back-control`). A link carrying an id filtered the grid to
   * nothing and left no chip looking active, including "All positions": an
   * invisible filter, which is the exact failure the chips' own docstring warns
   * about. The panel takes an id, resolves by the glossary's own rule, and is
   * the thing the map's technique count is counted with — so the number on the
   * link and the list at the destination agree.
   *
   * READ ONCE, AS AN INITIAL VALUE, and never written back. This page keeps no
   * filter state anywhere — sport and position both reset on reload — and
   * pushing selection into the URL would turn that decision over quietly. An
   * initial value is a different thing from persistence: it is the caller
   * saying where to start.
   *
   * Unvalidated on purpose: an id that does not exist resolves to nothing and
   * the panel reports it, which is the same path a stale bookmark already took.
   */
  const params = useSearchParams();
  const initialPosition = params.get("position");

  const [sport, setSport] = useState("");
  const [position, setPosition] = useState("");
  const [belt, setBelt] = useState("");
  const [query, setQuery] = useState("");

  /**
   * A one-time suggestion, not a stored preference — this page has none of
   * those (sport and position both reset on reload too), so belt matches
   * that scope rather than inventing persistence for just one filter.
   *
   * Suggests the athlete's own recorded rank once BJJ's standing has loaded,
   * the same way a belt-level curriculum would open on "your level" rather
   * than "everything" — see the design note in docs/decisions/history.md on
   * why belt is meant to be the entry point into that loop, not decoration.
   * Only ever a suggestion: every chip stays reachable either side of it.
   *
   * The two refs answer different questions and must not be one flag.
   * `beltFetched` stops a `modules` reference change from re-issuing a
   * request whose answer cannot have changed; `mounted` stops a resolved
   * request writing state after the page is gone. Folding them together —
   * cancelling in this effect's own cleanup — silently loses the default
   * whenever `modules` changes mid-flight: the cleanup discards the answer
   * while the already-set flag stops the re-run from asking again.
   */
  const beltFetchedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (beltFetchedRef.current) return;
    const bjjModule = modules.find((m) => m.key === "bjj");
    // Modules haven't loaded yet — wait for a real answer rather than
    // guessing "off" from an empty list.
    if (!bjjModule) return;
    if (!bjjModule.enabled) return;
    beltFetchedRef.current = true;
    getBjjStanding(getToken)
      .then((standing) => {
        if (!mountedRef.current || !standing.current) return;
        const capitalised =
          standing.current.belt.charAt(0).toUpperCase() +
          standing.current.belt.slice(1);
        setBelt(capitalised);
      })
      .catch(() => {
        // No default is a fine default — the row still lets them pick one.
      });
  }, [modules, getToken]);

  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [techniques, setTechniques] = useState<TechniqueSummary[]>([]);
  const [rulesets, setRulesets] = useState<Map<string, Ruleset>>(new Map());
  const [techniquesFailed, setTechniquesFailed] = useState(false);
  // No `positionsFailed` counterpart. The glossary is an extra here — if it
  // does not load the row is absent, which is quieter and more honest than an
  // error about content the reader never asked for.
  const [positions, setPositions] = useState<Position[]>([]);

  const [selected, setSelected] = useState<Selection | null>(
    initialPosition === null ? null : { kind: "position", id: initialPosition },
  );
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
    // Hiding a module must cut the request, not just the pixels.
    if (!wantsTechniques) {
      setTechniques([]);
      setTechniquesFailed(false);
      setPositions([]);
      return;
    }
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

      // After the two that matter, and deliberately swallowed. The glossary is
      // an extra on this screen; it must never be the reason the Library shows
      // an error, and the "BJJ techniques couldn't load" banner must not fire
      // for it. Guarded on the controller for the same reason the outer catch
      // is — a superseded request resolving late would otherwise blank the row.
      try {
        const list = await listPositions(getToken, ac.signal);
        if (techniqueAbortRef.current === ac) setPositions(list);
      } catch {
        if (techniqueAbortRef.current === ac) setPositions([]);
      }
    } catch {
      // A supersede is not a failure; a timeout is. The only way to tell them
      // apart is whether this controller is still the current one.
      if (techniqueAbortRef.current === ac) setTechniquesFailed(true);
    } finally {
      clearTimeout(deadline);
    }
  }, [getToken, wantsTechniques]);

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

  // With modules unknown there is no key to compare and no chip to pick, so
  // `sport` is "" and the techniques show — fail open, as above.
  const showTechniques =
    wantsTechniques && (sport === "" || sport === techniqueKey);

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
      let scoped = sortedTechniques;
      if (usesPosition(sport, modules) && position) {
        scoped = scoped.filter((t) => inPositionFamily(t.position, position));
      }
      if (usesBelt(sport, modules) && belt) {
        scoped = scoped.filter((t) => atOrBelowBelt(t.typical_belt, belt));
      }
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
    // `modules` is read via usesPosition; without it this captures the
    // first-render list and keeps an invisible position filter applied when a
    // facet changes.
  }, [
    sortedExercises,
    sortedTechniques,
    showTechniques,
    sport,
    position,
    belt,
    query,
    modules,
  ]);

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
  /** Only for the panel's loading title, so it never reads "Loading…". */
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of techniques) m.set(t.id, t.name);
    return m;
  }, [techniques]);

  // Each clause has to match the condition the `rows` memo actually filters
  // on, not just "is this value set" — a belt cap suggested from the
  // athlete's rank sits in state from page load while its row is hidden
  // under any non-BJJ chip, and counting it there would answer an empty
  // catalog with "Nothing matches this filter" when nothing is filtering.
  const isFiltered =
    query.trim() !== "" ||
    sport !== "" ||
    position !== "" ||
    (usesBelt(sport, modules) && belt !== "");

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
            {sportChips.map((s) => (
              <Chip
                key={s.key}
                active={sport === s.key}
                onClick={() => {
                  setSport(s.key);
                  // Returning to BJJ should start unfiltered rather than
                  // resuming a selection last seen several screens ago.
                  if (!usesPosition(s.key, modules)) setPosition("");
                }}
              >
                {s.label}
              </Chip>
            ))}
          </div>
        </div>

        {usesPosition(sport, modules) && (
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

        {/* Same reasoning as the position row, one axis over: BJJ-only, and
            hidden rather than shown-and-inert against a strength catalog. */}
        {usesBelt(sport, modules) && (
          <div
            role="group"
            aria-label="Filter by belt"
            className="flex flex-wrap gap-2"
          >
            <SmallChip active={belt === ""} onClick={() => setBelt("")}>
              All levels
            </SmallChip>
            {BELT_CAPS.map((b) => (
              <SmallChip
                key={b.key}
                active={belt === b.key}
                onClick={() => setBelt(b.key)}
                // The cap is cumulative, and the chip's own text can't say
                // so — matching the wording mobile already reads out.
                label={`Filter up to ${b.label}`}
              >
                {b.label}
              </SmallChip>
            ))}
          </div>
        )}

        {/* The glossary — the one row here that is reading rather than
            filtering.

            Last, and below every chip row, because that is the boundary it
            marks: everything above narrows the grid, this opens a panel. It
            sits under three rows of near-identical pills, so it carries a
            heading and uses cards rather than chips; without that separation
            the four rows read as one broken control. */}
        {usesPosition(sport, modules) && positions.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
            {/* `eyebrow` already carries the colour — every other section
                label on this page uses it bare, and matching them is the point:
                this is a heading over content, not a control. */}
            <h2 className="eyebrow">Start with positions</h2>
            {/* Above the cards, because it is the thing to read BEFORE any
                single position: the glossary says what each place is, the map
                says how they connect and which way is up. A beginner opening
                "Closed Guard" first learns a definition with nothing to hang
                it on. */}
            <Link
              href="/dashboard/library/map"
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised px-4 py-3 text-sm hover:bg-surface-hover"
            >
              <span>
                <span className="font-medium">How a round goes</span>
                <span className="block text-text-muted">
                  Every position on one map, stacked by what it is worth — and
                  the ways between them.
                </span>
              </span>
              <span aria-hidden className="text-text-dim">
                →
              </span>
            </Link>
            <ul className="flex flex-wrap gap-2">
              {positions.map((p) => {
                const [code, accent] = positionBadge(p.id);
                const cls = ACCENT_CLASS[accent];
                const active =
                  selected?.kind === "position" && selected.id === p.id;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      // The verb is load-bearing. Visually a card and a chip
                      // are obviously different things; to a screen reader
                      // this row and the filter row above it are both just
                      // "Guard, button". "Read about" is what says which one
                      // narrows the grid and which one opens a description.
                      aria-label={`Read about ${p.name}`}
                      onClick={() =>
                        setSelected(
                          active ? null : { kind: "position", id: p.id },
                        )
                      }
                      className={`flex items-center gap-2 rounded-card border px-2.5 py-2 text-left transition-colors ${
                        active
                          ? "border-lime bg-surface-raised"
                          : "border-line bg-surface hover:bg-surface-hover"
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded border text-[0.625rem] font-bold tracking-wide ${cls.tile} ${cls.text}`}
                      >
                        {code}
                      </span>
                      <span className="text-sm font-medium">{p.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
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
            catalog={techniques}
            onSelectTechnique={(id) => setSelected({ kind: "technique", id })}
            name={nameById.get(selected.id) ?? "Loading…"}
            onClose={() => setSelected(null)}
          />
        )}
        {selected?.kind === "position" && (
          <PositionPanel
            key={selected.id}
            id={selected.id}
            // Always known — the panel only opens from a card this list drew,
            // so the shell never shows a placeholder title.
            name={
              positions.find((p) => p.id === selected.id)?.name ?? "Loading…"
            }
            techniques={techniques}
            onSelectTechnique={(id) => setSelected({ kind: "technique", id })}
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
          — adult no-gi has no white belt division, so counting flags 441
          ordinary techniques instead of the real 27. */}
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
  // The panels are keyed on the selected id, so following an edge link
  // REMOUNTS the shell — which destroys the button that had focus and drops
  // keyboard and screen-reader users to <body> with no announcement of where
  // they landed. Focusing the heading on mount fixes the swap case and, as a
  // bonus, makes opening a panel at all move focus into it, which is what a
  // disclosure should do. Invisible to mouse users.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

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
          {/* tabIndex -1: focusable by script, never in the tab order. */}
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="font-display text-2xl font-semibold leading-tight outline-none"
          >
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
 * A position, explained — the other half of the library.
 *
 * Techniques are what you do; these are what you do it in. "Armbar from Closed
 * Guard" is unreadable to someone who has never been in a closed guard, and
 * until now nothing in the app said what one was.
 *
 * Deliberately the same shell, sections and measurements as TechniquePanel:
 * the two are peers in this grid and reading one after the other should not
 * feel like changing app. Three differences, each earned:
 *
 * 1. No step list. A technique is a sequence; a position is a state, and
 *    numbering "keep your elbows in" as step 3 of 5 invents an order.
 * 2. No legality card — positions are not IBJJF-restricted, techniques are.
 * 3. The cross-linked techniques ARE clickable, unlike this panel's `Edges`
 *    lists. There the names are prose that mostly resolves to nothing; here
 *    every row came out of the library the grid already holds.
 */
function PositionPanel({
  id,
  name,
  techniques,
  onSelectTechnique,
  onClose,
}: {
  id: string;
  /** Known from the card that opened this, so the shell never says "Loading…". */
  name: string;
  techniques: TechniqueSummary[];
  onSelectTechnique: (id: string) => void;
  onClose: () => void;
}) {
  const { getToken } = useAuth();
  const [p, setP] = useState<Position | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    getPosition(getToken, id, ac.signal)
      .then(setP)
      .catch(() => {
        if (!ac.signal.aborted) setFailed(true);
      });
    return () => ac.abort();
  }, [getToken, id]);

  if (failed) {
    return (
      <PanelShell title="Couldn't load" onClose={onClose}>
        <p className="text-sm text-text-muted">
          This position couldn&apos;t be loaded. Check your connection and
          select it again.
        </p>
      </PanelShell>
    );
  }

  if (!p) {
    return (
      <PanelShell title={name} onClose={onClose}>
        <div
          className="h-24 animate-pulse rounded-lg bg-surface-hover"
          role="status"
          aria-label="Loading position details"
        />
      </PanelShell>
    );
  }

  const [code, accent] = positionBadge(p.id);
  const related = techniquesInPosition(techniques, p);

  return (
    <PanelShell
      title={p.name}
      eyebrow={
        <p className={`eyebrow ${ACCENT_CLASS[accent].text}`}>
          {code} · Position
        </p>
      }
      onClose={onClose}
    >
      {p.aliases.length > 0 && (
        <p className="text-sm text-text-muted">
          Also called {p.aliases.join(" · ")}
        </p>
      )}

      {p.description && <Section title="What it is">{p.description}</Section>}
      {p.priorities && <Priorities text={p.priorities} />}

      {related.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-line-soft pt-4">
          <p className="eyebrow">{scopeLabel(p, related.length)}</p>
          <ul className="flex flex-col gap-1.5">
            {related.map((t) => {
              const [tCode, tAccent] = categoryBadge(t.category);
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onSelectTechnique(t.id)}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-line-soft bg-surface-hover px-3 py-2 text-left transition-colors hover:border-line hover:bg-surface-raised"
                  >
                    <span
                      aria-hidden
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[0.625rem] font-bold tracking-wide ${ACCENT_CLASS[tAccent].tile} ${ACCENT_CLASS[tAccent].text}`}
                    >
                      {tCode}
                    </span>
                    <span className="text-xs leading-snug">{t.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </PanelShell>
  );
}

/**
 * Name the scope when the list is not the position's own.
 *
 * `family` is coarse, so Knee on Belly borrows Side Control's list entirely —
 * no technique carries that position. Saying "TECHNIQUES FROM HERE" over
 * borrowed rows is the panel stating something false to the reader least able
 * to check it, which is exactly who this feature is for.
 *
 * A detail filter means the list IS the position's own: closed and open guard
 * share the Guard family but each narrows it to their own techniques. And
 * `startsWith` rather than equality because Back Control's family is "Back" —
 * an artefact of the rows saying "Back - Top (Back Control)", not a broader
 * scope; nothing else maps to it.
 */
function scopeLabel(p: Position, count: number): string {
  const scoped =
    p.detail_includes.length > 0 || p.detail_excludes.length > 0;
  const own =
    scoped || p.name.toLowerCase().startsWith(p.family.toLowerCase());
  return `Techniques from ${own ? "here" : `the ${p.family} family`} · ${count}`;
}

/**
 * Priorities, split by player.
 *
 * Authored as one or two paragraphs; where there are two they are labelled
 * ("Bottom: …" / "Top: …") because every position is someone's good news and
 * someone else's problem. Pulling the label out lets a reader find their own
 * half at a glance instead of reading both.
 *
 * Detected rather than stored in its own column: the split is not universal —
 * standing has no top or bottom — and a schema insisting on two sides would
 * force empty or duplicated prose on the entries that have one.
 */
function Priorities({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="flex flex-col gap-3 border-t border-line-soft pt-4">
      <p className="eyebrow">What matters here</p>
      {paragraphs.map((para, i) => {
        // Only a short leading word or two counts as a label. Without the
        // bound, any sentence containing a colon loses its first clause to a
        // heading — standing's opening sentence has one at offset 56.
        const m = /^([A-Z][A-Za-z\s-]{0,14}):\s+([\s\S]+)$/.exec(para);
        return m ? (
          <div key={i} className="flex flex-col gap-1">
            <p className="eyebrow text-lime">{m[1]}</p>
            <p className="text-sm leading-relaxed text-text-muted">{m[2]}</p>
          </div>
        ) : (
          <p key={i} className="text-sm leading-relaxed text-text-muted">
            {para}
          </p>
        );
      })}
    </div>
  );
}

/**
 * A technique, in full.
 *
 * Fetched per selection rather than held: the summary the grid draws from
 * deliberately carries no prose (197 KB for all 542 against 587 KB), so the
 * panel is where the detail arrives.
 */
function TechniquePanel({
  id,
  name,
  catalog,
  onSelectTechnique,
  onClose,
}: {
  /** Known from the card that opened this, so the shell never says "Loading…". */
  name: string;
  id: string;
  /** The summaries the page already holds — resolving an edge costs no fetch. */
  catalog: TechniqueSummary[];
  onSelectTechnique: (id: string) => void;
  onClose: () => void;
}) {
  const { getToken } = useAuth();
  const [t, setT] = useState<Technique | null>(null);
  const [failed, setFailed] = useState(false);
  const edgeIndex = useMemo(() => buildEdgeIndex(catalog), [catalog]);


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
          same 7-of-542 prose fallback, so the two screens never disagree about
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

      <Edges label="Set up from" items={t.setup_from} index={edgeIndex} selfID={t.id} onSelect={onSelectTechnique} />
      <Edges label="Common next moves" items={t.common_next_moves} index={edgeIndex} selfID={t.id} onSelect={onSelectTechnique} />
      {/* NO `index` here, deliberately. Only 8% of counters name a library
          entry — the rest are reactions and grips ("Sprawl", "Crossface",
          "Hand fight") that are not techniques and should not become them.
          One navigable row in ten is the half-works feel that had the
          buttons removed in the first place. */}
      <Edges label="Common counters" items={t.common_counters} />

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
 * 441 ordinary techniques as restricted when the real number is 27.
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

/**
 * The graph, navigable where it resolves and prose where it does not.
 *
 * THESE WERE BUTTONS, THEN TEXT, AND ARE NOW BOTH. The middle step was right
 * for its reason and the reason has not gone away: coverage is uneven —
 * measured over the 542-entry catalog, `setup_from` resolves 84%,
 * `common_next_moves` 31%, `common_counters` 10% — so making every row a button
 * produced "plain text sitting beside a few links, which reads as a feature
 * that half-works".
 *
 * What changed is the AFFORDANCE, not the coverage. A resolved row is visibly
 * a control — button role, hover, a chevron — and an unresolved one has none.
 * The original failure was that both looked identical, so a reader had to
 * guess and learned not to try. Made distinct, the mixture is honest: part of
 * this field names techniques and part of it is advice, which is what it holds.
 *
 * `index` is optional and its absence is meaningful rather than a default:
 * with none, the whole block renders as text. Counters are called that way.
 *
 * Mirrors the phone — apps/mobile/app/technique/[id].tsx.
 */
function Edges({
  label,
  items,
  index,
  selfID,
  onSelect,
}: {
  label: string;
  items: string[];
  index?: Map<string, TechniqueSummary>;
  selfID?: string;
  onSelect?: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="eyebrow">{label}</p>
      <ul className="flex flex-col gap-1.5">
        {items.map((raw) => {
          const hit = index && onSelect ? resolveEdge(index, raw, selfID) : null;
          // `!onSelect` is redundant at runtime — `hit` is only non-null when
          // it exists — but the compiler cannot see that correlation, and a
          // non-null assertion below would hide a real mistake later.
          if (!hit || !onSelect) {
            return (
              <li
                key={raw}
                className="rounded-lg border border-line-soft bg-surface-hover px-3 py-2 text-xs leading-relaxed text-text-muted"
              >
                {raw}
              </li>
            );
          }
          return (
            <li key={raw}>
              <button
                type="button"
                onClick={() => onSelect(hit.id)}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-line-soft bg-surface-hover px-3 py-2 text-left text-xs leading-relaxed text-text hover:border-line"
              >
                {/* The library's OWN name, not the raw reference string. They
                    differ whenever the reference used an alias or the other
                    dash, and showing where you are going beats echoing what
                    was written. */}
                <span>{hit.name}</span>
                <span aria-hidden className="text-text-muted">
                  ›
                </span>
              </button>
            </li>
          );
        })}
      </ul>
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
  label,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /**
   * Accessible name, when the visible text alone doesn't carry the meaning.
   *
   * The belt row needs it and the position row doesn't: "Guard" filters to
   * Guard, but "Blue" filters to *Blue and everything below it*, and a
   * screen reader hearing only the belt name has no way to learn that.
   */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
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
