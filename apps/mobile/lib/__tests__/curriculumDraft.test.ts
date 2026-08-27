import {
  draftToWrite,
  itemDraftsOf,
  moveAt,
  movePhase,
  phaseDraftsOf,
  removePhaseAt,
  techniqueMetaOf,
  validateDraft,
  type ItemDraft,
  type PhaseDraft,
} from '@/lib/curriculumDraft';
import type { Curriculum } from '@/lib/curriculum';

/**
 * N83's builder logic — the phase/item remapping that is exactly where the
 * WEB builder's own doc comment says its blocking findings lived (a phase
 * removed without remapping the items pointing at it), pulled out of the
 * component the same way `curriculumRow.ts` pulls the roadmap viewer's
 * mapping logic out of its screen, and for the identical reason: none of this
 * is reachable from a component test that only renders the screen and reads
 * text off it.
 *
 * ## Mutation record
 *
 * Measured against `lib/curriculumDraft.ts`, each applied and reverted.
 *
 * | Mutation                                                    | Result |
 * | ------------------------------------------------------------ | ------ |
 * | `removePhaseAt`: drop the `phase === idx → null` branch      | 1 red  |
 * | `removePhaseAt`: shift branch stops decrementing `phase`      | 1 red  |
 * | `removePhaseAt`: keep the removed phase in the array          | 1 red  |
 * | `movePhase`: drop the bounds check (`to < 0                   |        |
 * |   \|\| to >= phases.length`)                                  | 1 red  |
 * | `movePhase`: swap phases but not the items pointing at them   | 1 red  |
 * | `moveAt`: drop the upper bounds check                         | 1 red  |
 * | `moveAt`: `idx + delta` → `idx - delta`                       | 1 red  |
 * | `validateDraft`: drop the empty-name check                    | 1 red  |
 * | `validateDraft`: drop the concept-title check                 | 1 red  |
 * | `validateDraft`: drop the phase-title check                   | 1 red  |
 * | `draftToWrite`: send `phases: []` unconditionally              | 1 red  |
 * | `draftToWrite`: `belt === '' ? null` → always the raw string  | 2 red  |
 * | `draftToWrite`: leak `_key` onto the wire item                | 1 red  |
 *
 * Every row above was applied against the real file and reverted; none is
 * hypothetical. One originally-planned mutation (`removePhaseAt`'s
 * `phase > idx` → `phase >= idx`) is not listed: the equality case is already
 * consumed by the branch above it, so the two are equivalent code at that
 * line and the mutation proved nothing — exactly the "apparatus that cannot
 * fail" trap CLAUDE.md's mutation-testing section warns about. The row that
 * replaced it (dropping the decrement) is the mutation that actually matters.
 */

function phase(over: Partial<PhaseDraft> = {}): PhaseDraft {
  return { _key: 'p', title: 'Phase', description: '', ...over };
}

function item(over: Partial<ItemDraft> = {}): ItemDraft {
  return { _key: 'i', technique_id: 't1', notes: '', ...over };
}

describe('removePhaseAt', () => {
  it('unphases items that pointed at the removed phase, rather than dropping them', () => {
    const phases = [phase({ _key: 'a' }), phase({ _key: 'b' })];
    const items = [item({ _key: 'i1', phase: 0 }), item({ _key: 'i2', phase: 1 })];
    const result = removePhaseAt(phases, items, 0);
    expect(result.phases.map((p) => p._key)).toEqual(['b']);
    expect(result.items).toEqual([
      expect.objectContaining({ _key: 'i1', phase: null }),
      expect.objectContaining({ _key: 'i2', phase: 0 }),
    ]);
  });

  it('leaves items pointing at an earlier phase untouched', () => {
    const phases = [phase({ _key: 'a' }), phase({ _key: 'b' }), phase({ _key: 'c' })];
    const items = [item({ phase: 0 })];
    const result = removePhaseAt(phases, items, 2);
    expect(result.items[0].phase).toBe(0);
  });

  it('leaves unphased items unphased', () => {
    const phases = [phase()];
    const items = [item({ phase: null })];
    const result = removePhaseAt(phases, items, 0);
    expect(result.items[0].phase).toBeNull();
  });
});

describe('movePhase', () => {
  it('swaps two phases and remaps the items pointing at either one', () => {
    const phases = [phase({ _key: 'a', title: 'A' }), phase({ _key: 'b', title: 'B' })];
    const items = [item({ _key: 'i1', phase: 0 }), item({ _key: 'i2', phase: 1 })];
    const result = movePhase(phases, items, 0, 1);
    expect(result.phases.map((p) => p._key)).toEqual(['b', 'a']);
    expect(result.items).toEqual([
      expect.objectContaining({ _key: 'i1', phase: 1 }),
      expect.objectContaining({ _key: 'i2', phase: 0 }),
    ]);
  });

  it('is a no-op past either end', () => {
    const phases = [phase()];
    const items = [item({ phase: 0 })];
    expect(movePhase(phases, items, 0, -1)).toEqual({ phases, items });
    expect(movePhase(phases, items, 0, 1)).toEqual({ phases, items });
  });

  it('leaves an item pointing at neither swapped phase alone', () => {
    const phases = [phase({ _key: 'a' }), phase({ _key: 'b' }), phase({ _key: 'c' })];
    const items = [item({ phase: 2 })];
    const result = movePhase(phases, items, 0, 1);
    expect(result.items[0].phase).toBe(2);
  });
});

describe('moveAt', () => {
  it('swaps neighbours', () => {
    expect(moveAt(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveAt(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op past either end, and returns the SAME array reference', () => {
    const list = ['a', 'b'];
    expect(moveAt(list, 0, -1)).toBe(list);
    expect(moveAt(list, 1, 1)).toBe(list);
  });
});

describe('validateDraft', () => {
  it('requires a name', () => {
    expect(validateDraft('', [], [])).toMatch(/name/i);
    expect(validateDraft('   ', [], [])).toMatch(/name/i);
    expect(validateDraft('Guard passing', [], [])).toBeNull();
  });

  it('requires every concept to have a title', () => {
    const items = [item({ kind: 'concept', title: '' })];
    expect(validateDraft('X', [], items)).toMatch(/concept/i);
    expect(validateDraft('X', [], [item({ kind: 'concept', title: 'Posture' })])).toBeNull();
  });

  it('does not demand a title from a technique item', () => {
    const items = [item({ technique_id: 't1' })];
    expect(validateDraft('X', [], items)).toBeNull();
  });

  it('requires every phase to have a title', () => {
    const phases = [phase({ title: '' })];
    expect(validateDraft('X', phases, [])).toMatch(/phase/i);
    expect(validateDraft('X', [phase({ title: 'Foundations' })], [])).toBeNull();
  });
});

describe('draftToWrite', () => {
  it('trims name and description, strips local keys, and keeps items', () => {
    const write = draftToWrite({
      name: '  Guard passing  ',
      description: '  for winter  ',
      belt: '',
      visibility: 'private',
      phases: [],
      items: [item({ _key: 'strip-me', technique_id: 't1' })],
    });
    expect(write.name).toBe('Guard passing');
    expect(write.description).toBe('for winter');
    expect(write.belt).toBeNull();
    expect(write.items).toEqual([{ technique_id: 't1', notes: '', title: undefined }]);
    expect((write.items?.[0] as Record<string, unknown>)._key).toBeUndefined();
  });

  it('omits phases entirely when there are none — never sends []', () => {
    const write = draftToWrite({
      name: 'X', description: '', belt: '', visibility: 'private', phases: [], items: [],
    });
    expect('phases' in write).toBe(false);
  });

  it('sends phases, trimmed, only when there is at least one', () => {
    const write = draftToWrite({
      name: 'X', description: '', belt: '', visibility: 'private',
      phases: [phase({ title: '  Foundations  ', description: '  the basics  ' })],
      items: [],
    });
    expect(write.phases).toEqual([{ title: 'Foundations', description: 'the basics' }]);
  });

  it('sends a non-empty belt as-is, and an empty one as null', () => {
    const base = { name: 'X', description: '', visibility: 'private' as const, phases: [], items: [] };
    expect(draftToWrite({ ...base, belt: 'blue' }).belt).toBe('blue');
    expect(draftToWrite({ ...base, belt: '' }).belt).toBeNull();
  });

  it('sends an empty concept title as undefined, not an empty string', () => {
    const write = draftToWrite({
      name: 'X', description: '', belt: '', visibility: 'private', phases: [],
      items: [item({ kind: 'concept', technique_id: undefined, title: '   ' })],
    });
    expect(write.items?.[0].title).toBeUndefined();
  });
});

function curriculum(over: Partial<Curriculum> = {}): Curriculum {
  return {
    id: 'c1',
    editable: true,
    name: 'Guard passing',
    description: '',
    belt: null,
    track: null,
    visibility: 'private',
    enrolled: false,
    started_on: null,
    item_count: 0,
    countable_items: 0,
    mastered_items: 0,
    ...over,
  };
}

describe('seeding a draft from an existing curriculum', () => {
  it('phaseDraftsOf and itemDraftsOf are empty for a curriculum with neither', () => {
    expect(phaseDraftsOf(curriculum())).toEqual([]);
    expect(itemDraftsOf(curriculum())).toEqual([]);
  });

  it('flattens criteria onto the item draft, matching the wire shape the builder edits', () => {
    const c = curriculum({
      items: [
        {
          kind: 'technique',
          technique_id: 't1',
          name: 'Knee cut',
          position: 'Half guard top',
          category: 'pass',
          order: 0,
          phase: null,
          notes: '',
          criteria: {
            target_scored: 25,
            target_defended: null,
            target_sessions: 12,
            min_hit_rate: 0.35,
            target_drilled_sessions: null,
          },
          progress: null,
        },
      ],
    });
    const [draft] = itemDraftsOf(c);
    expect(draft.target_scored).toBe(25);
    expect(draft.target_sessions).toBe(12);
    expect(draft.min_hit_rate).toBe(0.35);
    expect(draft.target_defended).toBeNull();
  });

  it('reads technique display metadata off the existing items', () => {
    const c = curriculum({
      items: [
        {
          kind: 'technique', technique_id: 't1', name: 'Knee cut', position: 'Half guard top',
          category: 'pass', order: 0, phase: null, notes: '', criteria: null, progress: null,
        },
      ],
    });
    expect(techniqueMetaOf(c)).toEqual({ t1: { name: 'Knee cut', position: 'Half guard top' } });
  });

  it('does not carry a concept item into the technique meta map', () => {
    const c = curriculum({
      items: [
        {
          kind: 'concept', title: 'Posture', name: '', position: '', category: '', order: 0,
          phase: null, notes: '', criteria: null, progress: null,
        },
      ],
    });
    expect(techniqueMetaOf(c)).toEqual({});
  });
});
