import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View as RNView,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { SessionCard } from '@/components/SessionCard';
import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { statsFor, type SessionSummary } from '@/lib/celebration';
import { cardFromSummary, type CardData } from '@/lib/sessionCard';
import { getSessionCard, type SessionCardNumbers } from '@/lib/sessionCardApi';
import { shareCard } from '@/lib/shareCard';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Sharing a session's card, from wherever that session is on screen.
 *
 * This used to live entirely inside `SessionCelebration`, which meant the
 * shareable card existed for about as long as the modal did: dismiss it and
 * the session became unshareable forever. That is the wrong lifetime for the
 * feature — a card is worth posting on the bus home, not only in the ten
 * seconds after racking the bar — so the machinery moved here and the
 * celebration became one of three callers.
 *
 * Three pieces, deliberately separate rather than one component:
 *
 *   - `useSessionShare` holds the state and the capture.
 *   - `ShareSessionButton` is the affordance.
 *   - `ShareCardHost` is the off-screen card the capture reads.
 *
 * They are split because **the host cannot live wherever the button lives.**
 * `captureRef` reads the native view tree, so the card has to be genuinely
 * mounted and laid out — and a `ScrollView` clips its content, so a host
 * parked at `left: -10000` inside one is not a card that is merely invisible,
 * it is a card that may capture blank. Every caller therefore mounts the host
 * at its screen root, as a sibling of the scroll view, and only the button
 * goes in the flow. Both failures here are silent (an empty PNG, or none at
 * all), which is exactly why the placement is a rule rather than a detail.
 */

export type SessionShare = {
  /** Null when there is no session id to key a card off. */
  card: CardData | null;
  cardRef: React.RefObject<RNView | null>;
  sharing: boolean;
  /**
   * A message worth showing, or null. A DISMISSED share sheet never lands
   * here — see `shareCard` for why a dismissal and a failed capture had to
   * stop being the same outcome.
   */
  error: string | null;
  share: () => Promise<void>;
};

export function useSessionShare(opts: {
  /**
   * The session's id. Optional, and everything here degrades to "no share"
   * without it rather than to a broken button: an affordance that is present
   * and cannot work is worse than one that is not there.
   */
  sessionID?: string;
  /**
   * Nullable for the same reason `sessionID` is, and it has to be: this is a
   * hook, so a screen that only sometimes has a finished session to share must
   * still call it unconditionally. Null in, no card out, no button rendered.
   */
  summary?: SessionSummary | null;
  /** Injected so nothing here has to know about unit preferences. */
  formatTonnage: (kg: number) => string;
  /**
   * `carried` means this session is what kept the streak alive.
   *
   * Passed only by the celebration, and that asymmetry is deliberate: a
   * carried streak is a claim about the week the session happened in. Reading
   * a class back three weeks later and recomputing it against *this* week
   * would either re-assert a stale badge or deny one that was genuinely
   * earned, and neither is better than leaving it off the re-shared card.
   */
  streak?: { weeks: number; carried: boolean } | null;
  /**
   * The date to stamp on the card. Defaults to now, which is right for a
   * session that just finished and wrong for every one read back later —
   * without this, sharing last Tuesday's class posts it dated today.
   */
  date?: Date;
}): SessionShare {
  const { sessionID, summary, formatTonnage, streak = null, date } = opts;
  const getToken = useAuthToken();

  const cardRef = useRef<RNView>(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server's numbers, once they arrive. The card is COMPLETE without them
  // — duration, volume and PRs all come from the local store — so this never
  // blocks anything, and a gym dead-spot costs the calorie figure rather than
  // the share.
  const [numbers, setNumbers] = useState<SessionCardNumbers | null>(null);
  useEffect(() => {
    if (!sessionID) return;
    const c = new AbortController();
    getSessionCard(getToken, sessionID, c.signal)
      .then((n) => {
        if (!c.signal.aborted) setNumbers(n);
      })
      .catch(() => {
        // Silent by design. See above: these decorate, they do not carry.
      });
    return () => c.abort();
  }, [sessionID, getToken]);

  const card =
    sessionID && summary
      ? cardFromSummary({
          id: sessionID,
          summary,
          stats: statsFor(summary, formatTonnage),
          streak,
          numbers,
          now: date,
        })
      : null;

  const share = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    setError(null);
    const result = await shareCard(cardRef);
    // A dismissed share sheet is an ordinary outcome and stays quiet; a device
    // that cannot share at all, or an image that was never produced, both get
    // a message.
    if (!result.ok && result.reason !== 'failed') setError(result.message);
    setSharing(false);
  }, [sharing]);

  return { card, cardRef, sharing, error, share };
}

/**
 * The button. Renders nothing when there is no card, so callers do not each
 * repeat the guard.
 */
export function ShareSessionButton({
  share,
  label = 'Share',
  accessibilityLabel = 'Share this session',
  style,
  textStyle,
  testID,
}: {
  share: SessionShare;
  label?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
}) {
  if (!share.card) return null;
  return (
    <Pressable
      onPress={share.share}
      disabled={share.sharing}
      style={[styles.button, style]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: share.sharing, disabled: share.sharing }}
      testID={testID}
    >
      <Text style={[styles.buttonText, textStyle]}>{share.sharing ? 'Preparing…' : label}</Text>
    </Pressable>
  );
}

/**
 * The card the export captures, mounted OFF TO THE SIDE rather than hidden.
 *
 * `captureRef` reads the native view tree, so the card has to be genuinely
 * laid out — `display: none` captures nothing and `opacity: 0` captures blank
 * on some iOS versions, both of which fail silently and hand the athlete an
 * empty image. Positioning it outside the visible bounds keeps it real while
 * keeping it out of the way, and `pointerEvents="none"` stops it eating taps.
 *
 * HIDDEN FROM SCREEN READERS TOO, and that is not the same thing as hidden
 * from the eye. VoiceOver traverses off-screen elements, so without the two
 * props below a VoiceOver user swiping past the button walks straight into an
 * invisible duplicate card and hears the wordmark, the date, every stat and —
 * once the fetch lands — the calorie figure and the score.
 *
 * Mount this at the SCREEN ROOT, never inside a `ScrollView`. See the file
 * comment: a clipped host is a blank capture, and it fails without a word.
 */
export function ShareCardHost({ share }: { share: SessionShare }) {
  // Destructured rather than read as `share.cardRef` at the JSX. Handing a
  // member expression to `ref=` makes `react-hooks/refs` treat the whole
  // `share` object as a ref, after which `share.card` beside it reads as
  // accessing a ref value during render — two warnings for code that does
  // neither. Pulling both out first is what makes them plain locals again.
  const { card, cardRef } = share;
  if (!card) return null;
  return (
    <RNView
      style={styles.offscreen}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <SessionCard ref={cardRef} data={card} width={360} />
    </RNView>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'stretch',
    minHeight: 50,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '700', color: vola.text },
  // Far enough left that no phone shows it, still laid out so it can be
  // captured. See the comment on the host.
  offscreen: { position: 'absolute', left: -10000, top: 0 },
});
