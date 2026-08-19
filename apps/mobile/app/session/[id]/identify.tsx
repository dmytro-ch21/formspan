import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { useAuth } from '@clerk/clerk-expo';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { isNotFound } from '@/lib/apiError';
import { useAccent } from '@/lib/AccentProvider';
import { useAuthToken } from '@/lib/useAuthToken';
import {
  identifyErrorMessage,
  identifyMachine,
  isRetryable,
  type MachineIdentification,
} from '@/lib/identifyApi';
import { emptySet, swapExercise } from '@/lib/sessions';
import { readLocalSession, saveLocalSets } from '@/lib/sessionStore';
import { fetchExercise, type Exercise } from '@/lib/exercises';
import { request as requestSync } from '@/lib/sync';

/**
 * Point the camera at a machine you cannot name (N44).
 *
 * The mobile half of N7, and unambiguously a phone thing under the platform
 * rule: it is done standing in front of a machine, mid-session, one-handed.
 *
 * # The rule this screen exists to obey
 *
 * **The top candidate is NOT pre-selected, and must never become so.**
 *
 * The server hands back up to four coherent, catalog-validated, deduplicated
 * candidates. Nothing on the server can tell a correct `seated-cable-row` from
 * a plausible wrong one — but the athlete standing in front of the machine can,
 * which is the entire reason a shortlist comes back instead of an answer.
 *
 * Pre-selecting the first one looks like good UX and quietly destroys that: an
 * athlete who taps confirm on a pre-selected wrong answer has logged the wrong
 * exercise **without ever making a choice**, and neither they nor the server
 * can tell afterwards. That is the same invisible-error failure as N40's
 * doubled quantity — the dangerous outcome is the one that looks like an
 * answer. Every candidate here is an equal, deliberate tap.
 *
 * `confidence` is deliberately **not shown**, and never thresholded or
 * re-sorted on. This paragraph used to claim it was displayed and the code has
 * never displayed it; review caught the mismatch (N47), and correcting the
 * claim is the right way round rather than adding the number.
 *
 * The reason is the rule above. `MachineCandidate.confidence` is per candidate,
 * and it is not calibrated to correctness — the model has never seen this
 * catalog — so at best it means "how clearly can I see a machine". Four
 * differing numbers, one beside each choice, at the exact moment of choosing,
 * would be read as a ranking no matter what it is called. That is a "best
 * match" badge in all but name, and the note above says why one must not exist.
 * The client contract sanctions both ("display it or ignore it"), so ignoring
 * it is a choice this screen is entitled to make and now says it makes.
 */
export default function IdentifyMachineScreen() {
  const { id, swap } = useLocalSearchParams<{ id: string; swap?: string }>();
  const getToken = useAuthToken();
  const accent = useAccent();
  const { userId } = useAuth();
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [result, setResult] = useState<MachineIdentification | null>(null);
  const [committing, setCommitting] = useState<string | null>(null);

  const swapping = typeof swap === 'string' && swap.length > 0;

  const photograph = useCallback(async () => {
    if (busy) return;
    // Guarded, because the caller is `void photograph()`: a throw from the
    // permission prompt or the camera (already open, OS-level failure) would
    // otherwise be an unhandled rejection, and the observable is a button that
    // does nothing at all with no error shown. Same reasoning as food/describe.
    let picked: ImagePicker.ImagePickerResult;
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setError('VOLA needs the camera to photograph a machine. You can turn it on in Settings.');
        setRetryable(false);
        return;
      }
      picked = await ImagePicker.launchCameraAsync({ quality: 1 });
    } catch {
      setError('The camera would not open. Try again, or search for the exercise instead.');
      setRetryable(true);
      return;
    }
    if (picked.canceled || !picked.assets[0]) return;

    const asset = picked.assets[0];
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await identifyMachine(getToken, {
        uri: asset.uri,
        mimeType: asset.mimeType ?? 'image/jpeg',
      });
      setResult(res.identification);
    } catch (err) {
      setError(identifyErrorMessage(err));
      // A 422 is DETERMINISTIC — the same photo yields the same refusal — so
      // the screen offers "Take another" rather than "Try again". One word
      // apart, opposite in effect: a retry button there cannot work.
      setRetryable(isRetryable(err));
    } finally {
      setBusy(false);
    }
  }, [busy, getToken]);

  /**
   * Commit the athlete's choice.
   *
   * The candidate carries an id and a name, but the session needs the full
   * catalog row — `load_type` decides which inputs a set renders, and a swap
   * needs it to know whether existing numbers can carry over. Fetched by id
   * rather than trusted from the response, so the session is built from the
   * catalog exactly as the search path builds it.
   */
  async function choose(exerciseID: string) {
    if (!id || !userId || committing) return;
    setCommitting(exerciseID);
    setError(null);
    try {
      // BY ID. This used to put the id through the NAME search and then find
      // the id in the results, which held only while ids stayed slugs of names
      // — and renaming an exercise deliberately keeps its id, so the first
      // diverged name would have reported an exercise the server had just
      // returned as missing from the catalog. See `fetchExercise`.
      let exercise: Exercise;
      try {
        exercise = await fetchExercise(getToken, exerciseID);
      } catch (err) {
        // "Gone" and "could not ask" are different answers and only one of
        // them is about the catalog. Saying the first when the second is true
        // is a confident false statement, which is the failure this whole
        // screen is shaped around.
        throw new Error(
          isNotFound(err)
            ? 'That exercise is no longer in the catalog.'
            : 'Could not load that exercise. Try again when you have signal, or search for it by name.',
        );
      }

      const session = await readLocalSession(userId, id);
      if (!session) throw new Error('Session not found on this device.');
      // The exercise being replaced, so `swapExercise` can tell whether the
      // logged numbers carry over. Passing `undefined` made `sameShape` always
      // false and wiped reps and weight even between two `weight_reps`
      // machines — the row is fetched anyway, and this is the reason the
      // comment above says it is. A failure here is NOT fatal: losing the
      // carry-over is worse than nothing but far better than refusing the
      // swap, so it falls back to the old conservative behaviour.
      let fromLoadType: Exercise['load_type'] | undefined;
      if (swapping) {
        fromLoadType = await fetchExercise(getToken, swap)
          .then((e) => e.load_type)
          .catch(() => undefined);
      }
      const next = swapping
        ? swapExercise(session.sets, swap, exercise, fromLoadType)
        : [...session.sets, emptySet(exercise.id, session.sets.length)];
      await saveLocalSets(userId, id, next);
      requestSync('exercise-added');
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A commit failure is not the photo's fault, and `retryable` is about the
      // IDENTIFICATION. Left as it was, a stale `true` from an earlier network
      // failure renders "You can try again." under "Session not found on this
      // device", which is a hint that contradicts its own message.
      setRetryable(false);
      setCommitting(null);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'What is this machine?' }} />
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.lead}>
          Photograph the whole machine, straight on, with its label in frame if it has one.
        </Text>
        {/* The disclosure, BEFORE the camera opens rather than after — N26's
            rule, and it is the athlete's photo leaving their device. */}
        <Text style={styles.disclosure}>
          The photo is sent to VOLA to identify the machine and is not stored.
        </Text>

        <Pressable
          onPress={() => void photograph()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Take a photo of the machine"
          style={[styles.shoot, { backgroundColor: accent.accent }, busy && styles.shootBusy]}
        >
          {busy ? <ActivityIndicator /> : <Text style={[styles.shootText, { color: accent.on }]}>Take a photo</Text>}
        </Pressable>

        {/* Announced, and coloured. It rendered in the same weight as the lead
            copy while both sibling screens use `vola.danger`, and a VoiceOver
            user standing at the machine got no announcement at all that
            identify had failed — which matters most in exactly the
            one-handed-in-a-gym case this screen is designed for. */}
        {error ? (
          <View style={styles.errorBox} accessibilityLiveRegion="assertive">
            <Text style={styles.errorText} testID="identify-error">
              {error}
            </Text>
            <Text style={styles.errorHint}>
              {retryable ? 'You can try again.' : 'Take another photo, or search instead.'}
            </Text>
          </View>
        ) : null}

        {/* `candidates.length > 0`, not just `result`. The contract says an
            empty list is a 422 and never a 200, so this is defence against the
            contract being violated rather than against a case that happens
            today — but the failure mode if it ever is would be the worst kind
            here: a heading reading "Looks like a cable stack. Which one is
            it?" above nothing at all, which is answer-shaped and answers
            nothing. Absence must say it is absence. */}
        {result && result.candidates.length === 0 ? (
          <Text style={styles.none} testID="identify-empty">
            That looks like a {result.equipment.replace(/-/g, ' ')}, but nothing in the catalog
            matched it. Go back and search for it by name.
          </Text>
        ) : null}

        {result && result.candidates.length > 0 ? (
          <View style={styles.results}>
            <Text style={styles.resultsHead}>
              Looks like a {result.equipment.replace(/-/g, ' ')}. Which one is it?
            </Text>
            {/* No default selection, no highlighted first row, no "best match"
                badge. Every candidate is an equal tap — see the note at the top
                of this file for why that is load-bearing rather than styling. */}
            {result.candidates.map((c) => (
              <Pressable
                key={c.exercise_id}
                onPress={() => void choose(c.exercise_id)}
                disabled={committing !== null}
                accessibilityRole="button"
                accessibilityLabel={c.name}
                style={styles.candidate}
              >
                <Text style={styles.candidateName}>{c.name}</Text>
                {committing === c.exercise_id ? <ActivityIndicator /> : null}
              </Pressable>
            ))}
            <Text style={styles.none}>
              None of these? Go back and search for it by name.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12 },
  lead: { fontSize: 15, lineHeight: 21 },
  disclosure: { fontSize: 12, opacity: 0.7, lineHeight: 17 },
  shoot: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  shootBusy: { opacity: 0.6 },
  shootText: { fontWeight: '600', fontSize: 16 },
  errorBox: { gap: 4, paddingVertical: 8 },
  errorText: { fontSize: 14, lineHeight: 20, color: vola.danger },
  errorHint: { fontSize: 12, opacity: 0.7 },
  results: { gap: 8, marginTop: 8 },
  resultsHead: { fontSize: 14, opacity: 0.8, marginBottom: 2 },
  candidate: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.line,
  },
  candidateName: { fontSize: 16, flexShrink: 1 },
  none: { fontSize: 12, opacity: 0.7, marginTop: 6 },
});
