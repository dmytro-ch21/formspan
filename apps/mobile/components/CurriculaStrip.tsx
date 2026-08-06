import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { BeltPhoto } from '@/components/BeltPhoto';
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
                <RNView style={styles.cover}>
                  <BeltPhoto
                    belt={belt}
                    // No stripes and no degree. This is the syllabus FOR a
                    // belt, not a statement about what the athlete has been
                    // awarded — drawing four stripes on the blue card would
                    // read as a claim about them.
                    stripes={0}
                    degree={0}
                    width={116}
                    label=""
                  />
                </RNView>
                <Text style={styles.name} numberOfLines={2}>
                  {c.name}
                </Text>
                <Text style={styles.meta}>
                  {/*
                    `countable_items`, never `item_count`. Progress counts only
                    items carrying criteria, and the API sends the count for
                    exactly this reason — a web card that divided by the wrong
                    one told every athlete their roadmap was a reading list.

                    `mastered_items` is deliberately absent: it is zero on the
                    LIST response, so showing "0 of 12" here would be a
                    placeholder rendered as fact.
                  */}
                  {c.countable_items} to master
                </Text>
                {c.enrolled && (
                  <Text style={[styles.working, { color: accent.ink }]}>WORKING</Text>
                )}
              </Pressable>
            </Link>
          );
        })}
      </ScrollView>
    </View>
  );
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
    width: 148,
    backgroundColor: vola.surface,
    borderColor: vola.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 2,
  },
  pressed: { opacity: 0.7 },
  cover: {
    height: 78,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  name: { color: vola.text, fontSize: 13, fontWeight: '700', lineHeight: 17 },
  meta: { color: vola.textMuted, fontSize: 11 },
  working: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8, marginTop: 2 },
});
