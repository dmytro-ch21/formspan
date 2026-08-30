import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View as RNView,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { SessionCard } from '@/components/SessionCard';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { prBadgeFor, statsFor, type SessionSummary } from '@/lib/celebration';
import { cardFromSummary, type CardData } from '@/lib/sessionCard';
import { getSessionCard, type SessionCardNumbers } from '@/lib/sessionCardApi';
import { CARD_EXPORT_WIDTH, shareCard } from '@/lib/shareCard';
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
  /**
   * Whether the preview is open.
   *
   * `ShareSessionButton` opens it; `ShareCardHost` renders it. The capture
   * itself still reads the off-screen card, not this one — see the host.
   */
  previewing: boolean;
  /** Open the preview. What the Share button does now. */
  preview: () => void;
  /** Close it without sharing. */
  cancel: () => void;
  /** Capture and hand off to the share sheet. */
  share: () => Promise<void>;
  /**
   * The athlete's own photo, once picked (N449, #747) — undefined until then,
   * which is also what `card.backgroundUri` carries, so `SessionCard` falls
   * back to the deterministic mountain with no extra plumbing.
   */
  backgroundUri?: string;
  /** True while the picker/permission/resize sequence is in flight. */
  pickingPhoto: boolean;
  /** Opens the camera when `true`, the library when `false`. */
  pickBackgroundPhoto: (fromCamera: boolean) => Promise<void>;
  /** Back to the deterministic mountain. */
  clearBackgroundPhoto: () => void;
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
   * Same reason `formatTonnage` is injected: this builds the PR badge's
   * evidence ("152kg × 5") in the athlete's own unit system without this
   * hook having to know what that system is.
   */
  formatWeight: (kg: number) => string;
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
  const { sessionID, summary, formatTonnage, formatWeight, streak = null, date } = opts;
  const getToken = useAuthToken();

  const cardRef = useRef<RNView>(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server's numbers, once they arrive. The card is COMPLETE without them
  // — duration, volume and PRs all come from the local store — so this never
  // blocks anything, and a gym dead-spot costs the calorie figure rather than
  // the share.
  // STORED WITH THE ID THEY BELONG TO, and matched at render rather than
  // cleared in the effect.
  //
  // These numbers describe ONE session. A screen instance that moves between
  // sessions — a `router.replace` onto the same route — would otherwise
  // decorate the new card with the previous one's calories and score until the
  // new fetch lands, or permanently if it never does. Resetting to null at the
  // top of the effect fixes that and costs a second render for every mount, and
  // `react-hooks/set-state-in-effect` says so; carrying the id says the same
  // thing with no extra render and no extra state transition. It also closes
  // the half `AbortController` cannot: a response that resolves after the id
  // moved on can no longer be read as this session's.
  const [numbers, setNumbers] = useState<{ id: string; value: SessionCardNumbers } | null>(null);
  useEffect(() => {
    if (!sessionID) return;
    const c = new AbortController();
    getSessionCard(getToken, sessionID, c.signal)
      .then((n) => {
        if (!c.signal.aborted) setNumbers({ id: sessionID, value: n });
      })
      .catch(() => {
        // Silent by design. See above: these decorate, they do not carry.
      });
    return () => c.abort();
  }, [sessionID, getToken]);
  const forThisSession = numbers && numbers.id === sessionID ? numbers.value : null;

  /**
   * The athlete's own photo, in place of the deterministic mountain (N449,
   * #747).
   *
   * Same `{id, value}` shape as `numbers` above, and for the same reason:
   * this describes ONE session, and a screen instance that moves between
   * sessions (`router.replace` onto the same route) must not decorate the
   * new card with the photo picked for the previous one.
   */
  const [background, setBackground] = useState<{ id: string; uri: string } | null>(null);
  const [pickingPhoto, setPickingPhoto] = useState(false);
  const backgroundUri =
    background && sessionID && background.id === sessionID ? background.uri : undefined;

  const card =
    sessionID && summary
      ? {
          ...cardFromSummary({
            id: sessionID,
            summary,
            stats: statsFor(summary, formatTonnage),
            streak,
            numbers: forThisSession,
            prBadge: prBadgeFor(summary.records, formatWeight),
            now: date,
          }),
          backgroundUri,
        }
      : null;

  /*
    The preview, which is the whole of F2.

    The only look an athlete got at this card before posting it was the share
    sheet's thumbnail — about 40pt square. The card carries a CALORIE FIGURE
    INFERRED FROM BODY DATA and a VOLA score, so it was going out sight-unseen:
    numbers about someone's body, published to whichever app they picked, with
    no opportunity to read them first.

    Opening a preview rather than adding a confirm dialog is the point. A dialog
    asks "are you sure" about something you still cannot see; this shows the
    thing.
  */
  const [previewing, setPreviewing] = useState(false);
  const preview = useCallback(() => {
    setError(null);
    setPreviewing(true);
  }, []);
  const cancel = useCallback(() => setPreviewing(false), []);

  /**
   * Ask for a photo and thread it onto the card (N449, #747).
   *
   * Same permission → launch sequence as the app's other four picker sites
   * (`profile/edit.tsx` is the canonical one) — guarded the same way, because
   * both the permission prompt and the picker itself can reject rather than
   * merely resolve `canceled: true` (an OS-level failure, a Simulator with no
   * camera), and this is a `void`-called handler from a `Pressable`.
   *
   * **Not `prepareImageForUpload`.** That helper's 0.8 JPEG compress exists to
   * shrink what crosses the network — nothing here ever does. This photo is
   * rendered locally and captured straight into the exported PNG by
   * `captureRef`, so the only cost worth paying is decoding a full 12MP
   * camera frame into a view that is at most `CARD_EXPORT_WIDTH` px wide.
   * Resizing to that width, at `compress: 1`, keeps the resize without the
   * quality loss the network path pays for and this one has no reason to.
   */
  const pickBackgroundPhoto = useCallback(
    async (fromCamera: boolean) => {
      if (!sessionID || pickingPhoto) return;
      setPickingPhoto(true);
      setError(null);
      try {
        const perm = fromCamera
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          setError(
            fromCamera
              ? 'VOLA needs camera access to take a photo.'
              : 'VOLA needs access to your photos to set one.',
          );
          return;
        }
        const picked = fromCamera
          ? await ImagePicker.launchCameraAsync({ quality: 1 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
        if (picked.canceled || !picked.assets[0]) return;

        const resized = await ImageManipulator.manipulateAsync(
          picked.assets[0].uri,
          [{ resize: { width: CARD_EXPORT_WIDTH } }],
          { compress: 1 },
        );
        setBackground({ id: sessionID, uri: resized.uri });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPickingPhoto(false);
      }
    },
    [sessionID, pickingPhoto],
  );

  /** Back to the deterministic mountain. */
  const clearBackgroundPhoto = useCallback(() => setBackground(null), []);

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
    // Closed only on success. A failure leaves the preview up with its message
    // on it — dropping back to the session screen would hide both the error and
    // the card it is about.
    if (result.ok) setPreviewing(false);
  }, [sharing]);

  return {
    card,
    cardRef,
    sharing,
    error,
    previewing,
    preview,
    cancel,
    share,
    backgroundUri,
    pickingPhoto,
    pickBackgroundPhoto,
    clearBackgroundPhoto,
  };
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
      // Opens the preview; the capture happens from inside it. One line, and
      // it is what makes every caller of this component inherit F2 — the
      // celebration modal, the finished strength session and the BJJ class all
      // go through here.
      onPress={share.preview}
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
  const {
    card,
    cardRef,
    previewing,
    sharing,
    error,
    cancel,
    backgroundUri,
    pickingPhoto,
    pickBackgroundPhoto,
    clearBackgroundPhoto,
  } = share;
  const accent = useAccent();
  const { width } = useWindowDimensions();
  if (!card) return null;

  // The preview is sized to the SCREEN, not to the capture. The exported PNG is
  // always 1080px square (see `shareCard`); this is only about whether a person
  // can read it, so it takes the window minus the scrim's padding and caps out
  // where a card stops gaining anything from being bigger.
  //
  // WIDTH ONLY, which is safe because `app.json` locks the app to portrait: the
  // card is square, so on the narrowest supported phone it is ~335pt tall and
  // the note plus buttons still fit. Lift that lock — tablets and iPad
  // multitasking are the likely pressure — and this needs a height term
  // (`Math.min(width - 40, height - 200, 420)`) or a scroll view, or the
  // buttons go off the bottom in landscape.
  const previewWidth = Math.min(width - PREVIEW_INSET * 2, 420);

  return (
    <>
      {/*
        The card the export captures, mounted OFF TO THE SIDE rather than
        hidden.

        `captureRef` reads the native view tree, so the card has to be genuinely
        laid out — `display: none` captures nothing and `opacity: 0` captures
        blank on some iOS versions, both of which fail silently and hand the
        athlete an empty image. Positioning it outside the visible bounds keeps
        it real while keeping it out of the way, and `pointerEvents="none"` stops
        it eating taps.

        HIDDEN FROM SCREEN READERS TOO, and that is not the same thing as hidden
        from the eye. VoiceOver traverses off-screen elements, so without the two
        props below a VoiceOver user swiping past the button walks straight into
        an invisible duplicate card and hears the wordmark, the date, every stat
        and — once the fetch lands — the calorie figure and the score.

        Mount this at the SCREEN ROOT, never inside a `ScrollView`. See the file
        comment: a clipped host is a blank capture, and it fails without a word.

        **It stays the capture source even while the preview is open**, and the
        card is therefore mounted twice for that moment. Capturing the visible
        one instead would be tidier and is not worth the risk: a card laid out
        inside a `Modal` is exactly the "is it really laid out" question that
        produces blank PNGs, while this path produced a verified 1080x1080
        export off a real device.

        One honest qualification on that measurement: it was taken BEFORE this
        preview existed, so no modal window sat above the off-screen card at
        capture time. `captureRef` renders the target view's own hierarchy
        rather than the screen, so occlusion should not matter — but "should"
        is doing work there, and the first device run of this flow is what
        actually settles it.
      */}
      <RNView
        style={styles.offscreen}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <SessionCard ref={cardRef} data={card} width={360} />
      </RNView>

      <Modal
        transparent
        animationType="fade"
        visible={previewing}
        onRequestClose={cancel}
      >
        <View style={styles.scrim} testID="share-preview">
          <SessionCard data={card} width={previewWidth} />

          {/* Says what the picture cannot: where it is about to go. The card
              shows the numbers; this shows that the next tap leaves the app. */}
          <Text style={styles.previewNote}>
            This is what gets posted. Nothing leaves VOLA until you pick where.
          </Text>

          {/* Swap the deterministic mountain for the athlete's own photo
              (N449, #747). Lives here rather than beside the Share button —
              this is the one place the athlete already sees the frame the
              photo has to fit, the same reason F2 exists as a preview
              instead of a confirm dialog. */}
          <RNView style={styles.photoRow} testID="share-photo-row">
            {pickingPhoto ? (
              <ActivityIndicator accessibilityLabel="Preparing your photo" />
            ) : (
              <>
                <Pressable
                  onPress={() => void pickBackgroundPhoto(true)}
                  disabled={sharing}
                  hitSlop={8}
                  testID="share-photo-camera"
                  accessibilityRole="button"
                  accessibilityLabel="Take a photo for the card"
                  accessibilityState={{ disabled: sharing }}
                >
                  <Text style={[styles.photoAction, { color: accent.ink }]}>Take photo</Text>
                </Pressable>
                <Pressable
                  onPress={() => void pickBackgroundPhoto(false)}
                  disabled={sharing}
                  hitSlop={8}
                  testID="share-photo-library"
                  accessibilityRole="button"
                  accessibilityLabel="Choose a photo from your library"
                  accessibilityState={{ disabled: sharing }}
                >
                  <Text style={[styles.photoAction, { color: accent.ink }]}>
                    {backgroundUri ? 'Replace photo' : 'Choose photo'}
                  </Text>
                </Pressable>
                {!!backgroundUri && (
                  <Pressable
                    onPress={clearBackgroundPhoto}
                    disabled={sharing}
                    hitSlop={8}
                    testID="share-photo-clear"
                    accessibilityRole="button"
                    accessibilityLabel="Use the default background instead"
                    accessibilityState={{ disabled: sharing }}
                  >
                    <Text style={[styles.photoAction, styles.photoClear]}>Use default</Text>
                  </Pressable>
                )}
              </>
            )}
          </RNView>

          {!!error && (
            <Text style={styles.previewError} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}

          <RNView style={styles.previewActions}>
            <Pressable
              onPress={cancel}
              // Disabled mid-capture, AND mid-pick (N449, #747): a Share tap
              // that lands while `pickBackgroundPhoto` is still awaiting the
              // resize would capture the card BEFORE `setBackground` ever
              // runs, exporting the outgoing mountain instead of the photo
              // that was just tapped — the resize is not instant, and a fast
              // double-tap is exactly the timing this closes.
              disabled={sharing || pickingPhoto}
              style={[
                styles.previewCancel,
                (sharing || pickingPhoto) && styles.previewCancelBusy,
              ]}
              accessibilityRole="button"
              accessibilityState={{ disabled: sharing || pickingPhoto }}
              testID="share-preview-cancel"
            >
              <Text style={styles.previewCancelText}>Not now</Text>
            </Pressable>
            <Pressable
              onPress={share.share}
              disabled={sharing || pickingPhoto}
              style={[styles.previewShare, { backgroundColor: accent.accent }]}
              accessibilityRole="button"
              accessibilityLabel="Share this card"
              accessibilityState={{ busy: sharing, disabled: sharing || pickingPhoto }}
              testID="share-preview-confirm"
            >
              <Text style={[styles.previewShareText, { color: accent.on }]}>
                {sharing ? 'Preparing…' : 'Share'}
              </Text>
            </Pressable>
          </RNView>
        </View>
      </Modal>
    </>
  );
}

/** The scrim's horizontal padding, doubled out of the card's available width. */
const PREVIEW_INSET = 20;

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
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(8,11,18,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: PREVIEW_INSET,
    gap: 14,
  },
  previewNote: {
    fontSize: 13,
    color: vola.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
  previewError: { fontSize: 13, color: vola.danger, textAlign: 'center' },
  photoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18 },
  photoAction: { fontSize: 13, fontWeight: '700' },
  photoClear: { color: vola.textMuted },
  // Same shape as the celebration's action row, and for the same reason: the
  // two buttons have to line up, so the row owns the spacing and `stretch`
  // owns the height rather than each button guessing.
  previewActions: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    alignItems: 'stretch',
    gap: 10,
    marginTop: 4,
  },
  previewCancel: {
    flex: 1,
    minHeight: 50,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewCancelText: { fontSize: 16, fontWeight: '700', color: vola.text },
  previewCancelBusy: { opacity: 0.4 },
  previewShare: {
    flex: 1,
    minHeight: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewShareText: { fontSize: 16, fontWeight: '800' },
});
