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
    expect(foldForSearch('Mata-leão')).toBe('mata-leao');
    // Both directions: a query WITH the accent must fold too, or someone with
    // a Portuguese keyboard is the one who cannot search.
    expect(foldForSearch('são')).toBe(foldForSearch('sao'));
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

  it('does not match a query spanning two fields', () => {
    // The haystack joins name/aliases/position, so without a separator a query
    // could match across the seam and return a technique whose name ends how
    // the query starts and whose position begins how it ends.
    const t = catalog.find((x) => x.aliases.length > 0);
    expect(t).toBeDefined();
    const spanning = `${foldForSearch(t!.name)}${foldForSearch(t!.aliases[0])}`;
    expect(searchTechniques(catalog, spanning).map((x) => x.id)).not.toContain(t!.id);
  });

  it('caching does not make a second search disagree with the first', () => {
    // The folded haystack is memoised per technique object; a stale or
    // mis-keyed cache would show up as the same query answering differently.
    const first = searchTechniques(catalog, 'sao paulo').map((t) => t.id);
    const second = searchTechniques(catalog, 'sao paulo').map((t) => t.id);
    expect(second).toEqual(first);
  });

  it('finds every accented entry the catalog holds, by its ASCII spelling', () => {
    // Generated from the data rather than hardcoded, so a future import that
    // adds accented names is covered without anyone remembering to come back.
    const withMarks = catalog.filter((t) => /[\u00c0-\u024f]/.test(t.name));
    expect(withMarks.length).toBeGreaterThan(0);
    for (const t of withMarks) {
      const typed = foldForSearch(t.name);
      expect(searchTechniques(catalog, typed).map((x) => x.id)).toContain(t.id);
    }
  });
});
