"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import {
  getBjjFocus,
  getBjjProficiency,
  MAX_BJJ_FOCUS,
  setBjjFocus,
  type BjjFocus,
  type BjjProficiency,
  type BjjProficiencySummary,
} from "@/lib/api";

/**
 * The technique funnel, at desk depth.
 *
 * **Not a proficiency score, and that is the design.**
 * `docs/decisions/bjj-tracking-design.md` rules out asking anyone to rate
 * their triangle 1–5: people are bad at it, it goes stale, and it produces a
 * number with no provenance. What accumulates instead is small factual events
 * — drilled it today, went for it twice in rolling, landed it once — and this
 * page shows those, so every judgement it invites is one the reader can see
 * the basis for.
 *
 * The headline is the DROP-OFF, not the totals. "Drilled 34 techniques, taken
 * 6 of them into a live round" is a finding you can act on this week; "210
 * reps" is a statistic. That ordering — funnel first, list second — is the
 * whole reason this screen exists rather than a list of counters.
 *
 * Web, per the platform rule: this is review and analysis, done sitting down.
 * The phone captures the evidence mid-reflection; nothing here belongs on it.
 */

/** Below this, a hit rate is noise rather than a measurement. */
const MIN_TRIES_FOR_RATE = 5;

type Bucket = "all" | "untried" | "working" | "stalled" | "against";

const BUCKETS: { key: Bucket; label: string; blurb: string }[] = [
  { key: "all", label: "Everything", blurb: "Every technique with any evidence" },
  {
    key: "against",
    label: "Used on you",
    blurb: "Caught in it, with nothing of your own recorded",
  },
  {
    key: "untried",
    label: "Never tried live",
    blurb: "Drilled, but never taken into a round — the most actionable list here",
  },
  { key: "working", label: "Landing", blurb: "Has worked live at least once" },
  {
    key: "stalled",
    label: "Not landing yet",
    blurb: "Tried live, hasn’t worked yet",
  },
];

/**
 * Every row lands in exactly one bucket, and the chip counts must therefore
 * sum to "Everything".
 *
 * The `against` case is reachable and used to return null: the endpoint's only
 * filter is `technique_id IS NOT NULL`, so a technique whose sole evidence is
 * a `conceded` tag comes back with zeroes across the funnel. That row counted
 * toward "Everything" and toward no sub-bucket, so the chips silently failed
 * to add up, and it rendered as a line of dashes that reads like a data bug.
 * No shipped client authors one today — the API accepts one, which is why it
 * has to be handled rather than assumed away.
 */
function bucketOf(p: BjjProficiency): Exclude<Bucket, "all"> {
  const tried = p.attempted + p.scored;
  if (tried > 0) return p.scored > 0 ? "working" : "stalled";
  if (p.drilled > 0) return "untried";
  return "against";
}

export default function ProficiencyPage() {
  const { getToken } = useAuth();
  const [rows, setRows] = useState<BjjProficiency[] | null>(null);
  const [summary, setSummary] = useState<BjjProficiencySummary | null>(null);
  const [focus, setFocus] = useState<BjjFocus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<Bucket>("all");
  const [search, setSearch] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const c = new AbortController();
    abortRef.current = c;
    try {
      // Together: a failed focus read must not blank the funnel, and vice
      // versa, but neither is worth a second round trip's latency.
      const [data, list] = await Promise.all([
        getBjjProficiency(getToken, c.signal),
        getBjjFocus(getToken, c.signal),
      ]);
      if (c.signal.aborted) return;
      setRows(data.techniques);
      setSummary(data.summary);
      setFocus(list);
      setError(null);
    } catch (err) {
      if (c.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      // Keep whatever was last loaded. An empty list is only right for the
      // FIRST failure, where there is nothing to keep — replacing good rows
      // with [] on a later one would delete a correct table because a refresh
      // failed. `?? []` also takes it out of the null/loading state so the
      // banner is not stacked on "Loading…".
      setRows((prev) => prev ?? []);
      setSummary((prev) => prev);
    }
  }, [getToken]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const focusIDs = useMemo(() => new Set(focus.map((f) => f.technique_id)), [focus]);

  /**
   * Toggling focus from the table, beside the numbers that justify it.
   *
   * Same pattern and the same reasoning as pinning on the Records page: on a
   * wide screen the choice and the thing being chosen can sit side by side, so
   * you decide what to work on *while looking at* the drop-off that says you
   * should. That is the insights→focus loop the design doc describes, and it
   * only works if the two are one screen rather than two.
   */
  const toggleFocus = useCallback(
    (p: BjjProficiency) => {
      const has = focusIDs.has(p.technique_id);
      if (!has && focus.length >= MAX_BJJ_FOCUS) {
        setError(
          `A focus list is at most ${MAX_BJJ_FOCUS} — drop one first. Keeping it short is the point.`,
        );
        return;
      }
      setError(null);
      const nextIDs = has
        ? focus.filter((f) => f.technique_id !== p.technique_id).map((f) => f.technique_id)
        : [...focus.map((f) => f.technique_id), p.technique_id];

      // Optimistic, with the real row put back on failure rather than leaving
      // the star and the stored list disagreeing. The optimistic entry carries
      // a placeholder started_on because only the server knows it — and the
      // response replaces the whole list, so the placeholder never survives a
      // success.
      const previous = focus;
      setFocus(
        has
          ? focus.filter((f) => f.technique_id !== p.technique_id)
          : [
              ...focus,
              {
                technique_id: p.technique_id,
                name: p.name,
                position: p.position,
                category: p.category,
                started_on: "",
              },
            ],
      );
      setBjjFocus(getToken, nextIDs)
        .then(setFocus)
        .catch((err) => {
          setFocus(previous);
          setError(err instanceof Error ? err.message : String(err));
        });
    },
    [focus, focusIDs, getToken],
  );

  /** Remove from the panel, where there is no proficiency row to hand over. */
  const dropFocus = useCallback(
    (techniqueID: string) => {
      setError(null);
      const previous = focus;
      const next = focus.filter((f) => f.technique_id !== techniqueID);
      setFocus(next);
      setBjjFocus(
        getToken,
        next.map((f) => f.technique_id),
      )
        .then(setFocus)
        .catch((err) => {
          setFocus(previous);
          setError(err instanceof Error ? err.message : String(err));
        });
    },
    [focus, getToken],
  );

  const shown = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((p) => {
      if (bucket !== "all" && bucketOf(p) !== bucket) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) || p.position.toLowerCase().includes(q)
      );
    });
  }, [rows, bucket, search]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = {
      all: rows?.length ?? 0,
      untried: 0,
      working: 0,
      stalled: 0,
      against: 0,
    };
    for (const p of rows ?? []) {
      c[bucketOf(p)] += 1;
    }
    return c;
  }, [rows]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-wide">
          Technique funnel
        </h1>
        <p className="max-w-2xl text-sm text-text-muted">
          What you have drilled, what you have actually tried in a live round,
          and what has worked. Built from what you logged after each session —
          not from a self-rating, so every number here has a session behind it.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="rounded-card border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger-ink"
        >
          <p className="font-semibold">Couldn’t load your funnel.</p>
          <p className="mt-0.5 text-text-muted">{error}</p>
          <button
            type="button"
            onClick={load}
            className="mt-2 rounded-control border border-line px-3 py-1.5 text-sm font-semibold hover:bg-surface-hover"
          >
            Try again
          </button>
        </div>
      )}

      {rows === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : error && rows.length === 0 ? (
        // Nothing below the banner. Rendering the chip row here asserted
        // "Everything 0 / Never tried live 0 / …" directly under a message
        // saying the load failed — four confident zeroes about data we do not
        // have.
        null
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {summary && <Funnel summary={summary} />}

          <FocusPanel focus={focus} onDrop={dropFocus} />

          <div className="flex flex-col gap-3">
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Filter techniques"
            >
              {BUCKETS.map((b) => {
                const active = bucket === b.key;
                return (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => setBucket(b.key)}
                    aria-pressed={active}
                    title={b.blurb}
                    className={[
                      "rounded-pill border px-3.5 py-1.5 text-sm font-semibold transition-colors",
                      active
                        ? "border-accent-fill bg-accent-fill text-accent-on-fill"
                        : "border-line text-text-muted hover:bg-surface-hover",
                    ].join(" ")}
                  >
                    {b.label}
                    <span className="ml-1.5 font-normal opacity-70">
                      {counts[b.key]}
                    </span>
                  </button>
                );
              })}
            </div>

            <label className="sr-only" htmlFor="proficiency-search">
              Search techniques
            </label>
            <input
              id="proficiency-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by technique or position"
              className="w-full max-w-sm rounded-control border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-text-muted"
            />
          </div>

          <h2 className="sr-only">Techniques</h2>
          {shown.length === 0 ? (
            <p className="text-sm text-text-muted" aria-live="polite">
              Nothing in this filter{search.trim() ? " matches that search" : ""}.
            </p>
          ) : (
            <TechniqueTable
              rows={shown}
              total={rows.length}
              focusIDs={focusIDs}
              onToggleFocus={toggleFocus}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The headline, and the reason the page is ordered this way.
 *
 * Three counts of TECHNIQUES — not reps. The gaps between them are the
 * finding: a wide drilled→tried gap means class content is not reaching your
 * rolling, which is the single most common and most fixable pattern in BJJ.
 */
function Funnel({ summary }: { summary: BjjProficiencySummary }) {
  const stages = [
    { label: "Techniques drilled", value: summary.drilled },
    { label: "Tried live", value: summary.tried_live },
    { label: "Landed live", value: summary.landed },
  ];
  // Every stage, not just `drilled`. The three are counted independently — a
  // technique tagged live without a drilled step lands in `tried_live` and not
  // in `drilled` — so `drilled` is not guaranteed to be the largest, and using
  // it as the denominator would ask for widths over 100% and clamp two
  // different numbers to the same bar.
  const widest = Math.max(1, summary.drilled, summary.tried_live, summary.landed);
  return (
    <section
      aria-label="Funnel summary"
      className="flex flex-col gap-3 rounded-card border border-line-soft bg-surface p-5"
    >
      <h2 className="sr-only">Summary</h2>
      {/* A description list, so a screen reader can walk the three stages as
          label/value pairs rather than one flat run of text. */}
      <dl className="flex flex-col gap-2.5">
        {stages.map((s) => (
          <div key={s.label} className="flex items-center gap-3">
            <dt className="w-40 shrink-0 text-sm text-text-muted">{s.label}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-3">
              {/* The bar needs its OWN track, because a percentage width on a
                  flex item resolves against the flex CONTAINER's content box —
                  not the space left after the label and the number. The bar was
                  the only shrinkable item here, so it absorbed the overflow: the
                  longest bar (always exactly 100% by construction) got clamped
                  while shorter ones sat at their true percentage, which
                  systematically flattened the very drop-off this section exists
                  to show. Nesting the fill inside a flex-1 track makes the
                  percentage resolve against the track. */}
              <span
                aria-hidden="true"
                className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-pill bg-surface-hover"
              >
                <span
                  className="block h-full rounded-pill bg-lime"
                  style={{ width: `${(s.value / widest) * 100}%` }}
                />
              </span>
              {/* bg-lime, NOT bg-lime-rule. The latter is not a mapped theme
                  colour at all — `@theme` exposes --color-lime and never
                  --color-lime-rule — so `bg-lime-rule` emitted no rule and the
                  bars rendered transparent. And it should not be added:
                  --c-lime-rule is #b8ff2c in BOTH modes, which is 1.21:1 on a
                  light card. --c-lime is theme-stepped and clears 3:1 in both. */}
              <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums">
                {s.value}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-text-muted">
        {summary.drilled === 0
          ? "No techniques drilled yet."
          : summary.tried_live === 0
            ? `You have drilled ${summary.drilled} ${summary.drilled === 1 ? "technique" : "techniques"} and taken none of them into a live round yet.`
            : `You have drilled ${summary.drilled} ${summary.drilled === 1 ? "technique" : "techniques"}, tried ${summary.tried_live} live, and landed ${summary.landed}.`}
      </p>
    </section>
  );
}

function TechniqueTable({
  rows,
  total,
  focusIDs,
  onToggleFocus,
}: {
  rows: BjjProficiency[];
  total: number;
  focusIDs: Set<string>;
  onToggleFocus: (p: BjjProficiency) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] border-collapse text-sm">
        {/* Live, and it names the count: pressing a filter chip otherwise
            swaps the whole table with nothing announced, and a static caption
            keeps asserting a claim the filter has invalidated. */}
        <caption className="sr-only" aria-live="polite">
          {rows.length === total
            ? `All ${total} techniques with recorded evidence, most evidence first`
            : `${rows.length} of ${total} techniques, most evidence first`}
        </caption>
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-text-dim">
            <th scope="col" className="w-10 py-2 pr-2 font-semibold">
              <span className="sr-only">Working on</span>
            </th>
            <th scope="col" className="py-2 pr-4 font-semibold">
              Technique
            </th>
            <th scope="col" className="py-2 pr-4 font-semibold">
              Position
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-semibold">
              Drilled
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-semibold">
              Tried
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-semibold">
              Landed
            </th>
            <th scope="col" className="py-2 pr-4 text-right font-semibold">
              Hit rate
            </th>
            <th scope="col" className="py-2 text-right font-semibold">
              Sessions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const tried = p.attempted + p.scored;
            return (
              <tr
                key={p.technique_id}
                className="border-b border-line-soft last:border-0"
              >
                <td className="py-2.5 pr-2">
                  <button
                    type="button"
                    onClick={() => onToggleFocus(p)}
                    aria-pressed={focusIDs.has(p.technique_id)}
                    // Names the technique, because a screen reader reading
                    // down a column of "Working on" buttons has nothing to
                    // bind each one to.
                    aria-label={`Working on ${p.name}`}
                    className={[
                      "rounded-control px-1.5 py-1 text-base leading-none transition-colors",
                      focusIDs.has(p.technique_id)
                        ? "text-lime"
                        : "text-text-dim hover:text-text-muted",
                    ].join(" ")}
                  >
                    {focusIDs.has(p.technique_id) ? "\u2605" : "\u2606"}
                  </button>
                </td>
                <th
                  scope="row"
                  className="py-2.5 pr-4 text-left font-semibold"
                >
                  {p.name}
                  {p.drilled > 0 && tried === 0 && (
                    <span className="ml-2 rounded-full bg-surface-hover px-2 py-0.5 text-xs font-semibold text-text-muted">
                      never tried live
                    </span>
                  )}
                </th>
                <td className="py-2.5 pr-4 text-text-muted">
                  {p.position || "—"}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums">
                  {p.drilled || "—"}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums">
                  {tried || "—"}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums font-semibold">
                  {p.scored || "—"}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-text-muted">
                  {/* Withheld under a handful of tries, deliberately. One
                      landed out of one is not a 100% hit rate, and showing it
                      as one invites a conclusion the data cannot support. */}
                  {tried >= MIN_TRIES_FOR_RATE ? (
                    `${Math.round((p.scored / tried) * 100)}%`
                  ) : tried > 0 ? (
                    // Visible text, not a `title`: a tooltip never appears on
                    // keyboard focus or on touch, and this is the only
                    // per-row signal telling "too few tries to say" apart
                    // from "never tried".
                    <span className="text-xs">too few</span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="py-2.5 text-right tabular-nums text-text-muted">
                  {p.sessions}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 max-w-2xl text-xs text-text-muted">
        “Tried” counts every time you went for it live, landed or not, so
        Landed is a subset of it. A hit rate appears once there are at least{" "}
        {MIN_TRIES_FOR_RATE} tries — below that it moves too much to mean
        anything. Sessions is how many separate sessions the evidence came
        from: the same count spread over six weeks is worth more than one
        night’s.
      </p>
    </div>
  );
}

/**
 * What you are working on, and how long you have been.
 *
 * Above the table on purpose: the design doc's loop is insights → focus →
 * curricula, and the focus is the thing you act on. It also gives the phone's
 * reflection wizard its one-tap rows, so this panel is the only place that
 * list can be set.
 */
function FocusPanel({ focus, onDrop }: { focus: BjjFocus[]; onDrop: (id: string) => void }) {
  if (focus.length === 0) {
    return (
      <section
        aria-label="Working on"
        className="rounded-card border border-dashed border-line bg-surface p-5"
      >
        <h2 className="font-semibold">Not working on anything specific</h2>
        <p className="mt-1 max-w-xl text-sm text-text-muted">
          Star up to {MAX_BJJ_FOCUS} techniques below — ideally ones you have drilled and never
          taken into a round. They become one-tap rows in the reflection on your phone, so you can
          record whether they worked without searching the library mid-thought.
        </p>
      </section>
    );
  }
  return (
    <section
      aria-label="Working on"
      className="rounded-card border border-line-soft bg-surface p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-semibold">Working on</h2>
        <span className="text-xs text-text-muted">
          {focus.length}/{MAX_BJJ_FOCUS} · one-tap on your phone
        </span>
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {focus.map((f) => (
          <li key={f.technique_id} className="flex items-center gap-3">
            <span className="flex-1 text-sm font-semibold">{f.name}</span>
            <span className="text-xs text-text-muted">{weeksOn(f.started_on)}</span>
            <button
              type="button"
              onClick={() => onDrop(f.technique_id)}
              aria-label={`Stop working on ${f.name}`}
              className="rounded-control border border-line px-2 py-1 text-xs font-semibold text-text-muted hover:bg-surface-hover"
            >
              Done
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * "3 weeks" — the whole reason `started_on` survives a re-save on the server.
 *
 * An empty string is the optimistic placeholder written before the server
 * answers; it renders as nothing rather than as "0 weeks", which would be a
 * number the athlete could read as real.
 */
function weeksOn(startedOn: string): string {
  if (!startedOn) return "";
  // Parsed as UTC midnight (the format the API sends) and compared in whole
  // days, so a viewer's timezone cannot shift the count by one.
  const started = Date.parse(`${startedOn}T00:00:00Z`);
  if (Number.isNaN(started)) return "";
  const days = Math.floor((Date.now() - started) / 86_400_000);
  if (days < 7) return "this week";
  const weeks = Math.floor(days / 7);
  return `${weeks} week${weeks === 1 ? "" : "s"}`;
}

function EmptyState() {
  return (
    <div className="rounded-card border border-line-soft bg-surface p-6">
      <p className="font-semibold">No technique evidence yet.</p>
      <p className="mt-1 max-w-xl text-sm text-text-muted">
        This fills in from the reflection you do after a session on your phone —
        the techniques you drilled, and whether you took any of them into a
        live round. Log a class and add a few techniques, and the funnel starts
        here.
      </p>
    </div>
  );
}
