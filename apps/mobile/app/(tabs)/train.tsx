import { Redirect } from 'expo-router';

/**
 * Train — retired, and kept only so its links still land somewhere sensible.
 *
 * ## What happened
 *
 * N176 gave Train a tab slot. The user carried that bar on their own phone and
 * reversed it:
 *
 * > "in fact Train tab which is instead of food is way less useful not sure
 * > what was the purpose"
 *
 * N180 (#585) took the button away and left the route declared, with `href:
 * null`, so `vola://train` and any in-flight `router.push` still resolve. This
 * ticket (N182, #587) was to decide where Train's four blocks go. The answer,
 * measured against `f503c345` rather than assumed, is that **all four were
 * already somewhere else**, on a screen that has a button:
 *
 * | Train's block | Where it already lives |
 * |---|---|
 * | `Resume` | Today's `resume-session` card — same `STALE_SESSION_MS`, imported from `lib/trainBoard.ts` by both |
 * | `Today` | Today's `today-plan-*` `UpNextCard`s, from the same `owedOn` derivation |
 * | `Quick start` | Today's floating **New log** pill → `PickSessionSheet` → the same `startSessionHref` |
 * | `Recent` | Today's `Recent` section — same `SessionCard`, same heading |
 * | `Later` | Plan's `WeekPlanner` rows, from the same `planned_sessions` table — plus the `Beyond this week` block N182 added there for the one case the week cannot show |
 *
 * A screen with no button whose every block is drawn better elsewhere does not
 * have a job. Rendering it anyway is the thing #587's own criteria forbid: two
 * surfaces answering one question, free to disagree.
 *
 * ## Why a redirect and not a deletion, and not a signpost
 *
 * **Not deleted**, because the route has to keep resolving — `lib/tabs.ts`
 * still lists it in `OFF_BAR_ROUTES`, and a route file that disappears takes
 * every `vola://train` link with it.
 *
 * **Not a signpost screen** ("Train has moved…"), because the athlete who taps
 * an old link never knew the screen had a name. They wanted to train. Today is
 * the screen that answers that — it holds the resume card, the day's planned
 * sessions and New log — so sending them there costs no taps and explains
 * nothing they did not already understand.
 *
 * ## If you are tempted to put content back here
 *
 * Ask what it would say that Today and Plan do not. That question is what
 * retired this screen, and N177's original version answered it with four blocks
 * that all had an owner elsewhere. `lib/trainBoard.ts` and `lib/useTrainBoard.ts`
 * survive and are used — Plan reads `later` from them, `app/(tabs)/index.tsx`
 * reads `STALE_SESSION_MS` — so the derivation N177 got right was kept; only the
 * duplicate rendering of it was dropped.
 */
export default function TrainScreen() {
  return <Redirect href="/(tabs)" />;
}
