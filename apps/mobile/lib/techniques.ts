import { newTraceId, traceparent } from './trace';
import { netFetch } from './authedFetch';
import type { TokenGetter } from './useAuthToken';

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
  /**
   * What the technique DOES: advance | reverse | escape | control | finish.
   *
   * Optional because the movement fundamentals (breakfalls, grappling stance)
   * genuinely have none — the API omits the key rather than sending "".
   * Note it cannot be destructured (`const { function } = t` is a syntax
   * error); read it as `t.function`.
   */
  function?: string;
  position: string;
  /**
   * Where the technique leaves you. Absent means NOT RECORDED, never "goes
   * nowhere" — a technique that genuinely stays put carries its own
   * `position` value here. Sparse by design; see migration 000029.
   */
  to_position?: string;
  position_detail: string;
  gi_no_gi: string;
  /** Commonly taught from — an observation, never a gate. */
  typical_belt: string;
  ibjjf_ruleset_id: string;
  /**
   * What this is set up from, by NAME. Carried on the summary so the graph
   * can be inverted client-side — see `lib/techniqueGraph.ts`.
   */
  setup_from: string[];
};

export type Technique = TechniqueSummary & {
  /** The mechanics. */
  description: string;
  /** The decision: when the mechanics apply. */
  when_to_use: string;
  common_next_moves: string[];
  common_counters: string[];
  /** Empty for every technique in the current library. */
  video_reference: string;
  source_notes: string;
  ibjjf?: Ruleset | null;
};

async function authed<T>(
  path: string,
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<T> {
  const token = await getToken();

  const res = await netFetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, traceparent: traceparent(newTraceId()) },
    signal,
  });
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as T;
}

export async function fetchTechniques(
  getToken: TokenGetter,
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
    // haystack() folds position on every entry now, where the old three-way
    // filter short-circuited on a name match and often never read it.
    position: t.position ?? '',
    position_detail: t.position_detail ?? '',
    typical_belt: t.typical_belt ?? '',
    ibjjf_ruleset_id: t.ibjjf_ruleset_id ?? '',
    setup_from: t.setup_from ?? [],
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
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<Technique> {
  const raw = await authed<Technique>(`/techniques/${encodeURIComponent(id)}`, getToken, signal);
  return normalise(raw);
}

/**
 * The summaries, cached for the app's lifetime.
 *
 * Originally this existed because the detail screen refetched all 466 (~65 KB)
 * on every open just to decide which edges were tappable. Those links are gone,
 * and so is that fetch — but the cache still earns its keep: the Library holds
 * the whole list to search locally, so returning to the tab is free rather than
 * another ~65 KB, and typing never touches the network.
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
  getToken: TokenGetter,
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
 * Lowercase and strip diacritics, so what someone types on a phone matches
 * what the library actually stores.
 *
 * This is not cosmetic. `sao-paulo-pass` — "São Paulo Pass" — has been in the
 * catalog the whole time and was unfindable: a plain `toLowerCase().includes()`
 * fails "sao paulo" against "São Paulo" because the strings genuinely differ,
 * and nobody types the tilde on a phone keyboard. The technique looked missing,
 * and the near-consequence was authoring a duplicate — two ids for one
 * technique, permanently, in every training record that referenced either.
 *
 * NFD splits "ã" into "a" + U+0303 COMBINING TILDE; the range U+0300–U+036F is
 * the combining-marks block, so removing it leaves the base letters. Hermes
 * implements `String.prototype.normalize` (verified in the shipped binary — it
 * carries the NFKC/NFKD form names and the "Invalid normalization form" error
 * beside its other String.prototype errors), so this is safe on device, not
 * only in jest's Node.
 *
 * Dashes fold the same way and for the same reason, and they are the LARGER
 * half of this bug: 16 technique names are spelled with U+2013 EN DASH
 * ("North–South Pass"), which NFD does not decompose. Typing the hyphen
 * that is actually on the keyboard is not a misspelling — the two
 * characters render nearly identically — so "north-south pass" finding
 * nothing is the São Paulo failure again with eight times the blast
 * radius. The app's own vocabulary disagrees with itself here: positions.json
 * spells the position "North-South" with a plain hyphen while every technique
 * name in it uses the en dash.
 *
 * Every dash folds to a SPACE rather than to a hyphen, which also makes
 * "north south" and "kesa gatame" work — nobody reaches for a hyphen when
 * searching. Measured over every name and alias in the catalog: folding to a
 * space finds everything folding to a hyphen finds, plus six more query forms,
 * and loses nothing.
 *
 * DUPLICATED in apps/web/src/lib/api.ts. The two apps share no package, and mobile
 * needs its copy to work offline — the same reason the position vocabulary
 * is duplicated four ways. Change one, change the other: nothing enforces it,
 * `verify` runs no web tests, and a silent divergence here is invisible.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[-\u2010-\u2015\u2212]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Folded haystacks, cached per technique object.
 *
 * Search runs on every keystroke over the whole 466-entry library. Folding
 * name + aliases + position each time is 1592 fold calls per character typed,
 * measured at 0.774 ms uncached against 0.029 ms cached on Node (27x) — Hermes
 * is several times slower again, which is where it starts to matter on a phone
 * mid-session.
 *
 * A WeakMap keyed on the technique object is what makes this safe: the catalog
 * objects are built once in fetchTechniques and never written to, so a refetch
 * makes new objects and the stale entries are collected with them. That
 * immutability is the load-bearing assumption and it is a CONVENTION, not
 * something enforced — mutate a summary in place and search silently keeps
 * answering from the pre-mutation text. Build a new object instead.
 */
const foldedCache = new WeakMap<object, string>();

function haystack(t: TechniqueSummary): string {
  const hit = foldedCache.get(t);
  if (hit !== undefined) return hit;
  // One joined string rather than three comparisons: the separator stops a
  // query spanning two fields ("armbar guard") from matching across the join.
  const built = [foldForSearch(t.name), ...t.aliases.map(foldForSearch), foldForSearch(t.position)].join('\n');
  foldedCache.set(t, built);
  return built;
}

/**
 * Local search across name, aliases and position.
 *
 * Aliases matter more than they look: half this library is known by two names,
 * and someone searching "scarf hold" will never find "Kesa-Gatame Escape"
 * without them.
 */
export function searchTechniques(list: TechniqueSummary[], query: string): TechniqueSummary[] {
  const q = foldForSearch(query.trim());
  if (!q) return list;
  return list.filter((t) => haystack(t).includes(q));
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
