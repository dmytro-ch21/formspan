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
  const body = await authed<{ techniques: TechniqueSummary[] }>('/techniques', getToken, signal);
  return body.techniques ?? [];
}

export async function fetchTechnique(
  id: string,
  getToken: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<Technique> {
  return authed<Technique>(`/techniques/${encodeURIComponent(id)}`, getToken, signal);
}

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
  return byName.get(label.trim().toLowerCase()) ?? null;
}

export function indexByName(list: TechniqueSummary[]): Map<string, TechniqueSummary> {
  const m = new Map<string, TechniqueSummary>();
  for (const t of list) {
    m.set(t.name.toLowerCase(), t);
    for (const a of t.aliases) if (!m.has(a.toLowerCase())) m.set(a.toLowerCase(), t);
  }
  return m;
}
