import {
  foodLogGate,
  moduleOffWithCatalog,
  moduleOffWithFoodLog,
  offSports,
  enabledSports,
  hasFoodLog,
  serverHasFoodLog,
  type Module,
} from '../modules';

/**
 * N61 — telling "turned off" apart from "does not exist".
 *
 * Every module gate in this app is `enabled && capabilities.X`, and when it is
 * false the surface renders NOTHING. The user went looking for the belt
 * roadmaps on a real phone, reported them missing, and they exist and work —
 * because an athlete cannot distinguish *not enabled* from *not built* from
 * *broken*.
 *
 * These pin the predicate that makes the difference sayable. The important
 * property is that there are **three** states, not two: a surface is on,
 * off-but-available, or genuinely absent from this deployment — and only the
 * middle one may offer to turn something on. Promising a feature the server
 * does not have is the same lie as hiding one it does.
 */

function mod(over: Partial<Module> & { key: string }): Module {
  return {
    key: over.key,
    label: over.label ?? over.key,
    is_sport: over.is_sport ?? true,
    default_on: over.default_on ?? true,
    enabled: over.enabled ?? true,
    capabilities: {
      catalog: '',
      facets: [],
      has_goals: false,
      has_progression: false,
      has_food_log: false,
      record_kinds: [],
      ...(over.capabilities ?? {}),
    },
  };
}

const bjjOn = mod({ key: 'bjj', label: 'BJJ', capabilities: { catalog: 'techniques' } as Module['capabilities'] });
const bjjOff = { ...bjjOn, enabled: false };
const strength = mod({ key: 'strength', label: 'Strength', capabilities: { catalog: 'exercises' } as Module['capabilities'] });
const nutritionOff = mod({ key: 'nutrition', label: 'Nutrition', is_sport: false, enabled: false });

describe('moduleOffWithCatalog', () => {
  // The state the whole task is about.
  it('finds a discipline that exists and is turned off', () => {
    expect(moduleOffWithCatalog([strength, bjjOff], 'techniques')?.key).toBe('bjj');
  });

  // An ENABLED discipline must not be reported as off, or the app offers to
  // turn on something already on — which reads as the feature being broken.
  it('returns nothing when the discipline is enabled', () => {
    expect(moduleOffWithCatalog([strength, bjjOn], 'techniques')).toBeUndefined();
  });

  // **The third state.** A deployment with no technique catalog at all must
  // show nothing rather than an invitation to enable a discipline that does
  // not exist. This is the case a plain `!enabled` check gets wrong.
  it('returns nothing when this server has no such discipline', () => {
    expect(moduleOffWithCatalog([strength], 'techniques')).toBeUndefined();
  });

  // Matched on the CAPABILITY, never on the key — the pattern this codebase
  // bans, because a discipline gaining or losing a surface should be one row
  // on the server rather than an edit in three apps.
  it('matches on the catalog capability rather than the key', () => {
    const judo = { ...bjjOff, key: 'judo', label: 'Judo' };
    expect(moduleOffWithCatalog([judo], 'techniques')?.key).toBe('judo');
  });

  it('does not confuse one catalog for another', () => {
    expect(moduleOffWithCatalog([{ ...strength, enabled: false }], 'techniques')).toBeUndefined();
  });
});

describe('offSports', () => {
  it('lists disabled disciplines that could hold a session', () => {
    expect(offSports([strength, bjjOff]).map((m) => m.key)).toEqual(['bjj']);
  });

  // `is_sport` filtered, mirroring enabledSports: "log a nutrition session"
  // is nonsense, so offering to turn nutrition on from a session picker
  // would be too.
  it('excludes non-sport modules', () => {
    expect(offSports([strength, nutritionOff]).map((m) => m.key)).toEqual([]);
  });

  // The two halves must partition the sports between them — a discipline that
  // appears in neither is one the athlete can neither use nor discover, which
  // is the bug in its purest form.
  it('together with enabledSports covers every sport exactly once', () => {
    const all = [strength, bjjOff, nutritionOff];
    const on = enabledSports(all).map((m) => m.key);
    const off = offSports(all).map((m) => m.key);
    const sports = all.filter((m) => m.is_sport).map((m) => m.key);
    expect([...on, ...off].sort()).toEqual([...sports].sort());
    expect(on.filter((k) => off.includes(k))).toEqual([]);
  });
});

/**
 * The on-and-off PAIR, and why a screen needs both predicates.
 *
 * `moduleOffWithCatalog` answers "is there a disabled discipline with this
 * catalog", which is not the same as "should I offer to enable one". With two
 * technique disciplines — one on, one off — it correctly returns the off one,
 * and a screen that renders a prompt from that alone would print "Judo is
 * turned off / turn it on to see the belt roadmaps" directly above the
 * roadmaps it claims are missing.
 *
 * Impossible with today's single-technique registry, which is exactly why it is
 * pinned here: the predicate matches on the CAPABILITY precisely so a second
 * technique discipline can arrive server-side without an app change, and the
 * screen-level guard would then be the only thing standing between an athlete
 * and a self-contradicting screen. Raised in review.
 */
describe('an on-and-off pair', () => {
  const judoOff = {
    ...bjjOn, key: 'judo', label: 'Judo', enabled: false,
  };

  it('still reports the disabled one', () => {
    expect(moduleOffWithCatalog([bjjOn, judoOff], 'techniques')?.key).toBe('judo');
  });

  // The composite a screen must use: offer only when NOTHING with that catalog
  // is enabled. Both halves, or the prompt contradicts the content beside it.
  it('is not on its own a reason to prompt', () => {
    const on = [bjjOn, judoOff].find((m) => m.enabled && m.capabilities.catalog === 'techniques');
    const off = moduleOffWithCatalog([bjjOn, judoOff], 'techniques');
    expect(off).toBeDefined();
    expect(on).toBeDefined();
    // The guard the screens apply.
    expect(on === undefined && off !== undefined).toBe(false);
  });
});


/**
 * The food log, and the surface the first audit missed.
 *
 * Today's Fuel card is gated on `hasFoodLog` and vanished silently with
 * nutrition off — and it escaped the audit table because it fell between two
 * rows that each looked like they covered it: one about the tab BAR, one about
 * a disabled SPORT, which nutrition is not. Same three states as everything
 * else here.
 */
describe('moduleOffWithFoodLog', () => {
  const nutritionOn = mod({
    key: 'nutrition', label: 'Nutrition', is_sport: false,
    capabilities: { has_food_log: true } as Module['capabilities'],
  });
  const nutritionIsOff = { ...nutritionOn, enabled: false };

  it('finds the food-log module when it is turned off', () => {
    expect(moduleOffWithFoodLog([strength, nutritionIsOff])?.key).toBe('nutrition');
  });

  it('returns nothing when it is enabled', () => {
    expect(moduleOffWithFoodLog([strength, nutritionOn])).toBeUndefined();
  });

  // The third state: a deployment with no food log at all must not be offered
  // one.
  it('returns nothing when this server has no food log', () => {
    expect(moduleOffWithFoodLog([strength])).toBeUndefined();
  });

  // Matched on the CAPABILITY, never on `key === 'nutrition'` — the pattern
  // this codebase bans, and the tab layout's own comment says so.
  it('matches on the capability rather than the key', () => {
    const fuel = { ...nutritionIsOff, key: 'fuel', label: 'Fuel' };
    expect(moduleOffWithFoodLog([fuel])?.key).toBe('fuel');
  });

  // **This one exists because its absence let a mutation live.** Dropping the
  // `has_food_log` half of the predicate — leaving a bare `!m.enabled` —
  // passed all fifteen other tests, because in every one of them the only
  // disabled module WAS the food-log module. Every vector was valid and none
  // could tell the two apart.
  //
  // A guard is only exercised by the input it is meant to reject: a disabled
  // module that does not carry the food log. Without this, the Fuel slot would
  // offer to "turn Nutrition on" on any account with Running switched off.
  it('ignores a disabled module that does not carry the food log', () => {
    const runningOff = mod({ key: 'running', label: 'Running', enabled: false });
    expect(moduleOffWithFoodLog([strength, runningOff])).toBeUndefined();
  });

  // Exactly one of the two must answer, or the Fuel slot renders both the card
  // and its own placeholder, or neither.
  it('is the exact complement of hasFoodLog', () => {
    for (const set of [[strength, nutritionOn], [strength, nutritionIsOff], [strength]]) {
      const on = hasFoodLog(set);
      const off = moduleOffWithFoodLog(set) !== undefined;
      expect(on && off).toBe(false);
    }
    // And when the module exists, one of them is always true.
    expect(hasFoodLog([nutritionOn]) || moduleOffWithFoodLog([nutritionOn]) !== undefined).toBe(true);
    expect(hasFoodLog([nutritionIsOff]) || moduleOffWithFoodLog([nutritionIsOff]) !== undefined).toBe(true);
  });
});

/**
 * Reachability — N61's largest instance, and its answer.
 *
 * Food and Goals used to disappear outright from the tab bar when nutrition was
 * off: two of five tabs, 40% of the primary navigation, gone with nothing
 * saying why. #370's finding on the BJJ surfaces was that the DESTINATIONS were
 * never the problem — they already explain themselves — and that nothing LINKED
 * to them while the module was off. A tab is that link, so the tab stayed and
 * the screen explained.
 *
 * Which leaves the third state as the only remaining reason to hide a link: a
 * deployment with no food-log module at all, where there is nothing to turn on
 * and an offer to turn it on would promise a feature the server does not have.
 *
 * **N176 retired the caller, not the rule.** Food and Goals left the bar for
 * Train and Progress, so this predicate has no production caller today — see
 * its docstring in `modules.ts`, and the note below where `tabHidden`'s tests
 * used to be. The three predicates are still one partition, which is what the
 * last test here holds together and what N180 will need intact.
 *
 * **Every vector below is chosen to distinguish a correct implementation from a
 * broken one, not merely to exercise the correct one.** #468's guard survived
 * its own mutation test because every vector it had contained exactly one
 * disabled module and that module was always the food-log module — so a bare
 * `!enabled` was indistinguishable from the real predicate. The two that matter
 * here are the mirror of that miss: a module that carries the food log and is
 * OFF (must not hide), and a disabled module that does NOT carry it (must not
 * un-hide).
 */
describe('serverHasFoodLog', () => {
  const nutritionOn = mod({
    key: 'nutrition', label: 'Nutrition', is_sport: false,
    capabilities: { has_food_log: true } as Module['capabilities'],
  });
  const nutritionIsOff = { ...nutritionOn, enabled: false };
  const runningOff = mod({ key: 'running', label: 'Running', enabled: false });

  it('is true when the food log is on', () => {
    expect(serverHasFoodLog([strength, nutritionOn])).toBe(true);
  });

  // **The state the whole ticket is about.** `hasFoodLog` is false here, which
  // is what used to erase the two tabs; this predicate is deliberately not that
  // one, and a mutation collapsing it back into `hasFoodLog` dies on this line.
  it('is STILL true when the food log exists but is turned off', () => {
    expect(hasFoodLog([strength, nutritionIsOff])).toBe(false);
    expect(serverHasFoodLog([strength, nutritionIsOff])).toBe(true);
  });

  // The third state: nothing to turn on, so nothing to link to.
  it('is false when this deployment has no food log at all', () => {
    expect(serverHasFoodLog([strength])).toBe(false);
  });

  // **The vector that kills the mutation #468 warned about.** Drop the
  // capability half and this becomes "any disabled module exists", which is
  // true here — putting the Food and Goals tabs in front of an athlete on a
  // deployment with no food log, merely because they turned Running off.
  it('is false for a disabled module that does not carry the food log', () => {
    expect(serverHasFoodLog([strength, runningOff])).toBe(false);
  });

  // Matched on the CAPABILITY, never on `key === 'nutrition'` — the pattern
  // this codebase bans, and the one the tab layout's own comment calls out.
  it('matches on the capability rather than the key', () => {
    expect(serverHasFoodLog([{ ...nutritionIsOff, key: 'fuel', label: 'Fuel' }])).toBe(true);
  });

  // The three predicates are one partition and must stay one: `hasFoodLog` and
  // `moduleOffWithFoodLog` are the two halves, and this is their union. Written
  // independently in `modules.ts` — as a single `some` rather than as that
  // disjunction — so this is a real check rather than a restatement of it.
  it('is exactly the union of hasFoodLog and moduleOffWithFoodLog', () => {
    const sets = [
      [strength, nutritionOn],
      [strength, nutritionIsOff],
      [strength],
      [strength, runningOff],
      [nutritionOn, { ...nutritionIsOff, key: 'fuel' }],
      [],
    ];
    for (const set of sets) {
      const union = hasFoodLog(set) || moduleOffWithFoodLog(set) !== undefined;
      expect(serverHasFoodLog(set)).toBe(union);
    }
  });
});

/*
 * `tabHidden` used to be tested here and no longer exists — N176.
 *
 * It answered "should this tab's button be left out of the bar", and its whole
 * remaining job was the third state: on a deployment with **no food-log module
 * at all** the Food and Goals buttons were dropped, because a tab offering to
 * turn something on promises a feature the server does not have. Every other
 * case answered "keep the tab", which was N61's fix.
 *
 * The bar no longer holds those two tabs in any state, so there is nothing left
 * for the predicate to decide. What replaced it is in two files:
 *
 *   - `lib/__tests__/tabBar.test.ts` — which five tabs, in what order, and that
 *     Food and Goals are deliberately off the bar rather than missing.
 *   - `app/__tests__/tabLayout.test.tsx` — that the bar is IDENTICAL for an
 *     unread module list, a full one and an all-disabled one. That is the same
 *     guarantee the tests above gave, stated as a property instead of a table,
 *     and it is what goes red if a later ticket makes a tab conditional again.
 *
 * The three-state predicates themselves are untouched and still tested above:
 * `serverHasFoodLog` is still the right question for anything that decides
 * whether a food surface should be REACHABLE, which is what N180 (#585) faces
 * when it re-homes nutrition.
 */

/**
 * What a food-log SCREEN asks — the same question in two places, so one
 * function.
 */
describe('foodLogGate', () => {
  const nutritionOn = mod({
    key: 'nutrition', label: 'Nutrition', is_sport: false,
    capabilities: { has_food_log: true } as Module['capabilities'],
  });
  const nutritionIsOff = { ...nutritionOn, enabled: false };
  const runningOff = mod({ key: 'running', label: 'Running', enabled: false });

  it('draws the off-state, naming the module, when the food log is off', () => {
    const g = foodLogGate([strength, nutritionIsOff], true);
    expect(g.disabled).toBe(true);
    expect(g.off?.label).toBe('Nutrition');
  });

  it('draws nothing when the food log is on', () => {
    expect(foodLogGate([strength, nutritionOn], true).disabled).toBe(false);
  });

  // The third state reaches the screen too — the route stays resolvable with
  // the tab hidden — and there it must not name a module, because there is
  // none to name.
  it('draws the off-state with no module to name when the deployment has no food log', () => {
    const g = foodLogGate([strength], true);
    expect(g.disabled).toBe(true);
    expect(g.off).toBeUndefined();
  });

  // The trap vector: Running being off is not the food log being off, and the
  // screen must not offer to turn Running on to get food logging back.
  it('does not name a disabled module that does not carry the food log', () => {
    expect(foodLogGate([strength, runningOff, nutritionOn], true).off).toBeUndefined();
  });

  // **`ready` is the half most likely to be dropped as noise.** Without it an
  // unread module list — empty, on every cold start — reads as "turned off",
  // and the screen says so in words for a frame or two. An unanswered question
  // is not a no; the same rule as the third state, one axis over.
  it('says nothing at all until the module set has been read', () => {
    expect(foodLogGate([], false).disabled).toBe(false);
    expect(foodLogGate([strength, nutritionIsOff], false).disabled).toBe(false);
  });
});
