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

  it('drops the position when the family list has fallen behind', () => {
    // familyOf returns '' rather than echoing the input, and that is the whole
    // reason this PR moved it into lib/. POSITIONS is a hardcoded copy of a
    // growing set and has fallen behind twice; echoing "50/50 - Bottom"
    // through would write a tag position no filter, heatmap or library chip
    // recognises, where '' is at least an honest "not said".
    //
    // Untested until now, and it survived mutation against the entire suite.
    const [row] = focusRows([focus('fifty-fifty-sweep', 'Sweep', 'Sweep', '50/50 - Bottom')], []);
    expect(row.position).toBe('');
  });

  it('maps a category with no symmetric opposite to control, not to a guess', () => {
    // The six tag categories are the ones with a genuine opposite. "Transition"
    // has none, so it lands in `control` — honest, rather than inventing a
    // seventh or silently filing it as a submission. Also untested until now.
    const [row] = focusRows([focus('berimbolo', 'Berimbolo', 'Transition', 'Guard - Bottom')], []);
    expect(row.category).toBe('control');
  });

  it('ignores a focus entry whose technique_id is empty', () => {
    // The drilled step had an explicit guard for this, with a comment saying
    // why, and it was deleted along with the counters rather than carried
    // over. An empty id renders two counters that read 0 forever and cannot be
    // tapped — bumpTechniqueOutcome returns early on a falsy id — while still
    // announcing themselves to VoiceOver as buttons. Needs server drift; the
    // contract marks the field required.
    expect(focusRows([focus('', 'Nameless', 'Submission', 'Guard - Bottom')], [])).toEqual([]);
  });
});

describe('defensive-only evidence', () => {
  /*
   * THE property again, one event along.
   *
   * A technique whose ONLY evidence is `defended` — "I never went for it, I
   * just kept stopping theirs", which is exactly the athlete the defensive
   * criterion exists for — produced no row at all while this function narrowed
   * to attempted|scored. Three recorded stops were saved, synced, and then
   * invisible and uneditable on reopen.
   *
   * And it did not need anyone to drop a focus technique on web: `LiveStep`
   * swallows a `fetchFocus` failure deliberately, so every offline reflection
   * at a gym takes this path.
   */
  const stopped: Tag = {
    category: 'submission',
    event: 'defended',
    position: 'Guard',
    technique_id: 'armbar-from-guard',
    count: 3,
  };

  it('gives a row to a technique known only from stopping theirs', () => {
    const rows = focusRows([], [stopped]);
    expect(rows.map((r) => r.technique_id)).toEqual(['armbar-from-guard']);
  });

  it('still ignores drilled and conceded, which have their own surfaces', () => {
    // `drilled` is edited on the previous step; `conceded` is the category
    // grid's right-hand column and carries no technique.
    expect(focusRows([], [{ ...stopped, event: 'drilled' }])).toEqual([]);
    expect(focusRows([], [{ ...stopped, event: 'conceded' }])).toEqual([]);
  });
});
