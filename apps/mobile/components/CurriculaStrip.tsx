import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { BeltPhoto } from '@/components/BeltPhoto';
import { Icon } from '@/components/ui/Icon';
import { SectionHeader } from '@/components/ui/Section';
import { Text, View } from '@/components/Themed';
import { activeBeltAccent, activeStrap, vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { BELTS, type Belt } from '@/lib/bjj';
import { listCurricula, type Curriculum } from '@/lib/curriculum';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Belt syllabuses on the Plan tab.
 *
 * **The design doc's own connective table puts this here** — "Plan: pick or
 * build a roadmap; see technique progress" — and Plan is a mobile tab. Only
 * *building* was ever meant to be a desk job; picking one is a tap, and the
 * evidence that feeds it is captured on this phone.
 *
 * A horizontal strip rather than a list, because it sits between the week
 * planner and the templates on a screen that already has two sections. Four
 * syllabuses is a strip; making it a list would push templates below the fold
 * for something you interact with once a year.
 *
 * The renders are the same artwork the rank card uses, at a size the drawn
 * `Belt.tsx` would serve better in a 44pt row — but this is a cover, the belt
 * IS the subject, and at 120pt the photograph is the right call. Stripes are
 * deliberately zero: this is the syllabus for a belt, not a claim about the
 * athlete's own rank.
 */
export function CurriculaStrip() {
  const getToken = useAuthToken();
  const accent = useAccent();
  const [curricula, setCurricula] = useState<Curriculum[] | null>(null);

  const load = useCallback(async () => {
    try {
      setCurricula(await listCurricula(getToken));
    } catch {
      // Silent, and deliberately: this is a discovery surface on a screen whose
      // job is templates. A banner here would make an offline Plan tab look
      // broken over something the athlete did not ask for.
    }
  }, [getToken]);

  // ON FOCUS, not on mount. Enrolling happens on the roadmap screen, pushed
  // over these tabs, and a tab screen stays mounted for the life of the
  // process — read once, this strip would still say nothing after you started
  // a syllabus. That is precisely the bug review had to find on the settings
  // screen, and it is the same shape here.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (curricula === null || curricula.length === 0) return null;

  // VOLA content only — the belt syllabuses plus the foundations track
  // (Novice Fundamentals has no belt, deliberately, and filtering on belt
  // alone made it invisible on the one platform a novice actually holds). An
  // athlete's own curriculum still belongs on the web list where it can be
  // edited; showing it here without an edit path would be a dead end.
  //
  // Order: what you are working leads; then foundations before the belts,
  // because it is the entry point and finishes first; then belts in rank
  // order.
  const shown = curricula
    // `!editable` on BOTH arms. The belt arm went unguarded for a long time,
    // and `belt` is athlete-writable ("a hint, never a gate") — so an athlete
    // setting belt on their own public curriculum put a dead-end card here
    // wearing a belt photograph. The review that added foundations flushed
    // the asymmetry out.
    .filter((c) => (beltOf(c.belt) !== null || c.track === 'foundations') && !c.editable)
    .sort(
      (a, b) =>
        Number(b.enrolled) - Number(a.enrolled) ||
        rankOf(a) - rankOf(b),
    );
  if (shown.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <SectionHeader label="Roadmaps" />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {shown.map((c) => {
          const belt = beltOf(c.belt);
          return (
            <Link key={c.id} href={`/curriculum/${c.id}`} asChild>
              <Pressable
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}
                accessibilityRole="button"
                // One label for the whole card: the belt render is decorative
                // here and the counts are the useful part.
                accessibilityLabel={
                  c.enrolled
                    ? `${c.name}, working it, ${c.countable_items} items to master`
                    : `${c.name}, ${c.countable_items} items to master`
                }
                testID={`curriculum-card-${c.id}`}
              >
                {/* The rule, as on every other row in the app — carrying the
                    belt rather than a discipline, since every card here is
                    BJJ.

                    `beltAccent`, NOT the strap colour. The first version used
                    the physical colour and claimed in this comment to be what
                    distinguishes the four at a glance, which was wrong twice:
                    the cover is plainly what distinguishes them, and the strap
                    colours are the ones `Colors.ts` measures at 2.50 (blue),
                    2.14 (purple), 1.81 (brown) and 1.05 (black) against this
                    surface — the last being invisible. `beltAccent` exists as
                    "the legible reading of each, all clearing 3:1", which is
                    exactly what a 3pt rule needs. The strap colour stays on
                    the wash below, where it sits behind a photograph of that
                    belt and is decorative. */}
                <RNView
                  style={[
                    styles.rule,
                    // A foundations card carries no belt and must not fake
                    // one: a neutral rule, same weight.
                    { backgroundColor: belt ? activeBeltAccent[belt] : vola.line },
                  ]}
                />

                <RNView style={styles.inner}>
                  <RNView
                    style={[
                      styles.cover,
                      { backgroundColor: belt ? beltTint(belt) : vola.surfaceHover },
                    ]}
                  >
                    {belt ? (
                      <BeltPhoto
                        belt={belt}
                        // No stripes and no degree. This is the syllabus FOR a
                        // belt, not a statement about what the athlete has been
                        // awarded — drawing four stripes on the blue card would
                        // read as a claim about them.
                        stripes={0}
                        degree={0}
                        width={104}
                        label=""
                      />
                    ) : (
                      // Foundations: no belt exists to photograph, and using
                      // the white belt's would claim one. The discipline glyph
                      // says what it is without ranking anybody.
                      <Icon name="bjj" size={30} color={vola.textMuted} />
                    )}
                  </RNView>

                  {/* Only WORKING takes the accent. Inking both variants the
                      same made enrolled and browsing cards distinguishable
                      only by reading the word — and put "BLUE BELT" in the
                      athlete's accent (orange, say) directly above a blue
                      strap. The accent means "this one is yours"; a belt name
                      is a label. */}
                  <Text
                    style={[styles.eyebrow, c.enrolled ? { color: accent.ink } : styles.eyebrowIdle]}
                    numberOfLines={1}
                  >
                    {c.enrolled ? 'WORKING' : belt ? `${belt.toUpperCase()} BELT` : 'FOUNDATIONS'}
                  </Text>
                  <Text style={styles.name} numberOfLines={2}>
                    {c.name}
                  </Text>

                  <RNView style={styles.meta}>
                    <Icon name="goal" size={12} color={vola.textDim} />
                    <Text style={styles.metaText}>
                      {/*
                        `countable_items`, never `item_count`. Progress counts
                        only items carrying criteria — a web card that divided
                        by the wrong one told every athlete their roadmap was a
                        reading list.

                        `mastered_items` is deliberately absent: it is zero on
                        the LIST response, so "0 of 12" here would be a
                        placeholder rendered as fact.
                      */}
                      {c.countable_items} to master
                    </Text>
                  </RNView>
                </RNView>
              </Pressable>
            </Link>
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * The strap colours, for the wash behind the belt photograph.
 *
 * **Shared with `Belt.tsx` now**, both reading `activeStrap` out of
 * `constants/Colors.ts` — this comment used to say they were deliberately
 * duplicated and should be shared only "if they ever disagree visibly". They
 * disagreed invisibly instead: two copies of the same literals meant two places
 * the monochrome swap had to reach, and it reached neither.
 *
 * Used for the wash ONLY. The rule takes `activeBeltAccent`; see the comment
 * there for why the physical colours cannot carry a load-bearing 3pt element.
 */
const STRAP = activeStrap;

/**
 * The wash behind the cut-out.
 *
 * Alpha rather than a solved tint, for the reason `sportTint` gives: these sit
 * on `surface` here and could sit on `surfaceRaised` elsewhere, and a tint
 * solved for one is visibly wrong on the other. Low, because the belt is the
 * subject — a strong wash makes four cards look like four buttons.
 */
function beltTint(belt: Belt): string {
  // White needs less: a pale wash on a dark ground reads much stronger than a
  // saturated one at the same alpha.
  return STRAP[belt] + (belt === 'white' ? '14' : '22');
}

function beltOf(belt: string | null): Belt | null {
  if (belt === null) return null;
  const b = belt.toLowerCase() as Belt;
  return BELTS.includes(b) ? b : null;
}

/** Strip order within the un-enrolled: foundations first — the entry point,
 *  and the one that finishes first — then belts in rank order. */
function rankOf(c: Curriculum): number {
  const belt = beltOf(c.belt);
  return belt === null ? -1 : BELTS.indexOf(belt);
}

const styles = StyleSheet.create({
  wrap: { gap: 2 },
  row: { gap: 10, paddingVertical: 4, paddingRight: 4 },
  card: {
    width: 156,
    flexDirection: 'row',
    backgroundColor: vola.surface,
    borderColor: vola.lineSoft,
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  pressed: { backgroundColor: vola.surfaceHover },
  rule: { width: 3, alignSelf: 'stretch' },
  inner: { flex: 1, padding: 10, gap: 2 },
  cover: {
    height: 66,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  eyebrow: { fontSize: 9, fontWeight: '800', letterSpacing: 0.9 },
  eyebrowIdle: { color: vola.textDim },
  name: { color: vola.text, fontSize: 13, fontWeight: '700', lineHeight: 17 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaText: {
    color: vola.textMuted,
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
