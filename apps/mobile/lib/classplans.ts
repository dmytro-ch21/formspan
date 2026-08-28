import { apiRequest } from './apiRequest';
import type { TokenGetter } from './useAuthToken';

/**
 * Class plans, read back on the phone that runs them — client half of
 * `/v1/classplans`. (Paths below omit the prefix: `apiRequest` already
 * carries `/v1`.)
 *
 * **READ ONLY, and deliberately so.** `backend/internal/modules/classplan/
 * classplan.go`'s package doc explains why a class plan shares no code with
 * `sequence` or `curriculum`: its order is a SCHEDULE (ten minutes of this,
 * then fifteen of that), not a causal chain or a syllabus. That same doc,
 * plus N440's web builder, is where authoring already lives — a two-pane
 * builder against the technique catalog is a desk job, same reasoning as
 * `sequences.ts` gives for keeping the chain-builder on web. What the phone
 * needs is the other half: picking a plan a coach already wrote and running
 * it on the mat, which is `app/classplans/index.tsx` and
 * `app/classplans/[id]/run.tsx`.
 *
 * **No offline outbox, unlike `sequences.ts`.** Sequences capture on the
 * phone (a chain jotted down between classes), so a local write needs a
 * retry queue. A class plan is never written from the phone at all — every
 * mutation is `apps/web`'s — so there is nothing here to queue, and this
 * file is a thin, direct mirror of `curriculum.ts`'s read-only functions
 * rather than of `sequences.ts`'s local-first ones.
 */

export type ClassPlanBlock = {
  /** Zero-based, assigned by the server from array order. */
  order: number;
  type: 'warmup' | 'technique_drill' | 'live_rounds' | 'notes';
  duration_minutes: number;
  /** Set only on a `technique_drill` block, and then exactly one of
   *  `technique_id`/`free_text` — never both, never neither. Absent on
   *  every other block type. */
  technique_id?: string | null;
  /** The other half of the `technique_drill` XOR — a drill with no catalog
   *  entry ("coach's own variant"). Absent on every other block type. */
  free_text?: string | null;
  /** Resolved from the library on every read, never stored on the block —
   *  so a renamed technique reads correctly everywhere. Absent unless
   *  `technique_id` is set. */
  technique_name?: string;
  technique_position?: string;
  /** The coach's own note. For a `notes` block this IS the block's content;
   *  for every other type it is supplementary detail. */
  notes: string;
};

export type ClassPlan = {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  /** On BOTH the list and the single read, so a card says "6 blocks"
   *  without fetching them. */
  block_count: number;
  /** The sum of every block's duration. Present on both the list and the
   *  single read, so a card says "45 min" without a second fetch. */
  total_duration_minutes: number;
  /** Absent on list responses. Present on a single read whenever the plan
   *  has any blocks, and absent (not `[]`) when it has none — read
   *  `block_count` to tell the two apart, since it is present either way. */
  blocks?: ClassPlanBlock[];
};

/**
 * Every plan you own, newest first. No VOLA-authored or shared rows to merge
 * in — `classplan.go`'s package comment: `owner_user_id` is `NOT NULL`, so
 * this domain has no second source the way `sequence.List` does.
 */
export function listClassPlans(
  getToken: TokenGetter,
  signal?: AbortSignal,
): Promise<ClassPlan[]> {
  return apiRequest<{ class_plans?: ClassPlan[] }>(getToken, '/classplans', { signal }).then(
    (r) => r.class_plans ?? [],
  );
}

export function getClassPlan(
  getToken: TokenGetter,
  id: string,
  signal?: AbortSignal,
): Promise<ClassPlan> {
  return apiRequest<ClassPlan>(getToken, `/classplans/${encodeURIComponent(id)}`, { signal });
}
