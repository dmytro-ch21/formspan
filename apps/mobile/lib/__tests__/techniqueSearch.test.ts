import { readFileSync } from 'fs';
import { join } from 'path';

import { foldForSearch, searchTechniques, type TechniqueSummary } from '../techniques';

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

  it('does not match a query spanning two fields', () => {
    // The haystack joins name/aliases/position, so without a separator a query
    // could match across the seam and return a technique whose name ends how
    // the query starts and whose position begins how it ends.
    const t = catalog.find((x) => x.aliases.length > 0);
    expect(t).toBeDefined();
    const spanning = `${foldForSearch(t!.name)}${foldForSearch(t!.aliases[0])}`;
    expect(searchTechniques(catalog, spanning).map((x) => x.id)).not.toContain(t!.id);
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

  it('finds every entry that needs folding, by its folded spelling', () => {
    // Derived from the FOLD rather than a hardcoded unicode range, over all
    // three searchable fields \u2014 the previous range-based version matched
    // one entry, the same one already asserted five ways above, and missed
    // both the en dashes and Rear Naked Choke's accented aliases (which live
    // in aliases, not name). Anything a future import adds is covered without
    // anyone remembering to widen a character class.
    const needsFolding = catalog.filter((t) =>
      [t.name, ...t.aliases, t.position].some((f) => foldForSearch(f) !== f.toLowerCase()),
    );
    // Also the guard on the guard: if foldForSearch became a no-op this set is
    // empty and the loop below would assert nothing.
    expect(needsFolding.length).toBeGreaterThan(15);

    for (const t of needsFolding) {
      const typed = foldForSearch(t.name);
      expect(searchTechniques(catalog, typed).map((x) => x.id)).toContain(t.id);
    }
  });

  it('searches position as well as name and aliases', () => {
    // Nothing else pins this: every other case queries a name or an alias, so
    // dropping position from the haystack left the whole suite green. It is a
    // real entry point: 37 half-guard techniques are named nothing like
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
