import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';

/**
 * The ⓘ beside a section label, and the explanation behind it.
 *
 * N106's reference puts one on three section headers, and the acceptance
 * criterion is blunt about them: *"Every ⓘ opens an explanation. They are in
 * the reference three times; they are not decoration."* This project's own
 * standing rule says the same thing from the other end — a chevron pointing at
 * nothing is a broken promise — so the mark and the content ship together in
 * one component rather than the mark being a glyph somebody can add without
 * writing anything.
 *
 * **It exists because the screen got shorter.** The derivation used to explain
 * itself in running prose between the rows, which is what made Goals fifteen
 * viewports at accessibility text sizes (#484's measurements). Moving that
 * prose behind a mark does not delete it — an argument you cannot inspect is a
 * verdict, and this screen's whole purpose is being inspectable — it changes it
 * from *always present* to *available*, which is the trade #446 made for a
 * 93-item roadmap and the one this ticket asks for.
 *
 * ## The mark is a button, not an annotation
 *
 * 24pt of touch target with `hitSlop` on top, its own `accessibilityRole` and a
 * label naming the section it explains rather than saying "info" — a screen
 * reader hearing "info button" three times on one screen has been told nothing.
 * The glyph itself is `accessibilityElementsHidden`, like every other icon
 * here.
 *
 * ## Why a modal rather than an inline disclosure
 *
 * An inline expansion pushes everything below it down, which on a screen whose
 * reported bug is its length means tapping "explain this" makes the complaint
 * worse. A sheet costs no layout at all, and it closes.
 */
export function InfoMark({
  /** What this explains — "Daily movement". Used in the spoken label. */
  about,
  title,
  body,
  testID,
}: {
  about: string;
  /** The sheet's heading. Defaults to `about`. */
  title?: string;
  /** One paragraph per entry. Kept as an array so the sheet owns the spacing. */
  body: readonly string[];
  testID?: string;
}) {
  const accent = useAccent();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={12}
        style={styles.mark}
        accessibilityRole="button"
        accessibilityLabel={`What ${lowerFirst(about)} means`}
        accessibilityHint="Opens an explanation"
        testID={testID}
      >
        {/* Drawn rather than iconographic: the brand kit has no ⓘ, and this is
            chrome in the same sense the chevrons in `Icon`'s EXTRA are. A
            bordered circle with an italic serif-ish `i` is the universally read
            form; a kit icon would be a different promise. */}
        <RNView
          style={styles.markCircle}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={styles.markGlyph}>i</Text>
        </RNView>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.sheet}>
          <RNView style={styles.head}>
            <Text style={styles.title}>{title ?? about}</Text>
            <Pressable
              onPress={() => setOpen(false)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID={testID ? `${testID}-close` : undefined}
            >
              <Icon name="close" size={20} color={accent.ink} />
            </Pressable>
          </RNView>
          <ScrollView contentContainerStyle={styles.body}>
            {body.map((p, i) => (
              <Text key={i} style={styles.para}>
                {p}
              </Text>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

/** "Daily movement" → "daily movement", so the label reads as a sentence. An
 *  all-caps section label is a rendering; the prop carries the words. */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

const styles = StyleSheet.create({
  mark: { alignItems: 'center', justifyContent: 'center', minWidth: 20, minHeight: 20 },
  markCircle: {
    width: 15,
    height: 15,
    borderRadius: 8,
    borderWidth: 1,
    // `textDim` rather than `lineSoft`: this is a control, and the palette's own
    // commentary records `lineSoft` on `bg` at 1.23:1 — a border nobody can see
    // is not an affordance. `textDim` clears the 3:1 a meaningful graphic needs.
    borderColor: vola.textDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markGlyph: { fontSize: 10, fontWeight: '700', color: vola.textDim, lineHeight: 13 },
  // **`vola.bg` explicitly, and this was a real defect.** `View` from `Themed`
  // deliberately paints no background — the app is dark-only and every screen
  // sits on one continuous ground — but a `Modal` is not on that ground. iOS
  // gives a `pageSheet` the SYSTEM's sheet background, which is white, so the
  // first version of this rendered light-grey body text and a nearly invisible
  // title on white. Seen on a device; nothing in the suite renders colour.
  sheet: { flex: 1, backgroundColor: vola.bg },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  title: { fontSize: 20, fontWeight: '800', flexShrink: 1 },
  body: { paddingHorizontal: 20, paddingBottom: 48, gap: 14 },
  para: { fontSize: 14, lineHeight: 21, color: vola.textMuted },
});
