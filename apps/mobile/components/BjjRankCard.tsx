import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View as RNView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { Belt as BeltView, describeBelt } from '@/components/Belt';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { describeTimeAtBelt, getStanding, type Standing } from '@/lib/bjj';
import type { TokenGetter } from '@/lib/useAuthToken';

/**
 * The belt, on the You screen — a summary, not the history.
 *
 * Full detail (the promotion timeline, add/edit/delete) lives on `/bjj`. This
 * card exists to answer "what belt am I" at a glance, the same job
 * `RecordsCard` does for lifts, and to be the door into the rest of it.
 */
export function BjjRankCard({ getToken }: { getToken: TokenGetter }) {
  const router = useRouter();
  const [standing, setStanding] = useState<Standing | null>(null);
  const [failed, setFailed] = useState(false);

  useFocusEffect(
    useCallback(() => {
      const c = new AbortController();
      getStanding(getToken)
        .then((s) => {
          if (c.signal.aborted) return;
          setStanding(s);
          setFailed(false);
        })
        .catch(() => {
          if (!c.signal.aborted) setFailed(true);
        });
      return () => c.abort();
    }, [getToken]),
  );

  return (
    <>
      <Text style={styles.sectionLabel}>BJJ</Text>
      <Pressable
        onPress={() => router.push('/bjj')}
        accessibilityRole="button"
        accessibilityLabel="Your rank and promotion history"
        testID="bjj-rank-card"
      >
        <View style={styles.card}>
          {standing === null ? (
            failed ? (
              <Text style={styles.muted}>Couldn&apos;t load your rank just now.</Text>
            ) : (
              <ActivityIndicator accessibilityLabel="Loading your rank" />
            )
          ) : standing.current === null ? (
            <Text style={styles.muted}>No rank recorded yet — tap to add your first promotion.</Text>
          ) : (
            <RNView style={styles.row}>
              <BeltView
                belt={standing.current.belt}
                stripes={standing.current.stripes}
                degree={standing.current.degree}
                width={140}
              />
              <RNView style={styles.text}>
                <Text style={styles.name}>
                  {describeBelt(standing.current.belt, standing.current.stripes, standing.current.degree)}
                </Text>
                {standing.time_at_current_days !== null && (
                  <Text style={styles.muted}>
                    {describeTimeAtBelt(standing.time_at_current_days)} at this rank
                  </Text>
                )}
              </RNView>
            </RNView>
          )}
        </View>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    fontSize: 12,
    color: vola.textDim,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 14,
  },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 14,
    marginTop: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  text: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: '700' },
  muted: { color: vola.textMuted, fontSize: 13 },
});
