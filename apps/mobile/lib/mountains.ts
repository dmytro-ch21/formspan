/**
 * The eight peaks, and which session gets which.
 *
 * DETERMINISTIC, not random. The same session must render the same mountain
 * every time it is opened, re-opened or re-exported — a card that changed
 * picture between the preview and the share sheet would look like a bug, and a
 * feed that reshuffled on every refresh would be worse.
 *
 * Keyed off the session id rather than an index, because the feed and the
 * completion screen render the same session from different lists and only the
 * id is common to both.
 */

export const MOUNTAINS = {
  'half-dome': require('../assets/images/mountains/peak-half-dome-01.webp'),
  table: require('../assets/images/mountains/peak-table-02.webp'),
  matterhorn: require('../assets/images/mountains/peak-matterhorn-03.webp'),
  kilimandjaro: require('../assets/images/mountains/peak-kilimandjaro-04.webp'),
  fuji: require('../assets/images/mountains/peak-fuji-05.webp'),
  everest: require('../assets/images/mountains/peak-everest-06.webp'),
  denali: require('../assets/images/mountains/peak-denali-07.webp'),
  'fitz-roy': require('../assets/images/mountains/peak-fitz-roy-08.webp'),
} as const;

export type MountainName = keyof typeof MOUNTAINS;

/** Declared rather than derived from `Object.keys`, so the order the hash maps
 *  onto is stable against anyone reordering the map above. */
export const MOUNTAIN_ORDER: MountainName[] = [
  'half-dome',
  'table',
  'matterhorn',
  'kilimandjaro',
  'fuji',
  'everest',
  'denali',
  'fitz-roy',
];

/**
 * FNV-1a with a final avalanche, seeded so several derivations of the same id
 * do not correlate.
 *
 * Not for security — for spread. A naive `id.length % 8` clusters completely
 * (UUIDs are all the same length, so every session gets the same peak), and
 * summing char codes clusters on hex ids because they share an alphabet.
 *
 * THE AVALANCHE IS NOT DECORATION. FNV's multiply only propagates bits
 * upward, so its low bits are barely mixed — and `% 8` reads exactly those.
 * Two hashes over the same string with different seeds therefore stayed
 * correlated: measured over 300 ids, the peak-and-headline pair took only 16
 * of its 32 possible combinations, so half the intended variety never
 * appeared. The three-line finalizer folds high bits down before the modulus
 * and takes it to the full 32.
 */
export function hash32(value: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/** The seed for the peak. Any derivation from the same id needs its own. */
export const PEAK_SEED = 0x811c9dc5;

export function mountainFor(id: string): MountainName {
  return MOUNTAIN_ORDER[hash32(id, PEAK_SEED) % MOUNTAIN_ORDER.length];
}
