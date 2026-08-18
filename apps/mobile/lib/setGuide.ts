/**
 * What a set type or a grip actually means — the copy behind the info panel.
 *
 * The set editor's two selects offer up to twelve options between them, and
 * until now every one was a bare word. "Back-off" and "Hook" are jargon: an
 * athlete who does not already know what they mean has no way to find out from
 * inside the app, so the honest options are to guess or to leave the field
 * unrecorded. Both are worse than a sentence.
 *
 * ## Data, not JSX
 *
 * The strings live here rather than in the component for the same reason
 * `celebration.ts` holds the card's numbers: the popover that swaps to a
 * definition is one presentation of this, and the template editor on web will
 * want the same sentences. A component that owns its copy cannot be reused and
 * cannot be tested without rendering.
 *
 * ## Every lookup is TOTAL, and for grips that is load-bearing
 *
 * `gripGuide` accepts a `string`, not a `Grip`, and always returns something.
 * That mirrors {@link offeredGrips}, which deliberately renders a grip this
 * build does not know about — the server decides how many grips exist (#256),
 * so a set can legitimately carry `sumo` on a build whose union stops at
 * `hook`. A partial lookup would make that option the one in the list that
 * crashes on long-press, and it is exactly the one an athlete is most likely
 * to ask about.
 *
 * `setTypeGuide` is total for the weaker reason that it costs nothing to be.
 *
 * ## What the copy is allowed to claim
 *
 * Only the two behaviours the code actually implements, both verified against
 * `contributesVolume` / `countsAsSet`:
 *
 *  - **Warm-up** adds neither tonnage nor a set to the count.
 *  - **A drop** adds tonnage but is not counted as a set.
 *
 * `backoff`, `amrap` and `failure` change nothing the app computes today —
 * they are labels on your own history — and the copy says so rather than
 * implying a progression rule that does not exist. If one of them ever gains
 * behaviour, its sentence here is part of that change.
 */

import type { Grip, SetType } from './sessions';
import { GRIPS, SET_TYPES } from './sessions';

export type GuideEntry = {
  title: string;
  body: string;
};

const SET_TYPE_BODY: Record<SetType, string> = {
  warmup:
    'Lighter work that prepares the movement. It counts as neither tonnage nor a set, so a long warm-up never inflates what the session says you did.',
  working:
    'The sets the session is actually for. These are what tonnage, the set count and your history are built from.',
  backoff:
    'A lighter set taken after your heaviest one, for volume without the fatigue of repeating a top set. It counts exactly like a working set — the label is for reading your own history back.',
  drop:
    'The same movement again immediately, at a lower weight, with no rest. It hangs off the set above rather than counting as a set of its own, but the work still adds to your tonnage.',
  amrap:
    'As many reps as possible — stop at the last rep you can finish cleanly. It counts exactly like a working set; the label records that the number was open-ended rather than prescribed.',
  failure:
    'Taken until the next rep will not move. Log the reps you completed. It counts exactly like a working set; the label records how it ended.',
};

const GRIP_BODY: Record<Grip, string> = {
  regular: 'Palms over the bar, knuckles up — pronated. The default for most pressing and pulling.',
  neutral:
    'Palms facing each other, as on a hex bar or parallel handles. Usually the kindest option for a sore shoulder or elbow.',
  reverse:
    'Palms under the bar — supinated. On a pull it brings the biceps in; on a press it changes where the load sits at the shoulder.',
  angled:
    'A partly rotated grip, somewhere between regular and neutral. The handle sets the angle rather than you — a cambered bar, a multi-grip attachment, an angled row handle.',
  mixed:
    'One palm over, one under. It stops a heavy bar rolling out of the fingers, which is why it belongs on a deadlift and nowhere overhead.',
  hook: 'Thumb trapped under the first two fingers, against the bar. It holds far more than a regular grip and it hurts until it does not.',
};

/**
 * What a grip this build has never heard of says about itself.
 *
 * Deliberately not an apology and not an error. A newer server's grip is a
 * real, valid value that this app is holding correctly and sending back
 * correctly; the only thing missing is the sentence describing it. Saying "not
 * available" would read as "your data is broken".
 */
const UNKNOWN = 'Recorded on this set. This version of the app has no description for it yet.';

/**
 * Title and body for a set type.
 *
 * The title comes from `SET_TYPES` rather than being duplicated here, so a
 * relabelled pill and its info panel cannot drift apart — the sheet is opened
 * from the pill and reading two different names for one thing is worse than
 * reading none.
 */
export function setTypeGuide(key: string): GuideEntry {
  const title = SET_TYPES.find((t) => t.key === key)?.label ?? key;
  const body = SET_TYPE_BODY[key as SetType];
  return { title, body: body ?? UNKNOWN };
}

/** Title and body for a grip. Total over unknown keys — see the module note. */
export function gripGuide(key: string): GuideEntry {
  const title = GRIPS.find((g) => g.key === key)?.label ?? key;
  const body = GRIP_BODY[key as Grip];
  return { title, body: body ?? UNKNOWN };
}
