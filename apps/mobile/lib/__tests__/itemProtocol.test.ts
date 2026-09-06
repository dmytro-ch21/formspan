import { protocolIsConfigured, type ItemProtocol } from '../workouts';

/**
 * N494/#864 (phase 2 of #753) — the pure logic behind the mobile Protocol
 * editor's own guard: an object with every field empty must read exactly
 * like no protocol at all, since that is what decides whether
 * `apps/mobile/app/workout/[id].tsx`'s `ProtocolEditor` sends `undefined`
 * (clearing a stored protocol) or a real object on save.
 */
describe('protocolIsConfigured', () => {
  it('is false for undefined and null', () => {
    expect(protocolIsConfigured(undefined)).toBe(false);
    expect(protocolIsConfigured(null)).toBe(false);
  });

  it('is false for an object with every field empty', () => {
    const empty: ItemProtocol = {};
    expect(protocolIsConfigured(empty)).toBe(false);
  });

  it('is false for an object whose only field is an empty sets array', () => {
    expect(protocolIsConfigured({ sets: [] })).toBe(false);
  });

  it.each<[string, ItemProtocol]>([
    ['progression_strategy', { progression_strategy: 'double_progression' }],
    ['rep_range_min', { rep_range_min: 10 }],
    ['rep_range_max', { rep_range_max: 15 }],
    ['target_sets', { target_sets: 3 }],
    ['target_rir', { target_rir: 2 }],
    ['target_rpe', { target_rpe: 8 }],
    ['rep_count_mode', { rep_count_mode: 'per_side' }],
    ['equipment_increment', { equipment_increment: 2.5 }],
    ['exercise_profile', { exercise_profile: 'isolation_accessory' }],
    ['a non-empty sets array', { sets: [{ role: 'working' }] }],
  ])('is true when %s is set', (_label, protocol) => {
    expect(protocolIsConfigured(protocol)).toBe(true);
  });

  // Mutation check: a guard that always returns the same answer regardless
  // of input would pass every case above trivially if they only ever
  // checked "true". This asserts both directions actually branch.
  it('distinguishes configured from unconfigured, not just returns a constant', () => {
    const configured = protocolIsConfigured({ target_sets: 3 });
    const unconfigured = protocolIsConfigured({});
    expect(configured).not.toBe(unconfigured);
  });
});
