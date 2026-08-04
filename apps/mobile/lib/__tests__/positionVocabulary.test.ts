import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The position vocabulary is copied into four places and enforced in none.
 *
 * `backend/internal/modules/technique/positions.json` is the source of truth —
 * `validFamilies` in the seed validates against it, and the API serves it. But
 * the clients cannot fetch it at the moment they need it: the Library chips
 * render before any request completes, and the reflection wizard is used in a
 * car park with no signal. So each one hardcodes the list, and a hardcoded copy
 * of a growing set drifts by construction.
 *
 * It has now drifted twice, the same way both times. North-South was added to
 * the glossary and left off the chips, so its techniques were reachable only by
 * typing while a card on the same screen advertised the position. Then leg
 * entanglement was promoted to its own position and 26 techniques moved out
 * from under the Guard chip — again reachable only by search, and again with a
 * glossary card promising otherwise. Both were caught by a human reading the
 * diff, which is not a mechanism.
 *
 * This is the mechanism. It reads the real files rather than a fixture, so it
 * fails the moment a position is added to the glossary without the clients
 * following — in CI, rather than in a gym.
 *
 * It deliberately covers `apps/web` too, from the only jest suite in the repo.
 * A test living in the wrong app is a smaller problem than a filter that
 * silently hides 26 techniques.
 */

const REPO = join(__dirname, '..', '..', '..', '..');

function glossaryFamilies(): Set<string> {
  const raw = readFileSync(
    join(REPO, 'backend/internal/modules/technique/positions.json'),
    'utf8',
  );
  return new Set((JSON.parse(raw) as { family: string }[]).map((p) => p.family));
}

function glossaryIds(): Set<string> {
  const raw = readFileSync(
    join(REPO, 'backend/internal/modules/technique/positions.json'),
    'utf8',
  );
  return new Set((JSON.parse(raw) as { id: string }[]).map((p) => p.id));
}

/**
 * Pull the keys out of a `Record<string, string>` code table.
 *
 * Separate from `keysIn` because these are object literals rather than `as
 * const` arrays, and they are keyed on the glossary's ids (`closed-guard`)
 * rather than its families (`Guard`) — a different vocabulary with the same
 * drift problem.
 */
function recordKeysIn(relPath: string, marker: string): Set<string> {
  const src = readFileSync(join(REPO, relPath), 'utf8');
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${relPath}: no ${marker} — the table was renamed`);
  const end = src.indexOf('};', start);
  if (end === -1) throw new Error(`${relPath}: ${marker} is not an object literal any more`);
  const body = src.slice(start + marker.length, end);

  // Quoted keys (`'closed-guard':`) and bare ones (`mount:`) both occur.
  const found = [...body.matchAll(/^\s*(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*:/gm)]
    .map((m) => m[1] ?? m[2])
    .filter(Boolean);

  if (found.length === 0) throw new Error(`${relPath}: parsed no entries from ${marker}`);
  return new Set(found);
}

/**
 * Pull the family keys out of a hardcoded POSITIONS array.
 *
 * Two shapes exist: the Library chips are `{ key: 'Guard', label: 'Guard' }`
 * and the wizard's list is bare strings. Matching `key:` first rather than
 * every quoted string is what keeps the display labels out — an earlier
 * version of this scraped `label:` values too and reported "Leg entanglement"
 * (lowercase e) as an unknown family, which is a false alarm that would teach
 * someone to delete the test.
 */
function keysIn(relPath: string, marker: string): Set<string> {
  const src = readFileSync(join(REPO, relPath), 'utf8');
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${relPath}: no ${marker} — the array was renamed`);
  const end = src.indexOf('] as const', start);
  if (end === -1) throw new Error(`${relPath}: ${marker} is not a const array any more`);
  const body = src.slice(start + marker.length, end);

  const keyed = [...body.matchAll(/\bkey:\s*['"]([^'"]*)['"]/g)].map((m) => m[1]);
  const found = keyed.length > 0
    ? keyed
    : [...body.matchAll(/^\s*['"]([^'"]+)['"],/gm)].map((m) => m[1]);

  if (found.length === 0) throw new Error(`${relPath}: parsed no entries from ${marker}`);
  // '' is the "All positions" chip, which is the absence of a filter.
  return new Set(found.filter((v) => v !== ''));
}

describe('every client offers what the glossary names', () => {
  const families = glossaryFamilies();

  it('the glossary itself is non-trivial', () => {
    // Guards the guard: a parse failure returning {} would make every
    // assertion below vacuously pass.
    expect(families.size).toBeGreaterThanOrEqual(9);
    expect(families.has('Leg Entanglement')).toBe(true);
  });

  it.each([
    ['apps/mobile/app/(tabs)/library.tsx', 'const POSITIONS = ['],
    ['apps/mobile/lib/bjjSession.ts', 'export const POSITIONS = ['],
    ['apps/web/src/lib/libraryTiles.ts', 'export const POSITIONS = ['],
  ])('%s covers every family', (relPath, marker) => {
    const have = keysIn(relPath, marker);
    const missing = [...families].filter((f) => !have.has(f));
    expect(missing).toEqual([]);
  });

  it.each([
    ['apps/mobile/app/(tabs)/library.tsx', 'const POSITIONS = ['],
    ['apps/mobile/lib/bjjSession.ts', 'export const POSITIONS = ['],
    ['apps/web/src/lib/libraryTiles.ts', 'export const POSITIONS = ['],
  ])('%s invents no family the glossary lacks', (relPath, marker) => {
    // The other direction matters just as much: a chip keyed on a family that
    // no technique carries filters to an empty list, which reads as "there is
    // nothing here" rather than as a bug.
    const extra = [...keysIn(relPath, marker)].filter((k) => !families.has(k));
    expect(extra).toEqual([]);
  });
});

/**
 * The second vocabulary, and the one the glossary row is drawn from.
 *
 * The tile codes are keyed on position *ids*, not families, because colour is
 * deliberately achromatic on every glossary tile — the three letters are the
 * only thing distinguishing Closed Guard from Open Guard in a row of eleven.
 * A position added without a code falls back to "POS", which reads as a
 * deliberate label rather than a missing one, and duplicates read as a
 * rendering bug. Same drift, same mechanism.
 */
describe('every client has a tile code for each glossary entry', () => {
  const ids = glossaryIds();

  it('the glossary itself is non-trivial', () => {
    expect(ids.size).toBeGreaterThanOrEqual(11);
    expect(ids.has('leg-entanglement')).toBe(true);
  });

  it.each([
    ['apps/mobile/components/LibraryTile.tsx', 'const POSITION: Record<string, string> = {'],
    ['apps/web/src/lib/libraryTiles.ts', 'const POSITION_CODE: Record<string, string> = {'],
  ])('%s codes every position', (relPath, marker) => {
    const missing = [...ids].filter((id) => !recordKeysIn(relPath, marker).has(id));
    expect(missing).toEqual([]);
  });

  it.each([
    ['apps/mobile/components/LibraryTile.tsx', 'const POSITION: Record<string, string> = {'],
    ['apps/web/src/lib/libraryTiles.ts', 'const POSITION_CODE: Record<string, string> = {'],
  ])('%s codes nothing the glossary lacks', (relPath, marker) => {
    const extra = [...recordKeysIn(relPath, marker)].filter((k) => !ids.has(k));
    expect(extra).toEqual([]);
  });

  /**
   * Two positions sharing a code is the exact failure keying on id was meant
   * to fix — it shipped once as GRD/GRD and SDE/SDE.
   */
  it.each([
    ['apps/mobile/components/LibraryTile.tsx', 'const POSITION: Record<string, string> = {'],
    ['apps/web/src/lib/libraryTiles.ts', 'const POSITION_CODE: Record<string, string> = {'],
  ])('%s gives no two positions the same code', (relPath, marker) => {
    const src = readFileSync(join(REPO, relPath), 'utf8');
    const start = src.indexOf(marker);
    const body = src.slice(start + marker.length, src.indexOf('};', start));
    const codes = [...body.matchAll(/:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(11);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
