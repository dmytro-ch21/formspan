import { focusRows, type Focus } from '../bjjFocus';
import { bumpTechniqueOutcome, type Tag } from '../bjjSession';

const f = (id: string, name: string, cat: string, pos: string): Focus => ({
  technique_id: id, name, category: cat, position: pos, started_on: '2026-07-01',
});

it('scratch', () => {
  console.log('unlisted family ->', JSON.stringify(focusRows([f('a','A','Submission','50/50 - Bottom')], [])));
  console.log('unmapped category ->', JSON.stringify(focusRows([f('b','B','Transition','Guard - Bottom')], [])));
  console.log('empty id ->', JSON.stringify(focusRows([f('','Ghost','Submission','Guard')], [])));
  let tags: Tag[] = [{ category:'sweep', event:'scored', position:'Guard', technique_id:'scissor', count:1 }];
  console.log('orphan present ->', JSON.stringify(focusRows([], tags)));
  tags = bumpTechniqueOutcome(tags, { technique_id:'scissor', category:'sweep', position:'Guard' }, 'scored', -1);
  console.log('after undo ->', JSON.stringify(focusRows([], tags)), JSON.stringify(tags));
  console.log('order ->', focusRows([f('a','A','Submission','Guard')], [
    { category:'sweep', event:'scored', position:'Guard', technique_id:'z', count:1 },
    { category:'pass', event:'attempted', position:'Mount', technique_id:'m', count:1 },
  ]).map(r => r.technique_id).join(','));
  try { (focusRows as any)(undefined, []); } catch (e) { console.log('null payload ->', (e as Error).message); }
});
