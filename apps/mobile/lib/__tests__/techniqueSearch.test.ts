import { readFileSync } from 'fs';
import { join } from 'path';

import { foldForSearch, rankTechniques, searchTechniques, type TechniqueSummary } from '../techniques';

/**
 * Searching the technique library.
 *
 * This exists because a technique was unfindable for months and looked missing
 * instead of unsearchable. `sao-paulo-pass` — "São Paulo Pass" — has been in
 * the catalog the whole time; typing "sao paulo" on a phone returned nothing,
 * because a plain `toLowerCase().includes()` compares strings that genuinely
 * differ and nobody types the tilde.
 *
 * The near-consequence is what makes it worth a test file: the response was to
 * start building a way to ADD the technique, and authoring a duplicate would
 * have minted a second id for one technique — permanently, in every training
 * record that referenced either.
 */

/** The real shipped catalog, so this tests the data that actually exists
 *  rather than a fixture that agrees with the code. */
function realCatalog(): TechniqueSummary[] {
  const path = join(__dirname, '../../../../backend/internal/modules/technique/techniques.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[];
  return raw.map((t) => ({
    ...(t as unknown as TechniqueSummary),
    aliases: (t.aliases as string[]) ?? [],
    position_detail: (t.position_detail as string) ?? '',
    typical_belt: (t.typical_belt as string) ?? '',
    ibjjf_ruleset_id: (t.ibjjf_ruleset_id as string) ?? '',
    setup_from: (t.setup_from as string[]) ?? [],
  }));
}

describe('foldForSearch', () => {
  it('strips diacritics so typed ASCII matches stored accents', () => {
    expect(foldForSearch('São Paulo Pass')).toBe('sao paulo pass');
    expect(foldForSearch('Mata-leão')).toBe('mata leao');
    // Both directions: a query WITH the accent must fold too, or someone with
    // a Portuguese keyboard is the one who cannot search.
    expect(foldForSearch('são')).toBe(foldForSearch('sao'));
  });

  it('folds every dash, and the hyphen, to a space', () => {
    // All three spellings have to land on one string or the fold is pointless:
    // the catalog stores the en dash, the keyboard offers the hyphen, and
    // nobody reaches for either when searching.
    expect(foldForSearch('North–South Pass')).toBe('north south pass');
    expect(foldForSearch('North-South Pass')).toBe('north south pass');
    expect(foldForSearch('north south pass')).toBe('north south pass');
    // ...including the em dash and the minus sign, and collapsed, not doubled.
    expect(foldForSearch('a—b')).toBe('a b');
    expect(foldForSearch('a−b')).toBe('a b');
    expect(foldForSearch('a - b')).toBe('a b');
  });

  it('leaves unaccented text alone apart from case', () => {
    expect(foldForSearch('Knee Cut Pass')).toBe('knee cut pass');
    expect(foldForSearch('')).toBe('');
  });
});

describe('searchTechniques against the real catalog', () => {
  const catalog = realCatalog();

  it('has the São Paulo pass to find in the first place', () => {
    // If this fails the rest is meaningless — and it is the assumption that
    // was wrong for months, so it is asserted rather than assumed.
    const entry = catalog.find((t) => t.id === 'sao-paulo-pass');
    expect(entry).toBeDefined();
    expect(entry?.name).toBe('São Paulo Pass');
  });

  it('has the North\u2013South family to find, spelled with an en dash', () => {
    // The larger half of the same bug: 16 names carry U+2013, which NFD does
    // not decompose. Asserted rather than assumed, like the entry above.
    const entry = catalog.find((t) => t.id === 'north-south-pass');
    expect(entry).toBeDefined();
    expect(entry?.name).toContain('\u2013');
  });

  it.each([
    ['north-south pass', 'the hyphen that is actually on the keyboard'],
    ['north\u2013south pass', 'the en dash the data stores'],
    ['north south pass', 'no separator at all, which is how it gets typed'],
    ['NORTH-SOUTH', 'partial, hyphen, shouting'],
  ])('finds the en-dashed name by %p (%s)', (query) => {
    const ids = searchTechniques(catalog, query).map((t) => t.id);
    expect(ids).toContain('north-south-pass');
  });

  it.each([
    ['sao paulo', 'the way it is typed on a phone'],
    ['sao', 'a partial, no accent'],
    ['São Paulo', 'with the accent, from a Portuguese keyboard'],
    ['SAO PAULO', 'shouting'],
    ['tozi', 'by its alias'],
  ])('finds it by %p (%s)', (query) => {
    const ids = searchTechniques(catalog, query).map((t) => t.id);
    expect(ids).toContain('sao-paulo-pass');
  });

  it('still does not invent matches', () => {
    expect(searchTechniques(catalog, 'zzzznotathing')).toHaveLength(0);
  });

  it('an empty query returns everything', () => {
    expect(searchTechniques(catalog, '   ')).toHaveLength(catalog.length);
  });

  it('a query of nothing but punctuation is treated as empty, not as a match', () => {
    // Consequence of folding dashes to spaces: "-" now folds to "". Deliberate
    // — a lone dash is not a search, and returning the whole list is what
    // an empty box already does. Pinned because it changed: before the fold it
    // matched every hyphenated name.
    expect(foldForSearch('-')).toBe('');
    expect(searchTechniques(catalog, '-')).toHaveLength(catalog.length);
    expect(searchTechniques(catalog, ' — ')).toHaveLength(catalog.length);
  });

  it('does not match a single term that straddles two fields', () => {
    // A term is matched WITHIN one field, never across the boundary of two, so
    // a technique whose name ends how the term starts and whose alias begins
    // how it ends is not a match.
    const t = catalog.find((x) => x.aliases.length > 0);
    expect(t).toBeDefined();
    const glued = `${foldForSearch(t!.name)}${foldForSearch(t!.aliases[0])}`;
    expect(searchTechniques(catalog, glued).map((x) => x.id)).not.toContain(t!.id);
  });

  it('DOES match separate terms living in different fields', () => {
    // The deliberate reversal. Under the single-joined-haystack search this
    // was asserted NOT to match, and the separator existed to prevent it —
    // which also meant "armbar guard" could not find "Armbar from Closed
    // Guard", because no one field contains both words contiguously. Spanning
    // fields is the feature now; only spanning them mid-TERM is not.
    const t = catalog.find((x) => x.aliases.length > 0);
    expect(t).toBeDefined();
    const spaced = `${foldForSearch(t!.name)} ${foldForSearch(t!.aliases[0])}`;
    expect(searchTechniques(catalog, spaced).map((x) => x.id)).toContain(t!.id);

    // The case that motivated it, spelled out: name word + position word.
    const ids = searchTechniques(catalog, 'armbar guard').map((x) => x.id);
    expect(ids).toContain('armbar-closed-guard');
  });

  it('the memo caches the haystack, not the answer', () => {
    // Repeating one query only proves determinism \u2014 a cache keyed on a
    // constant would be consistently wrong and pass. Two DIFFERENT queries
    // across the same warmed objects is what catches a mis-keyed memo.
    const first = searchTechniques(catalog, 'sao paulo').map((t) => t.id);
    const other = searchTechniques(catalog, 'triangle').map((t) => t.id);
    const again = searchTechniques(catalog, 'sao paulo').map((t) => t.id);
    expect(first).toContain('sao-paulo-pass');
    expect(other.length).toBeGreaterThan(1);
    expect(other).not.toContain('sao-paulo-pass');
    expect(again).toEqual(first);
  });

  it('finds every entry the unfolded search would have missed', () => {
    // Derived from the DEFECT rather than from the fix. For each searchable
    // field, the "typed" form is what a keyboard produces \u2014 its folded
    // spelling \u2014 and an entry counts as missed if the OLD search (plain
    // lowercase substring over the same three fields) would not have found it
    // by that spelling. Every one of those must now be findable.
    //
    // The previous version derived the set from `fold(f) !== f.toLowerCase()`
    // and claimed an empty set would fail it. Backwards: under an identity
    // fold that predicate is true for anything containing a capital letter, so
    // the set grew to the whole catalog and the test passed. Measured, not
    // assumed.
    const typedForms = (t: TechniqueSummary) =>
      [t.name, ...t.aliases, t.position].map(foldForSearch).filter((f) => f.length > 0);
    const unfoldedWouldFind = (t: TechniqueSummary, typed: string) =>
      [t.name, ...t.aliases, t.position].some((f) => f.toLowerCase().includes(typed));

    const missed = catalog.filter((t) => typedForms(t).some((typed) => !unfoldedWouldFind(t, typed)));

    // Named explicitly, one per fold step, so a collapsed or empty set cannot
    // pass quietly: drop the diacritic strip and São Paulo leaves the set;
    // drop the dash fold and North–South leaves it; make the fold an identity
    // and the set empties entirely.
    const ids = missed.map((t) => t.id);
    expect(ids).toContain('sao-paulo-pass');
    expect(ids).toContain('north-south-pass');
    expect(ids).toContain('rear-naked-choke');

    for (const t of missed) {
      for (const typed of typedForms(t)) {
        expect(searchTechniques(catalog, typed).map((x) => x.id)).toContain(t.id);
      }
    }
  });

  it('searches position as well as name and aliases', () => {
    // Nothing else pins this: every other case queries a name or an alias, so
    // dropping position from the haystack left the whole suite green. It is a
    // real entry point — 37 half-guard techniques are named nothing like
    // "half guard" and are reachable by typing the position and no other way.
    const found = searchTechniques(catalog, 'half guard');
    // The load-bearing part: entries reached ONLY through their position,
    // whose own name says nothing about half guard. Without those the
    // assertion passes on name matches alone and proves nothing.
    const byPositionOnly = found.filter((t) => !foldForSearch(t.name).includes('half guard'));
    expect(byPositionOnly.length).toBeGreaterThan(20);
    expect(byPositionOnly.every((t) => foldForSearch(t.position).includes('half guard'))).toBe(true);
  });

  it('folds the fields that are not the name, too', () => {
    // Rear Naked Choke stores "Mata le\u00e3o" as an ALIAS. A fold applied to
    // names only would leave it unfindable and every name-based test would
    // still pass.
    expect(searchTechniques(catalog, 'mata leao').map((t) => t.id)).toContain('rear-naked-choke');
  });

});

/**
 * The queries a beginners' class actually produced.
 *
 * Same discipline as the S\u00e3o Paulo cases above, and the same failure repeating:
 * an athlete came out of a closed-guard passing class, could not enter a single
 * step of it, and concluded the library was incomplete. It was not. Every one
 * of these queries returned NOTHING against a library that held the answer,
 * because the search demanded the typed string be a contiguous substring of one
 * field:
 *
 *   "arm bar"          0 hits, while "armbar"      returned 21
 *   "break the guard"  0 hits, while "guard break" returned 5
 *   "pass the guard"   0 hits
 *
 * Derived from the defect, not from the fix: each case is a real spelling a
 * real person typed, asserted against the shipped catalog.
 */
describe('the spoken forms of a technique', () => {
  const catalog = realCatalog();

  it.each([
    ['arm bar', 'armbar-closed-guard', 'one word in the catalog, two on the keyboard'],
    ['knee cut', 'knee-cut-pass', 'hyphenated in the catalog'],
    ['break the guard', 'closed-guard-standing-break', 'a joiner the name does not contain'],
    ['guard break', 'closed-guard-standing-break', 'the words in the other order'],
    ['pass the guard', 'knee-cut-pass', 'spoken form of a whole category'],
    ['kimura side control', 'kimura-side-control', 'name plus position, no joiner'],
  ])('%p finds %p (%s)', (query, id) => {
    expect(searchTechniques(catalog, query).map((t) => t.id)).toContain(id);
  });

  it('ANDs the terms rather than ORing them', () => {
    // The cheap way to make the above pass is to match ANY term, which would
    // turn every search into a firehose: "knee belly" would return all 19
    // techniques whose name merely contains "knee". The whole point is that
    // adding a word narrows.
    const knee = searchTechniques(catalog, 'knee');
    const kneeBelly = searchTechniques(catalog, 'knee belly');
    expect(knee.length).toBeGreaterThan(kneeBelly.length);
    expect(kneeBelly.every((t) => searchTechniques([t], 'knee').length === 1)).toBe(true);
  });

  it('a term that matches nothing rejects the row outright', () => {
    // The other half of ANDing, and the one an OR would pass: a real word
    // paired with nonsense must return nothing at all, not the real word's hits.
    expect(searchTechniques(catalog, 'armbar zzzznotathing')).toHaveLength(0);
  });

  it('does not drop a query made only of joiners', () => {
    // "to the" strips to nothing. Returning the whole catalog there would be
    // indistinguishable from an empty box, so the joiners are kept as terms.
    // Not a real search, but the athlete typed something and deserves the
    // honest answer rather than the whole catalog.
    expect(searchTechniques(catalog, 'to the').length).toBeLessThan(catalog.length);
  });
});

/**
 * Ranking, which is what makes a capped picker honest.
 *
 * The reflect picker showed the first 8 matches in SEED-FILE order. "side
 * control" matches 50 techniques, so an athlete who had just drilled side
 * control got three closed-guard armbars and no side-control ones \u2014 the cap
 * was never the problem, the arbitrary choice of which 8 was.
 */
describe('rankTechniques', () => {
  const catalog = realCatalog();

  it('puts an exact name match first', () => {
    expect(rankTechniques(catalog, 'Knee-Cut Pass')[0].id).toBe('knee-cut-pass');
    expect(rankTechniques(catalog, 'kimura from side control')[0].id).toBe('kimura-side-control');
  });

  it('ranks a name match above a match found only in another field', () => {
    // "armbar" hits 20 names, and three more rows only through their ALIASES
    // (Choi Bar, S-Mount Control, Mount to S-Mount). Without the field weights
    // those interleave by catalog order and the top of the list is noise.
    const ranked = rankTechniques(catalog, 'armbar');
    const isName = ranked.map((t) => foldForSearch(t.name).includes('armbar'));
    const firstNonName = isName.indexOf(false);

    // ASSERTED, not guarded. This was `if (firstNonName !== -1)`, which is one
    // catalog edit away from asserting nothing at all and passing — the exact
    // shape of vacuous test this repo keeps finding. If every match is a name
    // match the scenario has evaporated and this must go red, not green.
    expect(firstNonName).not.toBe(-1);
    expect(isName.lastIndexOf(true)).toBeLessThan(firstNonName);
  });

  it('reaches techniques through category and function alone', () => {
    // The W_META rung had no behavioural cover in either app: deleting it left
    // every test green while 418 of the 466 rows the library then held lost
    // reachability for some term.
    // `function` is the half that diverged between the apps, so it is pinned
    // by a query no other field can satisfy — no name or position says
    // "reverse", but every sweep carries function=reverse.
    const reverse = searchTechniques(catalog, 'reverse');
    const viaFunctionOnly = reverse.filter(
      (t) =>
        !foldForSearch(t.name).includes('reverse') &&
        !foldForSearch(t.position).includes('reverse') &&
        !t.aliases.some((a) => foldForSearch(a).includes('reverse')),
    );
    expect(viaFunctionOnly.length).toBeGreaterThan(20);
    expect(viaFunctionOnly.every((t) => t.function === 'reverse')).toBe(true);

    // ...and the category half of the same rung.
    const viaCategory = searchTechniques(catalog, 'submission').filter(
      (t) => !foldForSearch(t.name).includes('submission'),
    );
    expect(viaCategory.length).toBeGreaterThan(20);
  });

  it('returns the same set as searchTechniques, only reordered', () => {
    // Two definitions of "matches" would drift, and the drift would show as a
    // technique findable in the Library but not in the picker.
    for (const q of ['armbar', 'knee cut', 'break the guard', 'side control']) {
      const a = searchTechniques(catalog, q).map((t) => t.id).sort();
      const b = rankTechniques(catalog, q).map((t) => t.id).sort();
      expect(b).toEqual(a);
    }
  });

  it('searchTechniques preserves the caller\u2019s order and rankTechniques does not', () => {
    // LOAD-BEARING. Both Library screens merge search output against the
    // exercise catalog with a linear merge of two NAME-SORTED runs. Ranking
    // inside searchTechniques would corrupt that interleave into a jumble \u2014
    // no type error, no other failing test. This is the only thing pinning it.
    const byName = [...catalog].sort((a, b) => a.name.localeCompare(b.name));
    const filtered = searchTechniques(byName, 'guard').map((t) => t.name);
    expect(filtered).toEqual([...filtered].sort((a, b) => a.localeCompare(b)));

    // ...and the ranked variant genuinely reorders, or the assertion above is
    // passing because nothing sorts at all.
    const ranked = rankTechniques(byName, 'guard').map((t) => t.name);
    expect(ranked).not.toEqual(filtered);
  });
});
