import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether the OS has been asked not to animate.
 *
 * **Extracted, not invented.** `components/AnimatedSplash.tsx` has carried this
 * exact block since the splash was written, and N108's rings are the second
 * caller — so it moves here rather than being copied, which is the point at
 * which a second copy would start drifting from the first.
 *
 * ## `null` is a third state and it is load-bearing
 *
 * The OS answers asynchronously. Until it does, this is `null` — *not* `false`.
 * A caller that treats "not answered yet" as "motion is fine" runs the very
 * animation the athlete asked not to see, every cold start, because the first
 * frame always precedes the answer. So the contract is: **hold while `null`,
 * do not guess.**
 *
 * ## What reduced motion means here
 *
 * `AnimatedSplash` states it and it is worth restating, because the wrong
 * reading is the tempting one: *Reduce Motion is a request not to be MOVED, not
 * a request to see NOTHING.* A ring that respects it still shows its final
 * value — it simply arrives there rather than sweeping to it. Rendering an
 * empty ring, or no ring, would be answering a different request.
 *
 * ## Why it also listens
 *
 * The splash only ever asked once, which is right for something that plays for
 * a second at launch and is correct for its whole lifetime. A tab screen
 * outlives the Settings trip that changes the setting, so this subscribes as
 * well — otherwise an athlete who turns Reduce Motion ON keeps getting swept
 * rings until they force-quit, which reads as the setting not working.
 */
export function useReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    // The initial read and the subscription race, and the subscription can win.
    // Turning Reduce Motion on during launch fires `reduceMotionChanged` before
    // the promise settles, and the promise then overwrites the newer answer
    // with the older one — leaving the hook asserting the opposite of the
    // setting, permanently, until the next change event. That would quietly
    // undo the whole `null`-state hold below.
    let answered = false;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (alive && !answered) {
          answered = true;
          setReduced(enabled);
        }
      })
      // An OS that will not answer must not cost the caller its content. The
      // splash makes the same call for the same reason: falling back to `false`
      // shows the animation, and showing it to somebody who never asked either
      // way is a far smaller error than showing nothing to everybody.
      .catch(() => {
        if (alive && !answered) {
          answered = true;
          setReduced(false);
        }
      });

    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      if (!alive) return;
      // An event is always newer than the initial read, so it latches.
      answered = true;
      setReduced(enabled);
    });

    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  return reduced;
}
