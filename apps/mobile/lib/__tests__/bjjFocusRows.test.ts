import { focusRows, type Focus } from '../bjjFocus';
import type { Tag } from '../bjjSession';

/**
 * The rows the live step shows for named techniques.
 *
 * This is the seam that collapses the redundancy: a focus technique's row is
 * the ONE place its live outcome is recorded, replacing the tried/landed
 * counters that used to sit on the drilled step. So the set it returns has to
 * cover everything the session can hold, or evidence becomes uneditable.
 */

const focus = (technique_id: string, name: string, category: string, position: string): Focus => ({
  technique_id,
  name,
  category,
  position,
  started_on: '2026-07-01',
});

describe('focusRows', () => {
  it('translates the library vocabulary into the tag vocabulary', () => {
    // A focus row's tags have to be joinable with a drilled row's for the same
    // technique, and the drilled step applies exactly this translation. Two
    // spellings of one position would split a technique's evidence in half
    // with no error anywhere.
    const [row] = focusRows([focus('armbar', 'Armbar', 'Submission', 'Half Guard - Bottom')], []);
    expect(row).toEqual({
      technique_id: 'armbar',
      category: 'submission',
      position: 'Half Guard',
      name: 'Armbar',
    });
  });

  it('includes a technique with evidence in this session but no longer in focus', () => {
    // THE property. Drop a technique from the list on web after logging
    // against it and, without this, its rows stay in the session with no
    // control able to edit them — saved, synced, invisible. That is precisely
    // how the old drilled-step counters stranded rows when a chip was removed,
    // and repeating it one screen along would defeat the point of the collapse.
    const orphan: Tag = {
      category: 'sweep',
      event: 'scored',
      position: 'Guard',
      technique_id: 'scissor-sweep',
      count: 2,
    };
    const rows = focusRows([focus('armbar', 'Armbar', 'Submission', 'Guard - Bottom')], [orphan]);
    expect(rows.map((r) => r.technique_id).sort()).toEqual(['armbar', 'scissor-sweep']);
    // and it keeps the tag's own category/position, so incrementing it lands
    // on the same row rather than forking a second one
    const recovered = rows.find((r) => r.technique_id === 'scissor-sweep');
    expect(recovered).toMatchObject({ category: 'sweep', position: 'Guard' });
  });

  it('does not duplicate a technique that is both in focus and already recorded', () => {
    const rows = focusRows(
      [focus('armbar', 'Armbar from Guard', 'Submission', 'Guard - Bottom')],
      [{ category: 'submission', event: 'scored', position: 'Guard', technique_id: 'armbar', count: 1 }],
    );
    expect(rows).toHaveLength(1);
    // Focus wins, because it carries the library's name where a tag has only
    // an id.
    expect(rows[0].name).toBe('Armbar from Guard');
  });

  it('ignores untagged rows and drilled-only techniques', () => {
    // Untagged rows belong to the category grid — pulling them in here would
    // put the same event in two controls again, which is the whole thing this
    // change exists to stop. And a technique that was only drilled has no live
    // outcome to edit; it appears if it is in focus, not because it was
    // drilled.
    const tags: Tag[] = [
      { category: 'sweep', event: 'scored', position: 'Guard', count: 3 },
      { category: 'submission', event: 'drilled', position: 'Mount', technique_id: 'americana', count: 1 },
    ];
    expect(focusRows([], tags)).toEqual([]);
  });

  it('returns [] for an athlete with no focus and no evidence', () => {
    expect(focusRows([], [])).toEqual([]);
  });
});
