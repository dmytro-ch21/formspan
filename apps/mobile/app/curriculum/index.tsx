import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { listCurricula, type Curriculum } from '@/lib/curriculum';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * "My curricula" (N83) — the entry point findability was missing before this
 * ticket: an athlete's own curricula were reachable on the phone only by
 * already knowing an id (enrolled and shown on Today, or opened from web).
 * This is the equivalent of `apps/web`'s `curricula/page.tsx` "Mine" tab,
 * deliberately without its "Shared" tab — browsing VOLA's belt syllabuses and
 * other athletes' public curricula already lives on the Library screen's
 * reference block (`beltSyllabuses`), and duplicating that browse surface
 * here was not this ticket's gap. `editable` is the same split web's list
 * uses, for the same reason its own comment gives: a seeded belt syllabus you
 * are working is not yours to edit, and this list is exclusively "yours to
 * edit".
 *
 * Rows open the roadmap viewer (`curriculum/[id].tsx`), matching web's card,
 * which is where enrolling AND editing (via its own menu, N83) both live —
 * this list's job is finding the curriculum, not being a second place to
 * change it.
 */
export default function MyCurriculaScreen() {
  const getToken = useAuthToken();
  const accent = useAccent();
  const router = useRouter();

  const [curricula, setCurricula] = useState<Curriculum[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await listCurricula(getToken);
      setCurricula(all.filter((c) => c.editable));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [getToken]);

  // On focus, not on mount — creating or deleting one and coming straight
  // back here has to show the change, the same reason the roadmap viewer
  // itself reloads on focus rather than once.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={styles.screen} testID="my-curricula-screen">
      <Stack.Screen options={{ title: 'My curricula' }} />

      <Pressable
        onPress={() => router.push('/curriculum/new')}
        style={[styles.newButton, { borderColor: accent.accent }]}
        accessibilityRole="button"
        testID="my-curricula-new"
      >
        <Text style={[styles.newButtonText, { color: accent.ink }]}>+ New curriculum</Text>
      </Pressable>

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="my-curricula-error">
          {error}
        </Text>
      )}

      {curricula === null && !error && (
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading your curricula" />
      )}

      {curricula !== null && curricula.length === 0 && (
        <View style={styles.empty} testID="my-curricula-empty">
          <Text style={styles.emptyTitle}>No curricula yet.</Text>
          <Text style={styles.muted}>
            Build one from the technique library — a few things you want to own
            this year, and what landing them would have to look like.
          </Text>
        </View>
      )}

      <FlatList
        data={curricula ?? []}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.list}
        renderItem={({ item: c }) => {
          const isRoadmap = c.countable_items > 0;
          return (
            <Pressable
              onPress={() => router.push(`/curriculum/${c.id}`)}
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              accessibilityRole="button"
              testID={`my-curricula-${c.id}`}
            >
              <Text style={styles.cardName}>{c.name}</Text>
              {c.description !== '' && (
                <Text style={styles.cardNote} numberOfLines={2}>
                  {c.description}
                </Text>
              )}
              <Text style={styles.cardMeta}>
                {c.item_count} item{c.item_count === 1 ? '' : 's'}
                {isRoadmap ? ` · ${c.countable_items} to master` : ' · a reading list'}
                {c.enrolled ? ' · working this' : ''}
              </Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12 },
  newButton: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  newButtonText: { fontWeight: '700', fontSize: 15 },
  error: { color: vola.danger, fontSize: 14 },
  loading: { marginTop: 24 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: vola.text },
  muted: { color: vola.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  list: { gap: 10, paddingBottom: 32 },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    gap: 4,
  },
  cardPressed: { opacity: 0.7 },
  cardName: { fontSize: 16, fontWeight: '700', color: vola.text },
  cardNote: { fontSize: 13, color: vola.textMuted },
  cardMeta: { fontSize: 12, color: vola.textDim, marginTop: 2 },
});
