import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View as RNView,
} from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { ApiError } from '@/lib/apiError';
import { playSound } from '@/lib/sounds';
import { listFriends, type FriendCard } from '@/lib/friends';
import { shareResource } from '@/lib/shares';
import { useAccent } from '@/lib/AccentProvider';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Send this thing to a training partner.
 *
 * **A friend PICKER, not a handle field** — the same product decision web's
 * copy of this holds, and for the same reason: you can only share with people
 * who already agreed to hear from you, so typing a handle could produce a
 * friend you could have picked from a list, or a 404. A text input invites the
 * second and teaches nothing. (It would also want a keyboard, which is the
 * thing this app tries hardest not to need mid-session.)
 *
 * Generic on `resourceType`/`resourceId`, because the API is one surface for
 * everything shareable — sequences will mount this unchanged.
 *
 * The API's 404 covers "not your friend", "no such handle" and "not yours to
 * send" alike, deliberately, so the copy here cannot be more specific than the
 * server is willing to be.
 *
 * ## What it sends is what the SERVER holds
 *
 * Not what is on screen. A workout with unsaved edits is the live case, which
 * is why `disabled` exists and why the caller passes its own dirty flag — the
 * same gate "Start session" already has, for the same reason. Sharing a plan
 * you have just reordered and handing over the old order is the kind of wrong
 * nobody would ever report, because both people believe it worked.
 */
export function ShareToFriend({
  resourceType,
  resourceId,
  disabled = false,
  disabledReason,
  testID,
}: {
  resourceType: string;
  resourceId: string;
  disabled?: boolean;
  disabledReason?: string;
  testID?: string;
}) {
  const getToken = useAuthToken();
  const accent = useAccent();
  const [open, setOpen] = useState(false);
  const [friends, setFriends] = useState<FriendCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);

  // Loaded on OPEN rather than on mount: most visits to a plan are not visits
  // to share it, and the friends list is somebody else's data to fetch only
  // when it is about to be shown.
  useEffect(() => {
    if (!open || friends !== null) return;
    const c = new AbortController();
    listFriends(getToken, c.signal)
      .then((rows) => {
        if (c.signal.aborted) return;
        setFriends(rows);
        // Cleared on SUCCESS. A failed load otherwise leaves its error sitting
        // above a working list after the retry.
        setError(null);
      })
      .catch((err: unknown) => {
        if (c.signal.aborted || (err as Error)?.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => c.abort();
  }, [open, friends, getToken, attempt]);

  const send = useCallback(
    async (username: string) => {
      setSending(username);
      setError(null);
      try {
        await shareResource(getToken, username, resourceType, resourceId);
        setSentTo((prev) => [...prev, username]);
        // The one place a send is confirmed. There is no toast in this app —
        // the only other signal is a row quietly changing to "Sent", which is
        // easy to miss on a list you are about to close.
        playSound('success');
      } catch (err) {
        // A 409 says it is ALREADY sitting unanswered in their inbox — the
        // outcome the sender wanted. Reporting it in red would make a no-op
        // look like a failure. `code` is contract; the message is not.
        if (err instanceof ApiError && err.code === 'already_exists') {
          setSentTo((prev) => [...prev, username]);
          // Chimes here too. A 409 means it is ALREADY in their inbox, which
          // is the outcome the sender wanted — the UI already treats the two
          // identically, and a silent success would read as the tap missing.
          playSound('success');
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setSending(null);
      }
    },
    [getToken, resourceType, resourceId],
  );

  // Reset rather than merely hide, matching web's copy: `visible={open &&
  // !disabled}` alone leaves `open` true behind a hidden sheet, so re-enabling
  // the button pops it open again with nobody having asked. During render, not
  // in an effect — this is derivation, and `react-hooks/set-state-in-effect`
  // is right to object to the effect version.
  if (open && disabled) setOpen(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        style={[styles.trigger, { borderColor: accent.accent }, disabled && styles.disabled]}
        accessibilityRole="button"
        // The reason is IN THE LABEL, not only in a hint. A disabled control
        // with no explanation is indistinguishable from a broken one, and a
        // `accessibilityHint` on a disabled element is not reliably announced.
        accessibilityLabel={disabled && disabledReason ? `Share. ${disabledReason}` : 'Share'}
        accessibilityState={{ disabled }}
        testID={testID ?? 'share-open'}
      >
        <Text style={[styles.triggerText, { color: accent.ink }]}>Share</Text>
      </Pressable>
      {/* Said where it applies rather than inside a sheet you cannot open. */}
      {disabled && disabledReason && (
        <Text
          style={styles.reason}
          // The button's accessibilityLabel already carries this sentence, and
          // it has to — a `title`-style hint is not reliably announced on a
          // disabled control. Left visible here for everyone else, and hidden
          // from assistive tech so it is not read out twice in a row.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="share-disabled-reason"
        >
          {disabledReason}
        </Text>
      )}

      <Modal
        // `visible={open && !disabled}` rather than `open`, so going disabled
        // while the sheet is up does not leave it over a control that can no
        // longer close it. The render-time reset above is what stops `open`
        // going stale behind it.
        visible={open && !disabled}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        {/*
          The backdrop is a SIBLING of the sheet, not its parent, and that is
          not a style choice.

          The first version wrapped everything in one `Pressable` scrim with
          `accessibilityRole="button"` and a "Close" label. An accessibility
          element does not expose its descendants on iOS, so VoiceOver reads
          the whole sheet as a single screen-sized "Close" button — friend
          rows, retry and Done all unreachable. `app/library.tsx`
          records this exact bug and this exact fix ("opening the sheet
          announced 'Close filter options, button' instead of the sheet").

          A dimming view is not an element by Apple's own convention.
          Dismissal is the Done button and the two-finger escape, both of which
          this sheet has. As a sibling it also needs no
          `onStartShouldSetResponder` trick to stop taps falling through.
        */}
        <Pressable
          style={styles.backdrop}
          onPress={() => setOpen(false)}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID="share-backdrop"
        />
        <RNView
          style={styles.sheetWrap}
          // `box-none` so the wrapper itself does not eat the taps meant for
          // the backdrop behind it.
          pointerEvents="box-none"
          // `transparent` is an over-full-screen presentation, so the screen
          // behind stays in the hierarchy. This is the prop that makes focus
          // containment certain rather than likely — and it works HERE
          // because the wrapper now has a sibling to hide.
          accessibilityViewIsModal
          onAccessibilityEscape={() => setOpen(false)}
        >
            <View style={styles.sheet} testID="share-sheet">
              <Text style={styles.heading}>Send a copy to</Text>

              {error && (
                <RNView style={styles.errorBlock}>
                  <Text style={styles.error} accessibilityLiveRegion="polite">
                    {error}
                  </Text>
                  {friends === null && (
                    // Reachable only for a failed LOAD. Without it the only
                    // retry is close-and-reopen, which nothing announces.
                    <Pressable
                      onPress={() => setAttempt((n) => n + 1)}
                      accessibilityRole="button"
                      testID="share-retry"
                    >
                      <Text style={[styles.retry, { color: accent.ink }]}>Try again</Text>
                    </Pressable>
                  )}
                </RNView>
              )}

              {/* null is LOADING and [] is "no friends yet". A failed load must
                  render as NEITHER — it renders as the error above, because
                  "you have no friends" is a cruel way to say "we could not
                  ask". */}
              {friends === null && !error && (
                <ActivityIndicator style={styles.loader} accessibilityLabel="Loading friends" />
              )}

              {friends?.length === 0 && (
                <Text style={styles.muted}>
                  Nobody yet. Add a training partner from your profile, then send them this.
                </Text>
              )}

              {/* BOUNDED AND SCROLLABLE, matching web's `max-h-64 overflow-y-auto`.
                  Unbounded, a long enough list pushes the top rows off the top
                  of the screen — not merely cramped, unreachable, since the
                  sheet is anchored to the bottom and has no scroll of its own.
                  The footnote and Done must stay visible for the same reason. */}
              <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
                {friends?.map((f) => {
                  const sent = sentTo.includes(f.username);
                  return (
                    <Pressable
                      key={f.username}
                      onPress={() => send(f.username)}
                      disabled={sending !== null || sent}
                      style={[styles.row, (sending !== null || sent) && styles.rowBusy]}
                      accessibilityRole="button"
                      accessibilityLabel={
                        sent ? `Sent to ${f.username}` : `Send to ${f.username}`
                      }
                      accessibilityState={{
                        disabled: sending !== null || sent,
                        busy: sending === f.username,
                      }}
                      testID={`share-to-${f.username}`}
                    >
                      <RNView style={styles.rowBody}>
                        <Text style={styles.handle} numberOfLines={1}>
                          @{f.username}
                        </Text>
                        {f.display_name && (
                          <Text style={styles.muted} numberOfLines={1}>
                            {f.display_name}
                          </Text>
                        )}
                      </RNView>
                      <Text
                        style={[styles.state, sent && { color: accent.ink }]}
                        accessibilityLiveRegion="polite"
                      >
                        {sending === f.username ? 'Sending…' : sent ? 'Sent ✓' : ''}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {/* Said once, here, rather than in a hint nobody opens: it is the
                  property that makes a share safe to accept. */}
              <Text style={styles.footnote}>
                They get their own copy. Your later edits stay yours.
              </Text>

              <Pressable
                onPress={() => setOpen(false)}
                style={styles.close}
                accessibilityRole="button"
                testID="share-close"
              >
                <Text style={styles.closeText}>Done</Text>
              </Pressable>
            </View>
        </RNView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  triggerText: { fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  reason: { fontSize: 12, color: vola.textMuted, textAlign: 'center', marginTop: -4 },

  // Absolutely positioned rather than a flex parent, because it is now the
  // sheet's SIBLING — see the comment at the Modal.
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(8,11,18,0.86)',
  },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', padding: 16, paddingBottom: 32 },
  sheet: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
    padding: 18,
    gap: 8,
  },
  heading: {
    fontSize: 11,
    fontWeight: '800',
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  errorBlock: { gap: 4 },
  error: { fontSize: 13, color: vola.danger },
  retry: { fontSize: 13, fontWeight: '700' },
  loader: { alignSelf: 'flex-start', marginVertical: 8 },
  muted: { fontSize: 12, color: vola.textMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  // Web's `max-h-64`. Anything taller and the top of the list leaves the
  // screen, taking its rows with it.
  list: { maxHeight: 260 },
  rowBusy: { opacity: 0.6 },
  rowBody: { flex: 1, minWidth: 0 },
  handle: { fontSize: 15, fontWeight: '700' },
  state: { fontSize: 12, color: vola.textMuted },
  footnote: {
    fontSize: 12,
    color: vola.textMuted,
    borderTopWidth: 1,
    borderTopColor: vola.line,
    paddingTop: 10,
    marginTop: 2,
  },
  close: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 24 },
  closeText: { fontSize: 15, fontWeight: '700', color: vola.textMuted },
});
