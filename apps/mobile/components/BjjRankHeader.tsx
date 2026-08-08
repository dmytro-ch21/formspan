import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View as RNView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle } from 'react-native-svg';

import { describeBelt } from '@/components/Belt';
import { BeltPhoto } from '@/components/BeltPhoto';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { activeBeltAccent, vola } from '@/constants/Colors';
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

  // The card's accent is the athlete's own belt — see `beltAccent`, and note
  // these are legible readings of each belt rather than its literal colour.
  const tone = activeBeltAccent[rank.belt];

  // Split into a headline and its qualifier, which `describeBelt` deliberately
  // does not do: it returns one utterance ("Purple belt, 2 stripes") because
  // that is what a screen reader should hear, and the accessibility label above
  // still uses it. The card wants two lines at two weights.
  const beltName = `${rank.belt[0].toUpperCase()}${rank.belt.slice(1)} Belt`;
  const marks =
    rank.belt === 'black'
      ? rank.degree > 0
        ? `${ORDINAL[rank.degree] ?? `${rank.degree}th`} Degree`
        : ''
      : rank.stripes > 0
        ? `${rank.stripes} ${rank.stripes === 1 ? 'Stripe' : 'Stripes'}`
        : '';

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
          {/* The "glass": a wash tinted with the athlete's own belt, brightest
              at the top-left corner where a light would fall, fading out by the
              middle. Deliberately NOT `expo-blur` — a BlurView samples what is
              behind it, and behind this is a flat `bg`, so it would cost a
              native view to blur nothing. Glass on a dark ground is a gradient
              and a lit edge. */}
          <LinearGradient
            colors={[`${tone}26`, `${tone}0A`, 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />

          {/* The body the belt is tied around, implied rather than drawn. Three
              arcs struck from a centre well off the card's top-right, so what
              shows inside the card is the shallow part of the curve. */}
          <Svg
            style={styles.arcs}
            width={ARC_BOX}
            height={ARC_BOX}
            viewBox={`0 0 ${ARC_BOX} ${ARC_BOX}`}
            pointerEvents="none"
          >
            {[0.52, 0.68, 0.84].map((r) => (
              <Circle
                key={r}
                cx={ARC_BOX * 0.86}
                cy={ARC_BOX * 0.16}
                r={ARC_BOX * r}
                stroke={tone}
                strokeOpacity={0.13}
                strokeWidth={1.25}
                fill="none"
              />
            ))}
          </Svg>

          {/* The belt sits right and clear of the chevron, rather than spanning
              the card. Full width it ran behind the button, and a photograph
              with a control on top of it reads as a layout accident. */}
          <BeltPhoto
            belt={rank.belt}
            stripes={rank.stripes}
            degree={rank.degree}
            width={BELT_WIDTH}
            label={name}
            style={styles.belt}
          />

          <RNView style={styles.head}>
            <Text style={[styles.eyebrow, { color: tone }]}>YOUR RANK</Text>
            <Text style={styles.name}>{beltName}</Text>
            {marks ? <Text style={[styles.marks, { color: tone }]}>{marks}</Text> : null}

            {/* A disc, not a bare chevron. It is the only affordance on a card
                that is otherwise all information, and at the bottom-left it sits
                where the eye finishes reading rather than opposite it. */}
            <RNView style={styles.go}>
              <Icon name="chevron" size={15} color={vola.text} />
            </RNView>
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

          {/* Last, so it draws over the gradient and the belt rather than
              under them. */}
          <RNView style={[styles.edge, { backgroundColor: tone }]} pointerEvents="none" />
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
const BELT_WIDTH = 215;

/** Black-belt degrees read as ordinals; nobody says "3 degree". */
const ORDINAL: Record<number, string> = {
  1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', 6: '6th',
};

/**
 * The arc canvas, drawn larger than the card and clipped by it.
 *
 * The circles are struck from a centre near the top-right *outside* the card,
 * so only the shallow part of each curve falls inside — which is what makes
 * them read as a torso the belt is tied around rather than as rings.
 */
const ARC_BOX = 300;

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
    // Translucent over the app's ground rather than a solid panel: the wash and
    // the lit edge only read as glass if some of what is behind shows through.
    backgroundColor: 'rgba(23,30,43,0.72)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    paddingTop: 20,
    paddingBottom: 16,
    paddingLeft: 22,
    paddingRight: 18,
    gap: 18,
    // Clips the arcs and the belt's bleed to the card's own corners.
    overflow: 'hidden',
  },
  pressed: { backgroundColor: 'rgba(29,37,52,0.82)' },

  /**
   * The belt-coloured edge. 3pt, full height, hard against the left.
   *
   * Drawn last in the tree so it sits over the gradient — under it, the wash's
   * own tint washed the edge out at exactly the corner the wash is brightest.
   */
  edge: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },

  arcs: { position: 'absolute', right: -70, top: -70 },

  /**
   * Right of the text, and inset from the card's edge rather than bleeding off
   * it: this render is a cut-out with its own transparent margin, so bleeding
   * it would crop the belt's tail rather than the empty space around it.
   */
  belt: { position: 'absolute', right: -14, top: 2 },

  head: { alignSelf: 'stretch', gap: 3 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.3 },
  name: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  marks: { fontSize: 16, fontWeight: '600' },
  go: {
    width: 38,
    height: 38,
    borderRadius: 19,
    marginTop: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
  },

  // A rule above the facts rather than a card around them: they are a caption
  // to the belt, not a second card inside the first.
  facts: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    alignSelf: 'stretch',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.09)',
    paddingTop: 14,
  },
  fact: { flex: 1, gap: 3, paddingRight: 10 },
  factLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.9, color: vola.textMuted },
  factValue: { fontSize: 13, fontWeight: '700', lineHeight: 17 },
});
