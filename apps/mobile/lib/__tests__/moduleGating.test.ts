import { moduleOffWithCatalog, offSports, enabledSports, type Module } from '../modules';

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
