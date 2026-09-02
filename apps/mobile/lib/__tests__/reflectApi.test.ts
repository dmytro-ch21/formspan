import {
  describeNotice,
  draftToDetail,
  fieldLabel,
  tagOf,
  uncertainCountFlags,
  type Draft,
  type DraftTag,
  type Notice,
} from '@/lib/reflectApi';

/**
 * The dictation draft's transforms (N60).
 *
 * The behavioural guard that matters most — that an unresolved phrase is never
 * silently turned into a tag — lives in the screen test beside this one. What
 * is here is the part a screen test would exercise only incidentally: the
 * shape a confirmed draft takes on its way into somebody's training history.
 */

const tag = (over: Partial<DraftTag> = {}): DraftTag => ({
  category: 'sweep',
  event: 'scored',
  position: 'Half Guard',
  technique_id: 'lockdown-sweep',
  count: 2,
  ...over,
});

const draft = (over: Partial<Draft> = {}): Draft => ({
  kind: 'rolling',
  gi: true,
  rounds: 5,
  round_minutes: 5,
  session_rpe: 8,
  note: 'Felt sharp.',
  body_note: '',
  tags: [tag()],
  unresolved: [],
  notices: [],
  empty: false,
  model: 'gpt-5.6-luna',
  ...over,
});

describe('draftToDetail', () => {
  it('carries the session across unchanged', () => {
    const d = draftToDetail(draft(), 'class');
    expect(d.kind).toBe('rolling');
    expect(d.gi).toBe(true);
    expect(d.rounds).toBe(5);
    expect(d.round_minutes).toBe(5);
    expect(d.session_rpe).toBe(8);
    expect(d.note).toBe('Felt sharp.');
    expect(d.tags).toHaveLength(1);
    expect(d.tags[0].technique_id).toBe('lockdown-sweep');
  });

  it('falls back to a kind only when the athlete never said one', () => {
    expect(draftToDetail(draft({ kind: '' }), 'class').kind).toBe('class');
    // ...and never overrides one they did say.
    expect(draftToDetail(draft({ kind: 'drilling' }), 'class').kind).toBe('drilling');
  });

  it('keeps null apart from a value, because "didn’t say" is not "no"', () => {
    // `gi: null` must NOT become false. No-gi is a fact about the session; not
    // saying is a fact about the sentence, and collapsing them puts something
    // in the record nobody stated.
    const d = draftToDetail(draft({ gi: null, rounds: null, session_rpe: null }), 'class');
    expect(d.gi).toBeNull();
    expect(d.rounds).toBeNull();
    expect(d.session_rpe).toBeNull();
  });

  it('drops everything that is about the drafting rather than the training', () => {
    const d = draftToDetail(
      draft({
        notices: [{ field: 'rounds', was: '6', reason: 'not_spoken' }],
        unresolved: [{ phrase: 'armbar', category: 'submission', event: 'scored' }],
      }),
      'class',
    );
    // A logged session is a record of what happened. A model's uncertainty, and
    // a phrase the athlete has not answered yet, are neither.
    expect(Object.keys(d)).not.toContain('notices');
    expect(Object.keys(d)).not.toContain('unresolved');
    expect(Object.keys(d)).not.toContain('model');
  });

  it('NEVER turns an unresolved phrase into a tag', () => {
    // The load-bearing one. The server declined to guess which technique
    // "armbar" is; inventing a tag here would put the guess back and dress it
    // as the athlete's own answer.
    const d = draftToDetail(
      draft({
        tags: [],
        unresolved: [
          { phrase: 'armbar', category: 'submission', event: 'scored' },
          { phrase: 'that shoulder thing', category: 'submission', event: 'conceded' },
        ],
      }),
      'class',
    );
    expect(d.tags).toEqual([]);
  });

  it('leaves academy empty rather than inventing one', () => {
    // Nobody dictates their gym's name, and there is no field for it in the
    // draft. Filling it from silence is the class of guess this feature refuses.
    expect(draftToDetail(draft(), 'class').academy).toBe('');
  });
});

describe('tagOf', () => {
  it('produces exactly the session store’s tag shape', () => {
    expect(tagOf(tag())).toEqual({
      category: 'sweep',
      event: 'scored',
      position: 'Half Guard',
      technique_id: 'lockdown-sweep',
      count: 2,
    });
  });

  it('keeps a null technique id null', () => {
    // A tag can legitimately have no technique — "got swept in half guard"
    // records a real thing. Coercing to '' would make it look like an id.
    expect(tagOf(tag({ technique_id: null })).technique_id).toBeNull();
  });
});

describe('describeNotice', () => {
  const cases: { n: Notice; must: string }[] = [
    { n: { field: 'rounds', was: '6', reason: 'not_spoken' }, must: '6' },
    { n: { field: 'tags[1].technique_id', was: 'flying-omoplata', reason: 'unknown_technique' }, must: 'flying-omoplata' },
    { n: { field: 'session_rpe', was: '12', reason: 'unknown_value' }, must: '12' },
    { n: { field: 'tags[0].count', was: '0', reason: 'count_below_one' }, must: '1' },
    { n: { field: 'tags[0].count', was: '1', reason: 'hedged_count' }, must: '1' },
    { n: { field: 'tags', was: '40', reason: 'too_many_tags' }, must: '40' },
  ];

  it.each(cases)('says something actionable for $n.reason', ({ n, must }) => {
    const s = describeNotice(n);
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain(must);
    // The reason code is contract; the sentence is not. A raw code leaking into
    // the UI means the athlete reads "not_spoken".
    expect(s).not.toContain(n.reason);
  });

  it('still renders a reason this build has never heard of', () => {
    // The server may ship a new code before the app does. Showing nothing at
    // all would hide a change that was made to the athlete's draft.
    const s = describeNotice({ field: 'rounds', was: '9', reason: 'something_new' as never });
    expect(s).toContain('9');
    expect(s.length).toBeGreaterThan(0);
  });

  // N121/#510: a scalar really does go blank on `not_spoken` — `rounds`
  // becomes null. A tag's `count` does NOT: `ResolveDraft` floors it to 1,
  // because there is no null for an int to floor to. The old copy said "is
  // blank" for both, which was simply false for a tag — the stepper right
  // below it was showing a plain "1". Only the message differs here; the
  // screen test covers the stepper itself reading blank instead of "1".
  it('does not claim a tag count is blank when it was floored to 1, not nulled', () => {
    const s = describeNotice({ field: 'tags[2].count', was: '6', reason: 'not_spoken' });
    expect(s).not.toContain('is blank');
    expect(s).toContain('6');
    expect(s).not.toContain(' not_spoken');
  });

  it('still says a scalar is blank on not_spoken — that one really is null', () => {
    const s = describeNotice({ field: 'rounds', was: '6', reason: 'not_spoken' });
    expect(s).toContain('is blank');
  });

  // N121/#510, the gap `ac-verifier` caught in this ticket's first pass: a
  // model correctly reading "a couple of sweeps" as a hedge and leaving
  // `count` at 1 is NOT the same event as one being rejected or malformed —
  // it did nothing wrong, so the copy must not imply that it did.
  it('reads as a range being reported, not a mistake being corrected', () => {
    const s = describeNotice({ field: 'tags[0].count', was: '1', reason: 'hedged_count' });
    expect(s).not.toContain('couldn’t match');
    expect(s).not.toContain('came back as');
    expect(s.toLowerCase()).toMatch(/range|couple|not a number/);
  });
});

describe('uncertainCountFlags', () => {
  it('flags exactly the tags whose count the server floored, not the others', () => {
    const d = draft({
      tags: [tag({ count: 1 }), tag({ count: 5 }), tag({ count: 1 })],
      notices: [
        // Index 1's count of 5 was floored to 1 for a DIFFERENT reason —
        // included to prove the match is on field path, not just "any notice
        // touched this tag".
        { field: 'tags[1].count', was: '5', reason: 'not_spoken' },
      ],
    });
    expect(uncertainCountFlags(d)).toEqual([false, true, false]);
  });

  it('also flags count_below_one — a malformed count is just as unconfirmed', () => {
    const d = draft({
      tags: [tag({ count: 1 })],
      notices: [{ field: 'tags[0].count', was: '0', reason: 'count_below_one' }],
    });
    expect(uncertainCountFlags(d)).toEqual([true]);
  });

  // The path that matters most: a model correctly following the prompt's
  // hedge rule produces `count: 1` with NO `not_spoken`/`count_below_one`
  // notice at all (1 is a completely ordinary count) — `hedged_count` is the
  // only signal this ever happened, and without it a compliant hedge and a
  // genuinely-stated "one" are indistinguishable on the wire.
  it('flags hedged_count — the model behaving correctly on an indefinite quantity', () => {
    const d = draft({
      tags: [tag({ count: 1 })],
      notices: [{ field: 'tags[0].count', was: '1', reason: 'hedged_count' }],
    });
    expect(uncertainCountFlags(d)).toEqual([true]);
  });

  it('ignores a notice on the same tag that is not about count', () => {
    const d = draft({
      tags: [tag({ count: 1 })],
      notices: [{ field: 'tags[0].technique_id', was: 'flying-omoplata', reason: 'unknown_technique' }],
    });
    expect(uncertainCountFlags(d)).toEqual([false]);
  });

  it('returns all-false, not an empty array, for a draft with no notices', () => {
    const d = draft({ tags: [tag(), tag()], notices: [] });
    expect(uncertainCountFlags(d)).toEqual([false, false]);
  });
});

describe('fieldLabel', () => {
  it('reads a tag path as a human phrase', () => {
    expect(fieldLabel('tags[2].count')).toBe('a count');
    expect(fieldLabel('round_minutes')).toBe('round length');
    expect(fieldLabel('session_rpe')).toBe('how hard it was');
  });

  it('degrades an unknown field into words rather than showing snake_case', () => {
    expect(fieldLabel('some_new_field')).toBe('some new field');
  });
});
