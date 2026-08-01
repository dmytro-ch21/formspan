import { newTraceId, traceparent } from './trace';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const API_BASE = `${API_URL}/v1`;

/**
 * The BJJ technique library on the phone.
 *
 * Three deliberate shapes here, all of them about keeping a 466-entry library
 * feeling instant:
 *
 * 1. **Summary vs Technique.** The list endpoint returns summaries — no prose.
 *    Full rows would be ~274 KB to draw a scrolling list; summaries are ~65 KB.
 *    The detail screen fetches the one technique it needs.
 * 2. **Search is local.** Summaries carry `aliases`, so filtering happens in
 *    memory against a list already held. Typing does not hit the network, which
 *    is what makes it feel immediate rather than merely fast.
 * 3. **Rulesets are fetched once.** 25 of them cover all 466 techniques, and
 *    they change with the IBJJF rulebook rather than with the library. Held in
 *    a module-level cache so a legality badge on every row costs no requests.
 */

export type Ruleset = {
  id: string;
  age_scope: string;
  rule_class: string;
  /** Empty means this division doesn't apply, NOT "allowed at no belt". */
  gi_allowed_belts: string[];
  gi_note: string;
  no_gi_allowed_belts: string[];
  no_gi_note: string;
  /**
   * A genuine restriction, as opposed to the shape of IBJJF's divisions.
   * Trust this field — do NOT infer restriction by counting belts. Adult no-gi
   * has no white belt division, so a no-gi list of Blue/Purple/Brown/Black is
   * the baseline; counting marks ~130 ordinary techniques as restricted when
   * only 20 are.
   */
  is_restricted: boolean;
  notes: string;
  sources: string[];
};

export type TechniqueSummary = {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  position: string;
  position_detail: string;
  gi_no_gi: string;
  /** Commonly taught from — an observation, never a gate. */
  typical_belt: string;
  ibjjf_ruleset_id: string;
};

export type Technique = TechniqueSummary & {
  /** The mechanics. */
  description: string;
  /** The decision: when the mechanics apply. */
  when_to_use: string;
  setup_from: string[];
  common_next_moves: string[];
  common_counters: string[];
  /** Empty for every technique in the current library. */
  video_reference: string;
  source_notes: string;
  ibjjf?: Ruleset | null;
};

async function authed<T>(
  path: string,
  getToken: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error('Not signed in.');

  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, traceparent: traceparent(newTraceId()) },
    signal,
  });
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as T;
}

export async function fetchTechniques(
  getToken: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<TechniqueSummary[]> {
  // Fetched unfiltered on purpose. The whole library is ~65 KB as summaries,
  // and holding all of it makes filtering and search local — a per-keystroke
  // request would be slower and would fail offline.
  if (summaryCache) return summaryCache;
  const body = await authed<{ techniques: TechniqueSummary[] }>('/techniques', getToken, signal);
  // Same reasoning as normalise(): an older server omits aliases and the
  // ruleset id, and local search maps over aliases on every keystroke.
  summaryCache = (body.techniques ?? []).map((t) => ({
    ...t,
    aliases: t.aliases ?? [],
    position_detail: t.position_detail ?? '',
    typical_belt: t.typical_belt ?? '',
    ibjjf_ruleset_id: t.ibjjf_ruleset_id ?? '',
  }));
  return summaryCache;
}

/**
 * Normalise the array fields at the parse boundary.
 *
 * Not defensive programming for its own sake — a server that predates this
 * enrichment omits `common_next_moves`, `when_to_use` and `ibjjf_ruleset_id`
 * entirely, and `undefined.length` in a render is a white screen rather than a
 * degraded one. That is exactly the shape of a staged rollout: the app updates
 * before the API does, or points at an older environment.
 *
 * Doing it here rather than in each component means a new consumer cannot
 * forget. The screen's job is to render what it is given; guaranteeing the
 * shape is this module's.
 */
function normalise(t: Partial<Technique> & { id: string; name: string }): Technique {
  return {
    ...(t as Technique),
    aliases: t.aliases ?? [],
    setup_from: t.setup_from ?? [],
    common_next_moves: t.common_next_moves ?? [],
    common_counters: t.common_counters ?? [],
    description: t.description ?? '',
    when_to_use: t.when_to_use ?? '',
    video_reference: t.video_reference ?? '',
    source_notes: t.source_notes ?? '',
    typical_belt: t.typical_belt ?? '',
    position_detail: t.position_detail ?? '',
    ibjjf_ruleset_id: t.ibjjf_ruleset_id ?? '',
  };
}

export async function fetchTechnique(
  id: string,
  getToken: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<Technique> {
  const raw = await authed<Technique>(`/techniques/${encodeURIComponent(id)}`, getToken, signal);
  return normalise(raw);
}

/**
 * The summaries, cached for the app's lifetime.
 *
 * Without this the detail screen refetched all 466 (~65 KB) on every open,
 * serially and before first paint, purely to decide which edges are tappable —
 * browsing ten techniques cost ~650 KB and ten round trips. The list screen
 * warms it, so opens from the list are free and a cold deep link pays once.
 *
 * Failures are not cached: a null cache retries, an empty array would look
 * like a library with nothing in it.
 */
let summaryCache: TechniqueSummary[] | null = null;

let rulesetCache: Map<string, Ruleset> | null = null;

/**
 * Rulesets, fetched at most once per app run.
 *
 * Failure returns an empty map rather than throwing: a missing legality badge
 * should never stop a technique being read. The caller distinguishes "no
 * ruleset" from "unknown" by whether the id was empty, so an empty map reads
 * as "we don't know" rather than "unrestricted".
 */
export async function fetchRulesets(
  getToken: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<Map<string, Ruleset>> {
  if (rulesetCache) return rulesetCache;
  try {
    const body = await authed<{ rulesets: Ruleset[] }>('/techniques/rulesets', getToken, signal);
    rulesetCache = new Map((body.rulesets ?? []).map((r) => [r.id, r]));
    return rulesetCache;
  } catch {
    return new Map();
  }
}

/**
 * Local search across name and aliases.
 *
 * Aliases matter more than they look: half this library is known by two names,
 * and someone searching "scarf hold" will never find "Kesa-Gatame Escape"
 * without them.
 */
export function searchTechniques(list: TechniqueSummary[], query: string): TechniqueSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.aliases.some((a) => a.toLowerCase().includes(q)) ||
      t.position.toLowerCase().includes(q),
  );
}

/**
 * Resolve a graph edge to a technique, if it names one at all.
 *
 * Only ~80% of `setup_from` entries name a real technique; for
 * `common_next_moves` it is ~29% and for `common_counters` ~6% — the rest is
 * prose like "establish grips or inside ties". Callers must render a `null`
 * result as plain text: a dead link is worse than honest text.
 */
export function resolveEdge(
  label: string,
  byName: Map<string, TechniqueSummary>,
): TechniqueSummary | null {
  return byName.get(edgeKey(label)) ?? null;
}

/**
 * Index every handle a graph edge might be written with: id, name, alias.
 *
 * The id keys are a **back-compat shim, and still load-bearing.** `setup_from`
 * used to store ids (`grappling_stance_motion`) rather than names; the importer
 * now resolves them, but a server that has not been re-seeded still serves the
 * old shape — staging included, at the time of writing. Indexing names alone
 * against that data resolved 13 of 541 setup edges (2%) instead of 417 (77%),
 * so 368 of 466 detail screens showed raw snake_case at the user.
 *
 * Safe to keep against new data: no technique name or alias contains an
 * underscore, so `edgeKey`'s `_`→`-` swap is a no-op on resolved names. Delete
 * the id pass only once every deployment is re-seeded.
 *
 * Insertion order is deliberate: ids first, then names, then aliases, with
 * aliases never overwriting. A name is a better answer than someone else's
 * alias when both match.
 */
export function indexByName(list: TechniqueSummary[]): Map<string, TechniqueSummary> {
  const m = new Map<string, TechniqueSummary>();
  for (const t of list) m.set(t.id.toLowerCase(), t);
  for (const t of list) m.set(t.name.toLowerCase(), t);
  for (const t of list) {
    for (const a of t.aliases) if (!m.has(a.toLowerCase())) m.set(a.toLowerCase(), t);
  }
  return m;
}

/** Normalise an edge label to the form the index is keyed on. */
export function edgeKey(label: string): string {
  return label.trim().toLowerCase().replace(/_/g, '-');
}

/**
 * Split a technique's description into execution steps.
 *
 * The library's `description` is authored as ONE sentence containing a
 * comma-separated sequence — "Control wrist and elbow, break posture, pivot
 * across the shoulder, clamp the knees, and extend the hips through the elbow
 * line." That is five instructions wearing a paragraph, and it is the single
 * biggest reason the detail screen read as a wall of text.
 *
 * Measured across all 466 before being built on: 458 (98%) split into 2+ steps,
 * clustered at 3–4, averaging 30 characters each, with no step under 10 or over
 * 110 characters. The remaining 8 return `[]` and the caller renders the
 * original prose — a one-item numbered list looks like a bug.
 *
 * The fragment-folding rule is length-only on purpose. An earlier version also
 * folded anything under three words and swallowed real instructions: "break
 * posture" is a step, not a tail. Length alone separates the two cleanly on
 * this corpus.

 * The split deliberately avoids a lookbehind. `(?<=\.)\s+` fired on zero of
 * 466 (trailing periods are stripped anyway), and on web `lib/api.ts` is
 * imported by every dashboard page — a regex literal Next/SWC does not
 * transpile, so an unsupported feature is a parse-time SyntaxError that takes
 * the whole dashboard down on Safari/iOS < 16.4. `\.\s+` is byte-identical on
 * this corpus and carries no engine-support risk.
 *
 * `;` joins the split for the same reason `,` does: 6 of the 8 prose fallbacks
 * were semicolon-joined instruction pairs.
 */
export function executionSteps(description: string): string[] {
  const raw = (description || '').trim();
  if (!raw) return [];

  const parts = raw
    .split(/[,;]\s*(?:and\s+)?|\.\s+/)
    .map((p) => p.trim().replace(/\.$/, ''))
    .filter(Boolean);

  const merged: string[] = [];
  for (const p of parts) {
    if (merged.length && p.length < 10) merged[merged.length - 1] += `, ${p}`;
    else merged.push(p);
  }

  if (merged.length < 2) return [];
  return merged.map((p) => p.charAt(0).toUpperCase() + p.slice(1));
}
