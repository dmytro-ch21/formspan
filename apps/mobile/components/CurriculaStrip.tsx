import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { BeltPhoto } from '@/components/BeltPhoto';
import { Icon } from '@/components/ui/Icon';
import { SectionHeader } from '@/components/ui/Section';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
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

  // Belt syllabuses only. An athlete's own curriculum has no belt and belongs
  // on the web list where it can be edited; showing it here without an edit
  // path would be a dead end.
  const belted = curricula
    .filter((c) => beltOf(c.belt) !== null)
    .sort(
      (a, b) =>
        Number(b.enrolled) - Number(a.enrolled) ||
        BELTS.indexOf(beltOf(a.belt)!) - BELTS.indexOf(beltOf(b.belt)!),
    );
  if (belted.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <SectionHeader label="Roadmaps" />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {belted.map((c) => {
          const belt = beltOf(c.belt)!;
          return (
            <Link key={c.id} href={`/curriculum/${c.id}`} asChild>
              <Pressable
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}
                accessibilityRole="button"
                // One label for the whole card: the belt render is decorative
                // here and the counts are the useful part.
                accessibilityLabel={
                  c.enrolled
                    ? `${c.name}, working it, ${c.countable_items} techniques to master`
                    : `${c.name}, ${c.countable_items} techniques to master`
                }
                testID={`curriculum-card-${c.id}`}
              >
                {/* The rule, as on every other row in the app — carrying the
                    belt rather than a discipline, since every card here is
                    BJJ. It is the only thing that distinguishes the four at a
                    glance once the covers are small. */}
                <RNView style={[styles.rule, { backgroundColor: STRAP[belt] }]} />

                <RNView style={styles.inner}>
                  <RNView style={[styles.cover, { backgroundColor: beltTint(belt) }]}>
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
                  </RNView>

                  <Text style={[styles.eyebrow, { color: accent.ink }]} numberOfLines={1}>
                    {c.enrolled ? 'WORKING' : `${belt.toUpperCase()} BELT`}
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
 * Strap colours, mirrored from `Belt.tsx`.
 *
 * Duplicated rather than exported, because that file's are private to its
 * drawing and this is a different use — a 3pt rule and a wash behind a
 * photograph, neither of which is the belt itself. If they ever disagree
 * visibly, share them; today they would only couple two unrelated things.
 */
const STRAP: Record<Belt, string> = {
  white: '#EDEAE3',
  blue: '#1B4CC4',
  purple: '#6A2D9B',
  brown: '#5C3A21',
  black: '#1A1A1A',
};

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
  name: { color: vola.text, fontSize: 13, fontWeight: '700', lineHeight: 17 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaText: {
    color: vola.textMuted,
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
