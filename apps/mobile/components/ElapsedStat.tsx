import { useEffect, useState, type ComponentProps } from 'react';

import { Stat } from '@/components/ui/Stat';
import { formatElapsed } from '@/lib/rest';

/**
 * Whole seconds from `startedAt` to `endedAt`, or to `now` while the session
 * is still open.
 *
 * Whole rather than fractional so a tick that lands inside the same second —
 * the mount tick, or an interval that drifted — is a same-value update React
 * skips. `formatElapsed` floors anyway, so nothing on screen differs.
 */
export function elapsedSeconds(startedAt: string, endedAt: string | null, now: number): number {
  const to = endedAt ? new Date(endedAt).getTime() : now;
  return Math.floor((to - new Date(startedAt).getTime()) / 1000);
}

/**
 * The session clock, as a `Stat` that owns its own tick (N566/#1126).
 *
 * How long you've been training. Derived from `startedAt` on every tick rather
 * than accumulated, for the same reason the rest timer is: a counter stops when
 * the JS thread is throttled, and a session spends most of its life with the
 * phone in a pocket. A finished session's duration is fixed, so it does not
 * tick at all.
 *
 * **Why this is a component and not a line in the session screen.** The state
 * used to be `useState` in `app/session/[id].tsx`, so the 1s interval
 * re-rendered that whole screen — every exercise group and every set row —
 * once a second for the life of every live session, to repaint four digits.
 * Owning the state here means only this `Stat` re-renders on a tick. Same move
 * N558 made for the rest countdown (`RemainingClock` in `Countdown.tsx`).
 *
 * Every other prop goes straight to `Stat`, including the `slots` `StatRow`
 * injects with `cloneElement` — a wrapper that dropped it would lose the
 * four-column fit ladder on a finished session's row.
 */
export function ElapsedStat({
  startedAt,
  endedAt,
  ...stat
}: { startedAt: string; endedAt: string | null } & Omit<ComponentProps<typeof Stat>, 'value'>) {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(startedAt, endedAt, Date.now()));
  useEffect(() => {
    const tick = () => setSeconds(elapsedSeconds(startedAt, endedAt, Date.now()));
    tick();
    if (endedAt) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt, endedAt]);

  return <Stat {...stat} value={formatElapsed(seconds)} />;
}
