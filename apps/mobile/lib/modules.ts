import { apiRequest } from './apiRequest';

/**
 * The discipline registry, as the phone sees it.
 *
 * The server owns the list — which disciplines exist, what each is called, and
 * what each can do — and this module is the client half. Before this, the same
 * closed set was written down six times across this app in lists that had
 * already drifted apart: Today offered strength and running, the Library
 * offered strength, BJJ and running, profile edit offered four keyed on
 * database column names, and the "You" screen had a fifth inline array.
 *
 * A module is NOT the same thing as a sport. `nutrition` is a module you can
 * turn on and off, but there is no nutrition catalog, session or row — so
 * anything picking a sport must filter on `is_sport`, not just `enabled`.
 *
 * **Capabilities are separate from enablement on purpose.** "Is BJJ on?" and
 * "does BJJ have 1RM records?" are different questions; collapsing them is how
 * a BJJ-only athlete ends up with a Records screen whose every record kind is
 * lift- or run-shaped.
 *
 * And what these must NOT decide: whether a *metric* is shown. That stays
 * driven by the data present, so an athlete who spent a month on the mat sees
 * time rather than a flat zero volume line even with strength enabled. The
 * rule is: toggles decide what you can reach, data decides what you can read.
 */

export type ModuleCapabilities = {
  /** "exercises" | "techniques" | "" — what the Library shows for this. */
  catalog: string;
  /** Extra filter axes beyond the catalog's own. BJJ has "position". */
  facets: string[];
  has_goals: boolean;
  has_progression: boolean;
  /** Empty means this discipline has no personal bests worth a screen. */
  record_kinds: string[];
};

export type Module = {
  key: string;
  /** Carries the acronym: "BJJ", not the "Bjj" that capitalising the key gives. */
  label: string;
  is_sport: boolean;
  default_on: boolean;
  enabled: boolean;
  capabilities: ModuleCapabilities;
};

/**
 * Normalise at the parse boundary.
 *
 * An older server omits `facets` or `record_kinds` entirely, and
 * `undefined.map` in a render is a white screen rather than a degraded one.
 * That is exactly the shape of a staged rollout — the app updates before the
 * API does, or points at an older environment.
 */
function normalise(m: Partial<Module> & { key: string }): Module {
  const caps = m.capabilities ?? ({} as Partial<ModuleCapabilities>);
  return {
    key: m.key,
    label: m.label ?? m.key,
    is_sport: m.is_sport ?? false,
    default_on: m.default_on ?? false,
    enabled: m.enabled ?? m.default_on ?? false,
    capabilities: {
      catalog: caps.catalog ?? '',
      facets: caps.facets ?? [],
      has_goals: caps.has_goals ?? false,
      has_progression: caps.has_progression ?? false,
      record_kinds: caps.record_kinds ?? [],
    },
  };
}

/**
 * Normalise a list from any source — the wire, or the local cache.
 *
 * Exported because the cache is a parse boundary too: a cached array from a
 * build whose shape differed would otherwise crash in render rather than
 * degrade.
 */
export function normaliseModules(raw: unknown): Module[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(hasKey).map(normalise);
}

export async function fetchModules(getToken: () => Promise<string | null>): Promise<Module[]> {
  const body = await apiRequest<{ modules: Module[] }>(getToken, '/modules');
  return normaliseModules(body.modules);
}

/**
 * Toggle one or more modules. Sparse: send only what changed.
 *
 * PRECONDITION: the user must already have a profile row — `profile_modules`
 * has an FK to `profiles`, so calling this before onboarding fails with a 400.
 * Today's only caller saves the profile first, which creates the row; any new
 * caller (onboarding, a quick-toggle in Settings) has to do the same.
 */
export async function setModules(
  getToken: () => Promise<string | null>,
  changes: Record<string, boolean>,
): Promise<Module[]> {
  const body = await apiRequest<{ modules: Module[] }>(getToken, '/modules', {
    method: 'PATCH',
    body: JSON.stringify(changes),
  });
  return normaliseModules(body.modules);
}

/**
 * An entry with no usable key would render a blank row whose toggle PATCHes
 * `{"undefined": true}`. `normalise` exists to defend this boundary, so the
 * filter belongs beside it rather than in every caller.
 */
function hasKey(m: Partial<Module>): m is Partial<Module> & { key: string } {
  return typeof m.key === 'string' && m.key.length > 0;
}

/**
 * Last-resort defaults, for when the server cannot be asked at all.
 *
 * NOT a second source of truth — the server's answer always wins the moment
 * there is one, and this is never merged with it. It exists because the
 * alternative is worse: with no cache and no reachable endpoint, an empty list
 * makes the app assert that you train *nothing*. That hides the Library tab,
 * replaces Today's start buttons with a prompt, and — the way it was found —
 * renders the very toggles you would use to fix it as an empty card. An
 * unanswerable question was being reported as a definite answer.
 *
 * Mirrors the registry's DefaultOn values. If they drift, a first-run user on
 * an unreachable server sees a slightly wrong default for one render, which is
 * a far smaller failure than a dead app.
 */
const FALLBACK: Module[] = [
  {
    key: 'strength',
    label: 'Strength',
    is_sport: true,
    default_on: true,
    enabled: true,
    capabilities: {
      catalog: 'exercises',
      facets: [],
      has_goals: true,
      has_progression: true,
      record_kinds: ['heaviest_weight', 'estimated_1rm', 'most_reps'],
    },
  },
  {
    key: 'bjj',
    label: 'BJJ',
    is_sport: true,
    default_on: true,
    enabled: true,
    capabilities: {
      catalog: 'techniques',
      facets: ['position'],
      has_goals: false,
      has_progression: false,
      record_kinds: [],
    },
  },
  {
    key: 'running',
    label: 'Running',
    is_sport: true,
    default_on: false,
    enabled: false,
    capabilities: {
      catalog: 'exercises',
      facets: [],
      has_goals: false,
      has_progression: false,
      record_kinds: ['longest_time', 'furthest_distance'],
    },
  },
  {
    key: 'nutrition',
    label: 'Nutrition',
    is_sport: false,
    default_on: true,
    enabled: true,
    capabilities: {
      catalog: '',
      facets: [],
      has_goals: false,
      has_progression: false,
      record_kinds: [],
    },
  },
];

/** A copy, so a caller filtering or sorting can't corrupt the fallback. */
export function fallbackModules(): Module[] {
  return FALLBACK.map((m) => ({ ...m, capabilities: { ...m.capabilities } }));
}

/** The enabled modules that can actually be a session's sport. */
export function enabledSports(modules: Module[]): Module[] {
  return modules.filter((m) => m.enabled && m.is_sport);
}

/**
 * Look up one module. Returns undefined for a key this build doesn't know —
 * the house rule for every lookup table here, because a server can ship a
 * discipline before the app that renders it does.
 */
export function moduleFor(modules: Module[], key: string): Module | undefined {
  return modules.find((m) => m.key === key);
}

/**
 * The label for a sport key, falling back to the key itself.
 *
 * Every screen that printed a raw key — "Search bjj exercises", a session
 * titled "bjj" — should route through this instead.
 */
export function labelFor(modules: Module[], key: string): string {
  return moduleFor(modules, key)?.label ?? key;
}
