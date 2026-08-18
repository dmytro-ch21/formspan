import { ladderRows } from '@/lib/roundMapLadder';
import { bandOf, type RoundMap, type RoundMapNode } from '@/lib/positions';

const node = (id: string, tier: number): RoundMapNode => ({
  id,
  label: id,
  position_id: id,
  position: id,
  tier,
  note: 'n',
});

const map = (nodes: RoundMapNode[], bands = BANDS): RoundMap => ({
  title: 't',
  intro: 'i',
  bands,
  nodes,
  edges: [],
});

const BANDS = [
  { min_tier: 1, label: 'ahead', note: '' },
  { min_tier: 0, label: 'even', note: '' },
  { min_tier: -99, label: 'behind', note: '' },
];

describe('bandOf', () => {
  it('takes the first band a tier clears, not the last', () => {
    // The load-bearing rule: bands are ordered top down and exhaustive
    // downward, so a tier of 4 is "ahead" even though it also clears both
    // bands below it.
    expect(bandOf(BANDS, 4)?.label).toBe('ahead');
    expect(bandOf(BANDS, 1)?.label).toBe('ahead');
    expect(bandOf(BANDS, 0)?.label).toBe('even');
    expect(bandOf(BANDS, -3)?.label).toBe('behind');
  });

  it('returns null rather than guessing when a tier clears nothing', () => {
    expect(bandOf([{ min_tier: 0, label: 'x', note: '' }], -1)).toBeNull();
  });
});

describe('ladderRows', () => {
  it('orders every position best first', () => {
    const rows = ladderRows(map([node('low', -2), node('top', 5), node('mid', 0)]));
    expect(rows.map((r) => r.node.id)).toEqual(['top', 'mid', 'low']);
  });

  it('opens each band once, on its first node', () => {
    const rows = ladderRows(
      map([node('a', 5), node('b', 3), node('c', 0), node('d', 0), node('e', -2)]),
    );
    expect(rows.map((r) => r.band?.label ?? null)).toEqual([
      'ahead',
      null,
      'even',
      null,
      'behind',
    ]);
  });

  it('keeps a node whose tier falls under every band', () => {
    // The server refuses to serve this, so it can only arrive from a future
    // API. Dropping the row would take a position off the map with nothing
    // reporting it.
    const rows = ladderRows(
      map([node('a', 5), node('orphan', -500)], [{ min_tier: 0, label: 'only', note: '' }]),
    );
    expect(rows.map((r) => r.node.id)).toContain('orphan');
    expect(rows.find((r) => r.node.id === 'orphan')?.band).toBeNull();
  });

  it('does not mutate the map it was given', () => {
    // It sorts, and Array.prototype.sort is in place — sorting `map.nodes`
    // directly would reorder the cached document every screen shares.
    const nodes = [node('low', 0), node('top', 5)];
    const m = map(nodes);
    ladderRows(m);
    expect(m.nodes.map((n) => n.id)).toEqual(['low', 'top']);
  });
});
