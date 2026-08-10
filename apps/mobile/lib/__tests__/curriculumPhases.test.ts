import type { CurriculumItem, CurriculumPhase } from '../curriculum';
import { groupByPhase } from '../curriculumPhases';

function item(over: Partial<CurriculumItem>): CurriculumItem {
  return {
    kind: 'technique',
    technique_id: 'x',
    name: 'X',
    position: '',
    category: '',
    order: 0,
    phase: null,
    notes: '',
    criteria: null,
    progress: null,
    ...over,
  };
}

const phases: CurriculumPhase[] = [
  { order: 0, title: 'Survive', description: '' },
  { order: 1, title: 'Attack', description: '' },
];

describe('groupByPhase', () => {
  it('groups items under their phases, in phase order', () => {
    const groups = groupByPhase(phases, [
      item({ technique_id: 'b', phase: 1 }),
      item({ technique_id: 'a', phase: 0 }),
    ]);
    expect(groups.map((g) => g.phase?.title)).toEqual(['Survive', 'Attack']);
    expect(groups[0].items.map((i) => i.technique_id)).toEqual(['a']);
    expect(groups[1].items.map((i) => i.technique_id)).toEqual(['b']);
  });

  it('puts unphased items first, so a mixed curriculum cannot bury them', () => {
    const groups = groupByPhase(phases, [
      item({ technique_id: 'assigned', phase: 0 }),
      item({ technique_id: 'forgotten', phase: null }),
    ]);
    expect(groups[0].phase).toBeNull();
    expect(groups[0].items.map((i) => i.technique_id)).toEqual(['forgotten']);
  });

  it('renders a flat curriculum as one unphased group and nothing else', () => {
    const groups = groupByPhase([], [item({ technique_id: 'a' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].phase).toBeNull();
  });

  it('keeps empty phases — authoring in progress rather than nothing', () => {
    const groups = groupByPhase(phases, [item({ technique_id: 'a', phase: 0 })]);
    expect(groups.map((g) => g.items.length)).toEqual([1, 0]);
  });

  it('falls back to unphased for a dangling index instead of dropping the item', () => {
    const groups = groupByPhase(phases, [item({ technique_id: 'a', phase: 7 })]);
    expect(groups.flatMap((g) => g.items).map((i) => i.technique_id)).toContain('a');
    expect(groups[0].phase).toBeNull();
  });
});
