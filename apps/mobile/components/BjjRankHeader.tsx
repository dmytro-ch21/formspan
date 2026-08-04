import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View as RNView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { describeBelt } from '@/components/Belt';
import { BeltPhoto } from '@/components/BeltPhoto';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import {
  awardingPromotion,
  describeTimeAtBelt,
  formatAwardDate,
  getStanding,
  type Standing,
} from '@/lib/bjj';
import type { TokenGetter } from '@/lib/useAuthToken';

/**
 * The belt, as the masthead of the You screen.
 *
 * This was a card in the middle of the page, below the training summary and
 * above the profile rows — the same weight as everything else on the screen.
 * For a grappler the belt is not one fact among several; it is the thing the
 * screen is *about*, and it is what someone opens this tab to see. So it now
 * sits at the top, full width, with the belt drawn large and its story beside
 * it: where it was awarded, when, and how long you have carried it.
 *
 * **The masthead itself renders only once there is a rank recorded.** It is a
 * claim about identity, and a blank one — "no rank yet" in 200pt of chrome —
 * would be the loudest element on the screen saying nothing. Until then this
 * renders a single quiet row inviting the first promotion, which is what the
 * separate rank card used to do; that card is gone, because two components each
 * fetching `/bjj/standing` is two requests for one fact and they can disagree
 * while one is in flight.
 */
export function BjjRankHeader({ getToken }: { getToken: TokenGetter }) {
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

  if (standing === null) {
    return (
      <View style={styles.placeholder}>
        {failed ? (
          <Text style={styles.muted}>Couldn&apos;t load your rank just now.</Text>
        ) : (
          <ActivityIndicator accessibilityLabel="Loading your rank" />
        )}
      </View>
    );
  }

  // BJJ is on but no rank has been recorded. A masthead here would be the
  // loudest thing on the screen saying nothing, so this is the quiet invitation
  // the old card was — and it lives HERE rather than as a second component,
  // because two components each fetching `/bjj/standing` is two requests for
  // one fact, and they can disagree while one is in flight.
  if (standing.current === null) {
    return (
      <Pressable
        onPress={() => router.push('/bjj')}
        accessibilityRole="button"
        accessibilityLabel="Add your first promotion"
        testID="bjj-rank-empty"
        style={({ pressed }) => [styles.placeholder, pressed && styles.pressed]}
      >
        <Text style={styles.muted}>
          No rank recorded yet — tap to add your first promotion.
        </Text>
      </Pressable>
    );
  }

  const rank = standing.current;
  const awarded = awardingPromotion(standing);
  const name = describeBelt(rank.belt, rank.stripes, rank.degree);

  // Each fact is omitted rather than shown empty. A promotion may legitimately
  // have no academy and no date — the form allows both, because an athlete
  // often knows the belt and not the day — and "School: —" is furniture that
  // says nothing. Three facts, two facts or none all lay out.
  const facts = [
    awarded?.academy ? { label: 'School', value: awarded.academy } : null,
    awarded?.promoted_on
      ? { label: 'Promoted', value: formatAwardDate(awarded.promoted_on) }
      : null,
    standing.time_at_current_days !== null
      ? { label: 'At this rank', value: describeTimeAtBelt(standing.time_at_current_days) }
      : null,
  ].filter((f): f is NonNullable<typeof f> => f !== null);

  return (
    <Pressable
      onPress={() => router.push('/bjj')}
      accessibilityRole="button"
      // The whole story in one utterance. The visual splits it across a belt
      // and three labelled facts, which a screen reader would otherwise read
      // as six disconnected fragments.
      accessibilityLabel={[
        name,
        ...facts.map((f) => `${f.label}: ${f.value}`),
      ].join('. ')}
      // The label is purely descriptive, so without this nothing says where
      // the button goes.
      accessibilityHint="Opens your promotion history"
      testID="bjj-rank-header"
    >
      {({ pressed }) => (
        <View style={[styles.card, pressed && styles.pressed]}>
          {/* The belt spans the full width and leads, because at this size it
              IS the heading — the words below it are the caption. The
              photograph rather than the drawn belt: this is the one place the
              belt is the subject and big enough to carry a render. */}
          <BeltPhoto
            belt={rank.belt}
            stripes={rank.stripes}
            degree={rank.degree}
            width={BELT_WIDTH}
            label={name}
          />

          <RNView style={styles.head}>
            <RNView style={styles.headText}>
              <Text style={styles.eyebrow}>YOUR RANK</Text>
              <Text style={styles.name}>{name}</Text>
            </RNView>
            <Icon name="chevron" size={16} color={vola.textDim} />
          </RNView>

          {facts.length > 0 && (
            <RNView style={styles.facts}>
              {facts.map((f) => (
                <RNView key={f.label} style={styles.fact}>
                  <Text style={styles.factLabel}>{f.label.toUpperCase()}</Text>
                  {/* Two lines, not one. A third of a phone's width is ~92pt,
                      which "Gracie Barra Kyiv" does not fit on and never
                      will — and an academy truncated to "Gracie Barra…" is the
                      one fact on this card the athlete would most object to
                      getting wrong. */}
                  <Text style={styles.factValue} numberOfLines={2}>
                    {f.value}
                  </Text>
                </RNView>
              ))}
            </RNView>
          )}
        </View>
      )}
    </Pressable>
  );
}

/**
 * Wide enough that the stripes are countable at a glance, which is the one
 * detail a grappler actually reads off a belt. The card is full-bleed inside
 * the screen's 20pt gutters, so this is the usable width on the narrowest
 * phone the app supports, less the card's own padding.
 */
const BELT_WIDTH = 295;

const styles = StyleSheet.create({
  placeholder: {
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
    padding: 16,
    alignItems: 'center',
  },
  muted: { color: vola.textMuted, fontSize: 13, textAlign: 'center' },
  card: {
    backgroundColor: vola.surfaceRaised,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: vola.line,
    padding: 18,
    gap: 16,
    alignItems: 'center',
  },
  pressed: { backgroundColor: vola.surfaceHover },

  head: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch' },
  headText: { flex: 1, gap: 2 },
  // `textMuted`, not `textDim`: this card sits on `surfaceRaised`, where
  // textDim measures 3.36:1 — under AA for type this small. textMuted is
  // 6.26:1 on the same ground.
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, color: vola.textMuted },
  name: { fontSize: 22, fontWeight: '800' },

  // A rule above the facts rather than a card around them: they are a caption
  // to the belt, not a second card inside the first.
  facts: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    alignSelf: 'stretch',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: vola.line,
    paddingTop: 14,
  },
  fact: { flex: 1, gap: 2, paddingRight: 8 },
  factLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.9, color: vola.textMuted },
  factValue: { fontSize: 13, fontWeight: '700', lineHeight: 17 },
});
