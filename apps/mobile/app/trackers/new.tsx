import { useAuth } from '@clerk/clerk-expo';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import {
  TrackerForm,
  emptyForm,
  readDraft,
  type TrackerFormState,
} from '@/components/TrackerForm';
import { trackerFill, vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { isOffline } from '@/lib/apiError';
import { request as requestSync } from '@/lib/sync';
import { cacheTracker, createTrackerLocally, MAX_LIVE_TRACKERS } from '@/lib/trackers';
import * as api from '@/lib/trackersApi';
import { useAuthToken } from '@/lib/useAuthToken';
import { useUnits } from '@/lib/useUnits';

/**
 * Name a thing and start tracking it, ON THE PHONE.
 *
 * N78's first acceptance criterion is that an athlete can create, edit, reorder
 * and archive a tracker entirely here — "mobile-first is a hard rule and this
 * is authoring, which is exactly the kind of thing that historically drifted to
 * web only". There is no web counterpart, and in this direction that is fine:
 * the rule forbids phone-impossible, not web-absent.
 *
 * ## Two ways in, and they behave differently offline
 *
 * - **A tracker you describe** is written to SQLite and returned from
 *   immediately. The id is generated on the device, so the push is idempotent
 *   and the whole flow works in a gym with no signal.
 * - **A preset you turn on** needs the network, and cannot not. Its id is
 *   DERIVED from the athlete's user id server-side, which is what makes
 *   provisioning idempotent across devices; a phone that minted its own would
 *   create a second row the moment the real one arrived. So the section is
 *   hidden when the catalogue cannot be read, rather than offering a button
 *   that fails.
 *
 * That asymmetry is stated on the screen, not hidden: the offline case shows
 * nothing rather than a dead control.
 */
export default function NewTrackerScreen() {
  const router = useRouter();
  const accent = useAccent();
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const { units, unitsReady } = useUnits();

  const [form, setForm] = useState<TrackerFormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [presets, setPresets] = useState<api.TrackerPreset[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void api
        .listTrackerPresets(getToken)
        .then((p) => {
          if (live) setPresets(p);
        })
        .catch(() => {
          // Offline, or the endpoint is unreachable. The section simply does
          // not appear — see the header. Never an error banner: the athlete
          // came here to create something and can still do that.
          if (live) setPresets([]);
        });
      return () => {
        live = false;
      };
    }, [getToken]),
  );

  async function create() {
    if (!userId || saving) return;
    const read = readDraft(form, units);
    if ('error' in read) {
      setError(read.error);
      return;
    }
    setSaving(true);
    try {
      await createTrackerLocally(userId, read.draft);
      requestSync('tracker created');
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be saved.');
      setSaving(false);
    }
  }

  async function turnOn(preset: api.TrackerPreset) {
    if (saving || !userId) return;
    setSaving(true);
    try {
      const row = await api.addTrackerPreset(getToken, preset.preset);
      // **Cache the response before navigating.** `requestSync` only PUSHES —
      // there is no pull — and the screen we return to reads SQLite, so without
      // this the athlete taps "Coffee", lands back on the list they came from,
      // and it is not there. The row the server just handed us is the answer;
      // asking for it again would be a second request for something we hold.
      await cacheTracker(userId, row);
      requestSync('tracker preset added');
      router.back();
    } catch (err) {
      setError(
        isOffline(err)
          ? `${preset.name} is set up by VOLA, so turning it on needs a connection. ` +
              `A tracker you describe yourself works offline.`
          : err instanceof Error
            ? err.message
            : 'That could not be turned on.',
      );
      setSaving(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'New tracker' }} />
      <KeyboardAwareScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {presets && presets.length > 0 ? (
          <View style={styles.presets}>
            <Text style={styles.sectionLabel}>Ready to go</Text>
            {presets.map((p) => (
              <Pressable
                key={p.preset}
                onPress={() => void turnOn(p)}
                style={styles.preset}
                accessibilityRole="button"
                accessibilityLabel={`Start tracking ${p.name}`}
                testID={`tracker-preset-${p.preset}`}
              >
                <View style={[styles.presetDot, { backgroundColor: trackerFill(p.color_key) }]} />
                <Text style={styles.presetName}>
                  {p.icon ? `${p.icon}  ` : ''}
                  {p.name}
                </Text>
              </Pressable>
            ))}
            <Text style={styles.sectionLabel}>Or describe your own</Text>
          </View>
        ) : null}

        {unitsReady ? (
          <TrackerForm value={form} onChange={setForm} units={units} />
        ) : (
          // Never print a unit-bearing field before the preference has been
          // read: the increment field is labelled `ml` or `fl oz`, and showing
          // the wrong one is how a 500 ml bottle gets stored as 500 fl oz.
          <Text style={styles.note} testID="tracker-new-loading">
            Loading…
          </Text>
        )}

        {error ? (
          <Text style={styles.error} testID="tracker-new-error">
            {error}
          </Text>
        ) : null}

        <Pressable
          onPress={() => void create()}
          disabled={saving || !unitsReady}
          style={[styles.save, { backgroundColor: accent.accent }, saving && styles.saving]}
          accessibilityRole="button"
          accessibilityState={{ disabled: saving || !unitsReady }}
          testID="tracker-new-save"
        >
          <Text style={[styles.saveText, { color: accent.on }]}>Start tracking it</Text>
        </Pressable>
        <Text style={styles.hint}>
          {`You can track ${MAX_LIVE_TRACKERS} things at once. Stopping one keeps everything it recorded.`}
        </Text>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  container: { padding: 20, paddingBottom: 60 },
  presets: { gap: 8 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: vola.textMuted,
    marginTop: 8,
  },
  preset: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 12,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  presetDot: { width: 8, height: 8, borderRadius: 4 },
  presetName: { fontSize: 15, fontWeight: '700', color: vola.text },
  note: { fontSize: 14, color: vola.textMuted, marginTop: 14 },
  error: { fontSize: 13, color: vola.danger, fontWeight: '600', marginTop: 12 },
  save: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  saving: { opacity: 0.6 },
  saveText: { fontSize: 15, fontWeight: '800' },
  hint: { fontSize: 12, color: vola.textDim, marginTop: 10, textAlign: 'center' },
});
