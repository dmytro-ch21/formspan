import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Belt as BeltView, describeBelt } from '@/components/Belt';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { describeTimeAtBelt, getStanding, nextRank, type Promotion, type Standing } from '@/lib/bjj';
import { MODULE_TOGGLE_LOCATION } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * The belt, and the whole timeline that produced it.
 *
 * `current` is never edited directly here — there is no field for it. It's
 * derived server-side from the promotion list below, so the only way to
 * change it is to add, correct or remove one of those rows, same as the
 * backend's own `StandingFrom`.
 */
export default function BjjStandingScreen() {
  const accent = useAccent();
  const getToken = useAuthToken();
  const router = useRouter();
  // The You-screen card that links here already gates on this, but the
  // route itself is still reachable another way — a stale back-stack entry
  // from before BJJ was turned off, say — and functional-scenarios.md
  // promises the route is absent when the module is off, not just the card
  // that opens it. So the check lives here too, not only at the door.
  const { modules, ready: modulesReady } = useModules();
  const bjjEnabled = modulesReady && modules.some((m) => m.key === 'bjj' && m.enabled);

  const [standing, setStanding] = useState<Standing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!bjjEnabled) return;
      const c = new AbortController();
      getStanding(getToken)
        .then((s) => {
          if (c.signal.aborted) return;
          setStanding(s);
          setError(null);
        })
        .catch(() => {
          if (!c.signal.aborted) setError("Couldn't load your rank just now.");
        });
      return () => c.abort();
    }, [getToken, bjjEnabled]),
  );

  function addPromotion() {
    // Suggest the obvious next step rather than a blank White/0 form every
    // time — "three years at blue" usually means the next entry is blue plus
    // one more stripe, not a rank picked from scratch. Only a suggestion:
    // every field is still editable before saving, for the jumps and
    // corrections this can't guess.
    if (!standing?.current) {
      router.push('/bjj/promotion/new');
      return;
    }
    const suggested = nextRank(standing.current);
    router.push({
      pathname: '/bjj/promotion/new',
      params: {
        belt: suggested.belt,
        stripes: String(suggested.stripes),
        degree: String(suggested.degree),
      },
    });
  }

  function openPromotion(p: Promotion) {
    router.push({
      pathname: '/bjj/promotion/[id]',
      params: {
        id: p.id,
        belt: p.belt,
        stripes: String(p.stripes),
        degree: String(p.degree),
        promoted_on: p.promoted_on ?? '',
        academy: p.academy,
        instructor: p.instructor,
        note: p.note,
      },
    });
  }

  if (modulesReady && !bjjEnabled) {
    return (
      <View style={styles.centre} testID="bjj-disabled">
        <Stack.Screen options={{ title: 'Your rank' }} />
        <Text style={styles.heroTitle}>BJJ tracking is off</Text>
        <Text style={styles.heroMuted}>
          Turn it back on under {MODULE_TOGGLE_LOCATION} in your profile to see your rank again.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="bjj-standing-screen">
      <Stack.Screen
        options={{
          title: 'Your rank',
          headerRight: () => (
            <Pressable
              onPress={addPromotion}
              hitSlop={12}
              accessibilityRole="button"
              testID="bjj-add-promotion"
            >
              <Text style={[styles.headerAction, { color: accent.ink }]}>Add</Text>
            </Pressable>
          ),
        }}
      />

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}

      {standing === null ? (
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading your rank" />
      ) : (
        <>
          <View style={styles.hero}>
            {standing.current === null ? (
              <>
                <Text style={styles.heroTitle}>No rank recorded yet</Text>
                <Text style={styles.heroMuted}>Add your first promotion to start your history.</Text>
              </>
            ) : (
              <>
                <BeltView
                  belt={standing.current.belt}
                  stripes={standing.current.stripes}
                  degree={standing.current.degree}
                  width={240}
                />
                <Text style={styles.heroTitle}>
                  {describeBelt(standing.current.belt, standing.current.stripes, standing.current.degree)}
                </Text>
                {standing.time_at_current_days !== null && (
                  <Text style={styles.heroMuted}>
                    {describeTimeAtBelt(standing.time_at_current_days)} at this rank
                  </Text>
                )}
              </>
            )}
          </View>

          <Text style={styles.sectionLabel}>History</Text>
          {standing.promotions.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.muted}>Nothing recorded yet.</Text>
            </View>
          ) : (
            standing.promotions.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => openPromotion(p)}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${describeBelt(p.belt, p.stripes, p.degree)}`}
                testID={`promotion-row-${p.id}`}
              >
                <View style={styles.row}>
                  <RNView style={styles.rowBody}>
                    <Text style={styles.rowTitle}>{describeBelt(p.belt, p.stripes, p.degree)}</Text>
                    <Text style={styles.muted}>
                      {[p.promoted_on, p.academy].filter(Boolean).join(' · ') || 'No date or academy recorded'}
                    </Text>
                  </RNView>
                  <Text style={styles.chevron}>›</Text>
                </View>
              </Pressable>
            ))
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 4, paddingBottom: 48 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  headerAction: { fontWeight: '700', fontSize: 16 },
  loading: { marginTop: 32 },
  hero: { alignItems: 'center', gap: 10, paddingVertical: 20 },
  heroTitle: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 14,
    marginBottom: 4,
  },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 8,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  chevron: { color: vola.textDim, fontSize: 20 },
  muted: { color: vola.textMuted, fontSize: 13 },
  heroMuted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  error: { color: vola.danger, fontSize: 14 },
});
