import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { useAuth } from '@clerk/clerk-expo';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
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
import { fetchExercises, type Exercise } from '@/lib/exercises';
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
 * `confidence` is shown but never thresholded and never re-sorted on. It is not
 * calibrated to correctness — the model has never seen this catalog — so it
 * reads as "how clear was the photo", which helps somebody decide whether to
 * retake it and cannot help anybody decide which exercise this is.
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
    try {
      const matches = await fetchExercises(getToken, { q: exerciseID });
      const exercise: Exercise | undefined =
        matches.find((e) => e.id === exerciseID) ?? undefined;
      if (!exercise) throw new Error('That exercise is no longer in the catalog.');

      const session = await readLocalSession(userId, id);
      if (!session) throw new Error('Session not found on this device.');
      const next = swapping
        ? swapExercise(session.sets, swap, exercise, undefined)
        : [...session.sets, emptySet(exercise.id, session.sets.length)];
      await saveLocalSets(userId, id, next);
      requestSync('exercise-added');
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Text style={styles.errorHint}>
              {retryable ? 'You can try again.' : 'Take another photo, or search instead.'}
            </Text>
          </View>
        ) : null}

        {result ? (
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
  errorText: { fontSize: 14, lineHeight: 20 },
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
