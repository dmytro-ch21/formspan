import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { useAuth } from '@clerk/clerk-expo';

import { Text, View } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { getSequence, stepMeta, stepName, type Sequence } from '@/lib/sequences';
import { fetchTechniques } from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * One chain, read back — the screen `shared/index.tsx` used to lie about.
 *
 * **The order IS the content.** A sequence is not a set of techniques, it is
 * what a class taught in the order it flows, so this renders the steps as a
 * numbered chain with the position each one leaves you in shown BETWEEN them,
 * the way web's detail page does. Sorting or grouping them would destroy the
 * only thing the record carries.
 *
 * **Every step is a way into the library.** Tapping one opens the technique,
 * which is what makes a chain something you can actually study on a phone
 * rather than a list of names you already know.
 *
 * **A local capture has no library fields on its steps.** The server resolves
 * `name`, `position` and `category` on read; a row still sitting in this
 * device's outbox has only the technique ids the reflection wizard tagged. So
 * when a step arrives nameless we resolve it against the technique summaries,
 * which are memory-cached for the app's lifetime and free if the Library has
 * been opened. When that cannot be done — a cold launch with no signal, the
 * known gap where the library is memory-only — the row says the name is
 * unavailable rather than rendering a raw id as if it were one.
 *
 * **Editing stays on web, and the screen says so instead of hiding it.** The
 * mobile-first rule allows web to be RICHER; what it forbids is web being the
 * ONLY place, which reading a chain back now is not.
 */
export default function SequenceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useAuth();
  const getToken = useAuthToken();
  const accent = useAccent();
  const router = useRouter();

  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Distinct from `error`: `getSequence` resolves to `null` offline for a chain
  // this device has never held, which is not a failure and not a 404. Rounding
  // it to either would tell the athlete their chain is gone.
  const [offline, setOffline] = useState(false);
  /** technique_id → name, for steps the server has not resolved yet. */
  const [names, setNames] = useState<Record<string, string>>({});

  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!id || !userId) return;
    inflight.current?.abort();
    const c = new AbortController();
    inflight.current = c;
    try {
      const found = await getSequence(userId, id, getToken, c.signal);
      if (c.signal.aborted) return;
      setSequence(found);
      setOffline(found === null);
      setError(null);
      // Only when something actually needs it. The whole summary list is
      // ~197 KB on a cold cache, and a server-resolved chain needs none of it.
      if (found?.steps?.some((s) => !s.name)) {
        try {
          const all = await fetchTechniques(getToken, c.signal);
          if (c.signal.aborted) return;
          setNames(Object.fromEntries(all.map((t) => [t.id, t.name])));
        } catch {
          // Best effort. An unresolved step renders as unavailable, which is
          // the honest answer; failing the whole screen over a decoration
          // would hide a chain the athlete can otherwise read.
        }
      }
    } catch (err) {
      if (c.signal.aborted || (err as Error)?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [getToken, id, userId]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => inflight.current?.abort();
    }, [load]),
  );

  if (error && !sequence) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: 'Sequence' }} />
        <Text style={styles.error} testID="sequence-error">
          {error}
        </Text>
      </View>
    );
  }

  if (offline && !sequence) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: 'Sequence' }} />
        <Text style={styles.note} testID="sequence-offline">
          This chain lives on the server and you&apos;re offline, so it can&apos;t be opened right
          now. Nothing has been lost — try again when you have signal.
        </Text>
      </View>
    );
  }

  if (!sequence) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: 'Sequence' }} />
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading this sequence" />
      </View>
    );
  }

  const steps = sequence.steps ?? [];

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="sequence-screen">
      <Stack.Screen options={{ title: sequence.name }} />

      {/* The header repeats the name, because `Stack.Screen` truncates a long
          one to a single line and a chain's name is often a whole sentence. */}
      <Text style={styles.title}>{sequence.name}</Text>

      {sequence.description !== '' && <Text style={styles.description}>{sequence.description}</Text>}

      {error && <Text style={styles.error}>{error}</Text>}

      {sequence.pending && (
        <View style={styles.card}>
          <Text style={styles.pending} testID="sequence-pending">
            On this phone only — not synced yet
          </Text>
          <Text style={styles.note}>
            You captured this here and it hasn&apos;t reached the server. Nobody else can see it
            until it does, and it will go up with the next sync.
          </Text>
        </View>
      )}

      {sequence.start_position_name ? (
        <Text style={styles.start} testID="sequence-start">
          Starts in {sequence.start_position_name}
        </Text>
      ) : null}

      <SectionHeader label={`${steps.length} step${steps.length === 1 ? '' : 's'}`} />

      {steps.length === 0 ? (
        <Text style={styles.note} testID="sequence-no-steps">
          No steps recorded on this chain.
        </Text>
      ) : (
        steps.map((step, i) => (
          <RNView key={`${step.technique_id}-${i}`}>
            <Pressable
              onPress={() => router.push(`/technique/${step.technique_id}`)}
              accessibilityRole="button"
              accessibilityLabel={`Step ${i + 1}, ${stepName(step, names) ?? 'name unavailable'}`}
              style={({ pressed }) => [styles.step, pressed && styles.pressed]}
              testID={`sequence-step-${i}`}
            >
              <View style={[styles.disc, { borderColor: accent.ink }]}>
                <Text style={[styles.discText, { color: accent.ink }]}>{i + 1}</Text>
              </View>
              <View style={styles.stepBody}>
                {stepName(step, names) ? (
                  <Text style={styles.stepName}>{stepName(step, names)}</Text>
                ) : (
                  // Never the raw id dressed up as a name. This is the cold-
                  // launch-with-no-signal case for a chain still in the outbox.
                  <Text style={styles.unresolved} testID={`sequence-step-unresolved-${i}`}>
                    Name unavailable offline
                  </Text>
                )}
                {stepMeta(step) !== '' && <Text style={styles.muted}>{stepMeta(step)}</Text>}
                {step.notes !== '' && <Text style={styles.notes}>{step.notes}</Text>}
              </View>
              <Text style={[styles.chevron, { color: accent.ink }]}>›</Text>
            </Pressable>
            {/* Where the step leaves you — between the steps, because that is
                what makes a chain a chain rather than a list. Only rendered
                when it was recorded; "Not recorded" on every step of a chain
                captured on the mat would be twenty lines of noise. */}
            {step.ends_at_position_name ? (
              <Text style={styles.node} testID={`sequence-node-${i}`}>
                ↳ ends in {step.ends_at_position_name}
              </Text>
            ) : null}
          </RNView>
        ))
      )}

      <Text style={styles.footnote}>
        {sequence.editable
          ? 'Reordering, renaming and adding steps happen on the web app.'
          : 'A VOLA reference chain. Copy it on the web app to make one you can change.'}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 20 },
  scroll: { padding: 20, gap: 10, paddingBottom: 48 },
  loading: { marginTop: 32 },
  title: { fontSize: 22, fontWeight: '800' },
  description: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
  start: { color: vola.textMuted, fontSize: 13 },
  card: {
    backgroundColor: vola.surface,
    borderColor: vola.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  pending: { color: vola.warn, fontSize: 13, fontWeight: '700' },
  note: { color: vola.textMuted, fontSize: 12, lineHeight: 17 },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: vola.line,
    backgroundColor: vola.surface,
  },
  pressed: { opacity: 0.7 },
  disc: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discText: { fontSize: 12, fontWeight: '800' },
  stepBody: { flex: 1, gap: 2 },
  stepName: { fontSize: 15, fontWeight: '700' },
  unresolved: { fontSize: 15, fontWeight: '600', color: vola.textDim },
  muted: { color: vola.textMuted, fontSize: 12, textTransform: 'capitalize' },
  notes: { color: vola.textDim, fontSize: 12, lineHeight: 17 },
  chevron: { fontSize: 22, fontWeight: '700' },
  node: { color: vola.textDim, fontSize: 12, marginLeft: 20, marginVertical: 2 },
  footnote: { color: vola.textDim, fontSize: 12, lineHeight: 17, marginTop: 12 },
  error: { color: vola.danger, fontSize: 14 },
});
