import { randomUUID } from 'expo-crypto';

import { apiRequest } from './apiRequest';
import { getDb } from './db';
import { isPermanentRejection, isTransportFailure, retryAfterOf } from './apiError';
import type { TokenGetter } from './useAuthToken';

/**
 * Sequences on the phone: read the server's, capture new ones on the mat.
 *
 * **The platform split, applied.** Web owns AUTHORING — the two-pane builder
 * against a 634-entry catalog is a desk job and stays there. The phone owns
 * CAPTURE: the chain your class just taught, recorded while you still remember
 * it, from techniques you have already tagged in the reflection. Refining it —
 * reordering, naming the positions each step leaves you in, writing notes —
 * happens later at a desk.
 *
 * **Capture is offline-first, and that is the whole point.** The moment worth
 * serving is the changing room, which is a dead-spot more often than not. So a
 * capture writes to SQLite first and the outbox owes it to the server, exactly
 * as an activity or a plan does. The backend originally asserted there was "no
 * offline creation to make idempotent" for sequences; that was true of the
 * builder and wrong within a day, and `POST /v1/sequences` now takes the id
 * generated here.
 *
 * **Reads are NOT offline-first, deliberately.** Listing sequences hits the
 * server and merges in whatever this device still owes it. A local cache of
 * other people's — or of your own desk-edited — chains would be a second copy
 * to invalidate, and the existing technique library has the same shape and the
 * same honest degradation. What must never fail offline is seeing what you
 * just captured, and that comes from the outbox rather than from a cache.
 */

export type SequenceStep = {
  technique_id: string;
  ends_at_position_id: string | null;
  notes: string;
  /** Present only on server rows — the library's own name, resolved there. */
  name?: string;
  position?: string;
  category?: string;
  function?: string;
  ends_at_position_name?: string;
};

export type Sequence = {
  id: string;
  name: string;
  description: string;
  start_position_id: string | null;
  start_position_name?: string;
  step_count: number;
  steps?: SequenceStep[];
  editable: boolean;
  /** True while this device still owes it to the server. Rendered, because a
   *  chain that has not left the phone yet is a fact the athlete should see
   *  rather than a detail to hide. */
  pending?: boolean;
};

/** Mirrored from the Go module and the contract. The server decides; these
 *  exist so the client can refuse before a 400 retires a capture the athlete
 *  was already told was saved. */
export const MAX_SEQUENCE_STEPS = 20;
export const MAX_SEQUENCE_NAME = 120;

export type NewSequence = {
  name: string;
  description?: string;
  start_position_id?: string | null;
  steps: { technique_id: string; ends_at_position_id?: string | null; notes?: string }[];
};

/**
 * Capture a chain locally. Returns the id immediately — it is generated here,
 * so nothing has to wait for a round trip that may not be possible.
 *
 * `randomUUID` rather than a counter or a timestamp: two devices signed into
 * one account capture independently and offline, so the id has to be unique
 * without coordination. A timestamp collides the moment two phones agree on
 * the second.
 */
export async function captureSequence(userId: string, input: NewSequence): Promise<string> {
  const db = await getDb();
  const id = randomUUID();
  await db.runAsync(
    `INSERT INTO sequences (id, user_id, name, description, start_position_id, steps_json, created_at, dirty, remote)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    id,
    userId,
    input.name,
    input.description ?? '',
    input.start_position_id ?? null,
    // Stored exactly as given. The array order IS the chain; re-sorting it
    // anywhere on the way in or out changes what the athlete recorded.
    JSON.stringify(
      input.steps.map((s) => ({
        technique_id: s.technique_id,
        ends_at_position_id: s.ends_at_position_id ?? null,
        notes: s.notes ?? '',
      })),
    ),
    new Date().toISOString(),
  );
  return id;
}

type LocalRow = {
  id: string;
  name: string;
  description: string;
  start_position_id: string | null;
  steps_json: string;
  dirty: number;
  remote: number;
};

/** Everything this device still owes the server, newest first.
 *
 *  Exported as `pendingSequences` below so a caller can fall back to the local
 *  half when the server errors — `listSequences` rejects the whole promise on
 *  a 500, and a screen degrading to "you have none" would hide the athlete's
 *  own unsynced captures during an outage. */
async function pendingLocal(userId: string): Promise<Sequence[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<LocalRow>(
    `SELECT id, name, description, start_position_id, steps_json, dirty, remote
     FROM sequences WHERE user_id = ? AND dirty = 1 ORDER BY created_at DESC`,
    userId,
  );
  return rows.map((r) => {
    // A row whose JSON cannot be parsed is corrupt rather than empty, and
    // rendering it as a 0-step chain would quietly hide that. Surface it with
    // its name so the athlete can see something is wrong and delete it.
    let steps: SequenceStep[] = [];
    try {
      steps = JSON.parse(r.steps_json) as SequenceStep[];
    } catch {
      steps = [];
    }
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      start_position_id: r.start_position_id,
      step_count: steps.length,
      steps,
      editable: true,
      pending: true,
    };
  });
}

/**
 * The list, server rows plus anything still in the outbox.
 *
 * Local rows are merged by id and take precedence, which matters for the
 * window between a successful push and the next list: the server row and the
 * still-dirty local row are the same chain, and showing both would look like a
 * duplicate capture. Offline the server half is simply empty and the athlete
 * still sees what they captured.
 */
export async function listSequences(
  userId: string,
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<Sequence[]> {
  const local = await pendingLocal(userId);
  let remote: Sequence[] = [];
  try {
    const body = await apiRequest<{ sequences: Sequence[] }>(getToken, '/sequences', { signal });
    remote = body.sequences ?? [];
  } catch (err) {
    // A request that got no answer is not an error here — the outbox is the
    // answer. Anything else is worth propagating, or a server fault reads as
    // "you have no sequences", which is the failure this codebase keeps
    // re-learning.
    //
    // `isTransportFailure`, not `isOffline`: since N55 a dead request may be a
    // timeout or a dropped connection as well as no route, and all three mean
    // the same thing here — we could not ask, so fall back to what is local.
    if (!isTransportFailure(err)) throw err;
  }
  const localIDs = new Set(local.map((s) => s.id));
  return [...local, ...remote.filter((s) => !localIDs.has(s.id))];
}

export async function getSequence(
  userId: string,
  id: string,
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<Sequence | null> {
  const local = (await pendingLocal(userId)).find((s) => s.id === id);
  if (local) return local;
  try {
    return await apiRequest<Sequence>(getToken, `/sequences/${encodeURIComponent(id)}`, { signal });
  } catch (err) {
    // Same reading as the list above: no answer means "I could not ask", not
    // "it is not there".
    if (isTransportFailure(err)) return null;
    throw err;
  }
}

/** The outbox half of the list, for callers that need to degrade to it. */
export const pendingSequences = pendingLocal;

export type SequenceSyncResult = {
  pushed: number;
  failed: number;
  error?: string;
  errorKind?: 'offline' | 'permanent' | 'transient';
  /** The largest `Retry-After` seen this run, in ms (F17, #403). */
  retryAfterMs?: number;
};

function classify(err: unknown): 'offline' | 'permanent' | 'transient' {
  if (isTransportFailure(err)) return 'offline';
  if (isPermanentRejection(err)) return 'permanent';
  return 'transient';
}

/** Fold one failure's `Retry-After` into the run's running maximum. */
function noteRetryAfter(result: { retryAfterMs?: number }, err: unknown): void {
  const ms = retryAfterOf(err);
  if (ms != null) result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, ms);
}

function worseKind(
  a: SequenceSyncResult['errorKind'],
  b: NonNullable<SequenceSyncResult['errorKind']>,
): NonNullable<SequenceSyncResult['errorKind']> {
  if (a === 'offline' || b === 'offline') return 'offline';
  if (a === 'permanent' || b === 'permanent') return 'permanent';
  return 'transient';
}

/**
 * Serialised, like `syncSessions` and `syncPlans`: two overlapping runs would
 * push the same dirty rows twice.
 */
let inFlight: Promise<SequenceSyncResult> | null = null;

export function syncSequences(userId: string, getToken: TokenGetter): Promise<SequenceSyncResult> {
  const run = (inFlight ?? Promise.resolve(null))
    .catch(() => null)
    .then(() => push(userId, getToken));
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}

async function push(userId: string, getToken: TokenGetter): Promise<SequenceSyncResult> {
  const db = await getDb();
  const result: SequenceSyncResult = { pushed: 0, failed: 0 };
  const rows = await db.getAllAsync<LocalRow>(
    `SELECT id, name, description, start_position_id, steps_json, dirty, remote
     FROM sequences WHERE user_id = ? AND dirty = 1 ORDER BY created_at`,
    userId,
  );

  for (const r of rows) {
    let steps: { technique_id: string; ends_at_position_id: string | null; notes: string }[];
    try {
      steps = JSON.parse(r.steps_json);
    } catch {
      // Unparseable local JSON will never become parseable by retrying. Mark
      // it clean with an error rather than jamming the outbox behind it
      // forever — the row stays on the device for the athlete to see.
      await db.runAsync(
        `UPDATE sequences SET dirty = 0, last_error = ? WHERE id = ?`,
        'corrupt local copy — could not be sent',
        r.id,
      );
      result.failed += 1;
      result.errorKind = worseKind(result.errorKind, 'permanent');
      continue;
    }

    try {
      await apiRequest(getToken, '/sequences', {
        method: 'POST',
        // `id` is the whole reason a retry is safe: the server takes it and
        // answers the replay idempotently instead of creating a second chain.
        body: JSON.stringify({
          id: r.id,
          name: r.name,
          description: r.description,
          start_position_id: r.start_position_id,
          steps,
        }),
      });
      await db.runAsync(
        `UPDATE sequences SET dirty = 0, remote = 1, last_error = NULL WHERE id = ?`,
        r.id,
      );
      result.pushed += 1;
    } catch (err) {
      const kind = classify(err);
      const message = err instanceof Error ? err.message : String(err);
      result.failed += 1;
      result.error = result.error ?? message;
      result.errorKind = worseKind(result.errorKind, kind);
      noteRetryAfter(result, err);
      await db.runAsync(`UPDATE sequences SET last_error = ? WHERE id = ?`, message, r.id);
      if (kind === 'permanent') {
        // A 4xx will not become a 2xx. Stop owing it, keep the row and the
        // reason — the alternative is an outbox that never drains and a
        // pending count that never reaches zero.
        await db.runAsync(`UPDATE sequences SET dirty = 0 WHERE id = ?`, r.id);
      }
      if (kind === 'offline') {
        // No point walking the rest of the queue against a dead network.
        break;
      }
    }
  }
  return result;
}

/**
 * The one-line meta a list row shows under a chain's name.
 *
 * Here rather than inline in the screen so a test can pin the exact words to a
 * LITERAL. Re-deriving the string from this same expression inside the test
 * would be true by construction — it would still pass with the pluralisation
 * inverted and the separator changed, which is the class of assertion review
 * caught on this repo the day before this landed.
 */
export function stepSummary(s: Sequence): string {
  const steps = `${s.step_count} step${s.step_count === 1 ? '' : 's'}`;
  return s.start_position_name ? `${steps} · from ${s.start_position_name}` : steps;
}

/**
 * The library's name for a step, the locally-resolved one, or nothing.
 *
 * **Returning `undefined` rather than the id is the point.** The server
 * resolves `name` on read; a chain still in this device's outbox carries only
 * the technique ids the reflection wizard tagged, and rendering
 * `half-guard-knee-shield` where a name belongs is a false claim dressed as a
 * fallback. The caller says "name unavailable" instead, which is true.
 */
export function stepName(
  step: SequenceStep,
  names: Record<string, string>,
): string | undefined {
  return step.name || names[step.technique_id] || undefined;
}

/** `position · category`, skipping whichever the server did not resolve. Empty
 *  for a local capture, which has neither. */
export function stepMeta(step: SequenceStep): string {
  return [step.position, step.category].filter((v) => v).join(' · ');
}

/** How many captures this device still owes the server. */
export async function pendingSequenceCount(userId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sequences WHERE user_id = ? AND dirty = 1`,
    userId,
  );
  return row?.n ?? 0;
}
