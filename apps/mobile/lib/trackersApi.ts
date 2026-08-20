/**
 * The daily-tracker endpoints, as the phone sees them.
 *
 * A wire layer and nothing else — no caching, no merging, no local state, the
 * same division `nutritionApi.ts` keeps with `foodLog.ts`. `trackers.ts` owns
 * SQLite and the outbox.
 *
 * Every write is keyed on a CLIENT-GENERATED id, which is what makes a retry
 * after a dead spot safe: sending the same tap twice is the same as sending it
 * once.
 */

import { apiRequest } from './apiRequest';
import type { RenderStyle, Tracker, TrackerEntry, TrackerUnit } from './trackerModel';
import type { TokenGetter } from './useAuthToken';

/** What the server sends back. The client's `Tracker` plus the server's book-keeping. */
export type WireTracker = Tracker & {
  user_id: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TrackerInput = {
  id: string;
  name: string;
  icon?: string;
  color_key: string;
  unit?: TrackerUnit;
  increment: number;
  target?: number | null;
  render_style?: RenderStyle;
  sort_order?: number;
};

/**
 * A PARTIAL update. Only the keys present are written; everything else on the
 * tracker is left exactly as it is.
 *
 * `target` is deliberately `number | null` and deliberately optional: omitting
 * it means "leave my target alone", sending `null` means "I want no target".
 * They are different requests and the server treats them differently, so a
 * caller building this object with `{ target: x ?? null }` would silently turn
 * the first into the second.
 */
export type TrackerPatch = {
  name?: string;
  icon?: string;
  color_key?: string;
  unit?: TrackerUnit;
  increment?: number;
  target?: number | null;
  render_style?: RenderStyle;
  sort_order?: number;
};

export type EntryInput = {
  logged_on: string;
  logged_at: string;
  amount: number;
};

/**
 * The athlete's trackers.
 *
 * This call is also what PROVISIONS the seeded presets server-side, so a phone
 * that has never listed has no water card. That is why the local cache renders
 * a loading state rather than an empty one — see `trackers.ts`.
 */
export function listTrackers(getToken: TokenGetter): Promise<WireTracker[]> {
  return apiRequest<{ trackers: WireTracker[] }>(getToken, '/trackers').then(
    (b) => b.trackers ?? [],
  );
}

export function createTracker(getToken: TokenGetter, input: TrackerInput): Promise<WireTracker> {
  return apiRequest<WireTracker>(getToken, '/trackers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function patchTracker(
  getToken: TokenGetter,
  id: string,
  patch: TrackerPatch,
): Promise<WireTracker> {
  return apiRequest<WireTracker>(getToken, `/trackers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function archiveTracker(getToken: TokenGetter, id: string): Promise<void> {
  return apiRequest<void>(getToken, `/trackers/${id}`, { method: 'DELETE' });
}

export function listEntries(
  getToken: TokenGetter,
  range: { from: string; to: string },
): Promise<(TrackerEntry & { user_id: string })[]> {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  return apiRequest<{ entries: (TrackerEntry & { user_id: string })[] }>(
    getToken,
    `/trackers/entries?${q}`,
  ).then((b) => b.entries ?? []);
}

export function logEntry(
  getToken: TokenGetter,
  trackerID: string,
  entryID: string,
  input: EntryInput,
): Promise<TrackerEntry> {
  return apiRequest<TrackerEntry>(getToken, `/trackers/${trackerID}/entries/${entryID}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/**
 * Remove one tap.
 *
 * The server answers 204 whether or not the row was there, so this resolves for
 * an entry another device already removed — which is exactly what an outbox
 * retry looks like.
 */
export function deleteEntry(
  getToken: TokenGetter,
  trackerID: string,
  entryID: string,
): Promise<void> {
  return apiRequest<void>(getToken, `/trackers/${trackerID}/entries/${entryID}`, {
    method: 'DELETE',
  });
}
