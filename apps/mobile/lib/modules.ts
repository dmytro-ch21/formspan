import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

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
  /**
   * Whether this module has a food log, its target, and the tab that reaches
   * them. True only for nutrition.
   *
   * A capability rather than `key === 'nutrition'` at each call site, for the
   * reason every other gate here exists: a discipline gaining or losing a
   * surface should be one row on the server, not an edit in three apps. It is
   * a distinct flag rather than a reading of `!is_sport`, because those answer
   * different questions — `is_sport` says a session cannot have this sport,
   * which happens to be true here and says nothing about a food log.
   */
  has_food_log: boolean;
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
      has_food_log: caps.has_food_log ?? false,
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

export async function fetchModules(getToken: TokenGetter): Promise<Module[]> {
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
  getToken: TokenGetter,
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
      // Mirrored from the registry, the way BJJ's already are four entries
      // down. It only matters on a genuine first run with no cache and an
      // unreachable server — but leaving it empty there means the Library
      // silently offers no strength filters in exactly that case, and the
      // inconsistency with BJJ is the kind that reads as a bug later.
      facets: ['muscle', 'movement'],
      has_goals: true,
      has_progression: true,
      has_food_log: false,
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
      facets: ['position', 'belt'],
      has_goals: false,
      has_progression: false,
      has_food_log: false,
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
      // No facets: the registry gives running none. Kept explicitly empty
      // rather than copied from strength — they share a catalog kind, which
      // is exactly why a careless edit lands here too.
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: false,
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
      // The only true one. Nutrition is a module rather than a sport, and this
      // is what makes its surface reachable without anybody comparing keys.
      has_food_log: true,
      record_kinds: [],
    },
  },
];

/** A copy, so a caller filtering or sorting can't corrupt the fallback. */
export function fallbackModules(): Module[] {
  return FALLBACK.map((m) => ({ ...m, capabilities: { ...m.capabilities } }));
}

/**
 * Is the food log reachable at all?
 *
 * `enabled && has_food_log`, in one place, because the tab bar and the Today
 * card both ask it and two copies of a two-part condition is how one of them
 * ends up checking only half. Same shape as `usesBelt` below.
 */
export function hasFoodLog(modules: Module[]): boolean {
  return modules.some((m) => m.enabled && m.capabilities.has_food_log);
}

/** The enabled modules that can actually be a session's sport. */
export function enabledSports(modules: Module[]): Module[] {
  return modules.filter((m) => m.enabled && m.is_sport);
}

/**
 * A discipline this server HAS whose catalog is `catalog`, which this athlete
 * has turned OFF.
 *
 * The counterpart to every `enabled && capabilities.X` gate in the app, and it
 * exists because those gates were producing silence. N61: with BJJ off, the
 * belt roadmaps, the Plan tab's Roadmaps strip and the position map all
 * rendered nothing at all — and an athlete cannot tell *not enabled* from *not
 * built* from *broken*. The user went looking for the roadmaps on a real phone
 * and reported them missing; they exist and work.
 *
 * **Three states, not two, and the third is why this is a function rather than
 * a `!` on the existing gate.** A surface is either on, off-but-available, or
 * genuinely absent from this deployment — and only the middle one should offer
 * to turn something on. Promising a feature a server does not have is the same
 * lie as hiding one it does, pointing the other way.
 *
 * A helper rather than three inline copies, for the reason `hasFoodLog` gives:
 * two copies of a two-part condition is how one of them ends up checking only
 * half. Three call sites had already been written by hand before this existed.
 */
export function moduleOffWithCatalog(modules: Module[], catalog: string): Module | undefined {
  return modules.find((m) => !m.enabled && m.capabilities.catalog === catalog);
}

/**
 * The enabled discipline whose catalog is `catalog` — the positive half of
 * {@link moduleOffWithCatalog}, and the gate every technique-shaped surface
 * asks before it draws anything.
 *
 * A function for the reason `hasFoodLog` gives, except that this one had
 * already rotted into **three** hand-written copies of the same two-part
 * condition — `app/library.tsx`, the Plan tab's Roadmaps strip, and
 * `lib/__tests__/moduleGating.test.ts` — before Today needed a fourth. Two
 * copies is how one ends up checking only half; three is how one of them keeps
 * checking a capability name the server has renamed.
 *
 * The two screens now call this. **The test deliberately still spells the
 * condition out**, and should stay that way: a test that called this function
 * would be asserting it against itself.
 *
 * Gated on the CAPABILITY, never on `key === 'bjj'`. A discipline gaining or
 * losing a technique catalog should be one row on the server rather than an
 * edit in four screens.
 */
export function moduleWithCatalog(modules: Module[], catalog: string): Module | undefined {
  return modules.find((m) => m.enabled && m.capabilities.catalog === catalog);
}

/**
 * A module this server HAS that carries the food log, which this athlete has
 * turned OFF.
 *
 * The mirror of `hasFoodLog`, and the same three-state reasoning as
 * `moduleOffWithCatalog`: on, off-but-available, or genuinely absent from this
 * deployment. Only the middle one may offer to turn something on.
 *
 * Returns the MODULE rather than a boolean, because the prompt names it — "1
 * discipline is off" does not tell an athlete it is the one they were looking
 * for, and the label carries the registry's spelling rather than a
 * capitalised key.
 *
 * A `find`, not a `some`, for that reason; and a helper rather than an inline
 * `!m.enabled && m.capabilities.has_food_log`, for the one `hasFoodLog` itself
 * gives — two copies of a two-part condition is how one ends up checking only
 * half.
 */
export function moduleOffWithFoodLog(modules: Module[]): Module | undefined {
  return modules.find((m) => !m.enabled && m.capabilities.has_food_log);
}

/**
 * Does this DEPLOYMENT have a food log at all — on, off, doesn't matter?
 *
 * The tab bar's question, and it is deliberately not `hasFoodLog`. Every other
 * gate in this file asks whether a surface should be DRAWN; this one asks
 * whether a surface should be REACHABLE, and those come apart precisely in the
 * off-but-available state that N61 is about.
 *
 * The Food and Goals tabs used to be hidden on `!hasFoodLog`, which erased 40%
 * of the primary navigation with nothing left behind to say why — and the two
 * screens behind them are the ones that would have explained it. A tab is a
 * LINK, and #370's finding was that the destinations were never the problem:
 * they already explain themselves, and nothing linked to them. So the link
 * stays wherever the destination has something to say, and it is the screen
 * that distinguishes off from absent.
 *
 * Which leaves exactly one case where hiding is still right, and it is the
 * third state: a deployment with no food-log module at all. There is nothing to
 * turn on, so a tab leading to "turn it on" would promise a feature the server
 * does not have — the same lie as hiding one it does, pointing the other way.
 *
 * Equal by construction to `hasFoodLog(m) || moduleOffWithFoodLog(m) !== undefined`,
 * and written as the single `some` rather than that disjunction because the
 * union of the two is just "the capability exists". The equivalence is pinned
 * in `moduleGating.test.ts` so the three predicates cannot drift apart.
 */
export function serverHasFoodLog(modules: Module[]): boolean {
  return modules.some((m) => m.capabilities.has_food_log);
}

/**
 * What a food-log SCREEN needs to know: should it draw its off-state, and which
 * module should that off-state name?
 *
 * One function because `(tabs)/food.tsx` and `(tabs)/goals.tsx` ask exactly
 * this, and a two-part condition written twice is how one copy ends up checking
 * only half — the reason `hasFoodLog` itself exists.
 *
 * **`ready` is the load-bearing half and it is easy to drop.** The module list
 * is empty until the cache has been read, and an empty list is an *unanswered
 * question*, not a "no". Without `ready` both screens assert "Nutrition is
 * turned off" for the first frames of every cold start — the same flash the tab
 * bar holds a frame to avoid, relocated one level down, and worse here because
 * it is a sentence rather than a missing button.
 *
 * `off` is computed regardless of `ready` and is simply `undefined` while the
 * list is empty, which is correct: nothing is drawn from it until `disabled`.
 */
export function foodLogGate(
  modules: Module[],
  ready: boolean,
): { disabled: boolean; off: Module | undefined } {
  return {
    disabled: ready && !hasFoodLog(modules),
    off: moduleOffWithFoodLog(modules),
  };
}

/**
 * Disciplines that could hold a session and are turned off.
 *
 * The mirror of `enabledSports`, and `is_sport` filtered for the same reason:
 * nutrition is a module you can turn off, and "log a nutrition session" is
 * nonsense — so offering to turn it on from a session picker would be too.
 */
export function offSports(modules: Module[]): Module[] {
  return modules.filter((m) => !m.enabled && m.is_sport);
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

/**
 * Does this discipline wear a belt?
 *
 * `enabled` as well as the facet, so this answers "should belt-shaped UI be
 * reachable" rather than "does BJJ have belts" — the latter is true even with
 * BJJ turned off. Lived in `library.tsx` until Today needed it too; a second
 * copy is how the position vocabulary rotted across four files.
 */
export function usesBelt(sport: string, mods: Module[]): boolean {
  const m = moduleFor(mods, sport);
  return (m?.enabled && m.capabilities.facets.includes('belt')) ?? false;
}
