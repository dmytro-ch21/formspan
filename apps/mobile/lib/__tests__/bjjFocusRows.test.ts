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

  it('ignores untagged rows, which belong to the category grid', () => {
    // Pulling them in here would put the same event in two controls again,
    // which is the whole thing that separation exists to stop.
    const tags: Tag[] = [
      { category: 'sweep', event: 'scored', position: 'Guard', count: 3 },
    ];
    expect(focusRows([], tags)).toEqual([]);
  });

  /*
    A technique DRILLED today gets a row — the reversal, and the point of N31.

    This test previously asserted the opposite: "a technique that was only
    drilled has no live outcome to edit; it appears if it is in focus, not
    because it was drilled." True, and it was the bug. The wizard asks what you
    drilled on one screen and then, on the next, offered no way to say it
    landed — unless the technique happened to be on the focus list. An athlete
    with no focus list could attribute nothing at all, which silently made the
    technique funnel drilled-only.

    The old property is retired deliberately rather than left passing beside the
    new one, because the two cannot both hold.
  */
  it('gives a technique drilled this session a live row', () => {
    const tags: Tag[] = [
      { category: 'submission', event: 'drilled', position: 'Mount', technique_id: 'americana', count: 6 },
    ];
    const rows = focusRows([], tags);
    expect(rows).toHaveLength(1);
    // Category and position are INHERITED from the drilled tag rather than
    // recomputed — `bumpTechniqueOutcome` relies on that so the live row it
    // writes joins the drilled one in the funnel.
    expect(rows[0]).toEqual({
      technique_id: 'americana',
      category: 'submission',
      position: 'Mount',
      name: 'americana',
    });
  });

  it('still leaves `conceded` out', () => {
    // The category grid's "Them" column, which carries no technique. The
    // per-technique defensive event is `defended`, which the grid does offer —
    // a conceded row would draw counters no tap could fill.
    const tags: Tag[] = [
      { category: 'sweep', event: 'conceded', position: 'Guard', technique_id: 'scissor-sweep', count: 2 },
    ];
    expect(focusRows([], tags)).toEqual([]);
  });

  it('names a tag-derived row from the library when it can', () => {
    const tags: Tag[] = [
      { category: 'submission', event: 'drilled', position: 'Mount', technique_id: 'americana', count: 1 },
    ];
    const rows = focusRows([], tags, new Map([['americana', 'Americana from Mount']]));
    expect(rows[0].name).toBe('Americana from Mount');
  });

  it('falls back to the id when the library is not loaded', () => {
    // The offline gym case: `fetchTechniques` fails, the map is empty, and a
    // readable slug beats a blank label. The counters work either way.
    const tags: Tag[] = [
      { category: 'submission', event: 'drilled', position: 'Mount', technique_id: 'americana', count: 1 },
    ];
    expect(focusRows([], tags, new Map())[0].name).toBe('americana');
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

  it('still ignores conceded, which has its own surface', () => {
    // `conceded` is the category grid's right-hand column and carries no
    // technique. `drilled` used to be asserted here too and is now the
    // opposite — see "gives a technique drilled this session a live row". Two
    // tests pinned that exclusion and only one of them was obvious; this is
    // the second, and it is why the reversal needed a full run rather than a
    // single targeted test.
    expect(focusRows([], [{ ...stopped, event: 'conceded' }])).toEqual([]);
  });
});
