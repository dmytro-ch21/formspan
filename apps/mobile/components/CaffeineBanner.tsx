/**
 * A dedicated caffeine card — N468/#792.
 *
 * **A real caffeine tracker already existed before this file** (N431/N432):
 * a coffee tracker tap already posts a cited mg figure to a caffeine
 * tracker, `tracker/presets.go` already carries a cited 400 mg daily
 * reference and a cutoff, and an athlete can already edit or remove a
 * tap-caused entry. What was missing is exactly what this file is —
 * `TrackerCard`'s own header states it must stay generic ("There is no
 * WaterCard and there will not be a CoffeeCard... a branch on
 * `tracker.preset` anywhere in this file would be the CoffeeCard the first
 * paragraph promises not to grow"), so today the caffeine tracker renders
 * with the same copy as a water glass — no recommended-dose messaging, no
 * note on what too much does, nothing that says the word "caffeine" at all.
 *
 * `TrackerList.tsx` (the one preset-aware branch in the tracker screens)
 * renders THIS in place of `TrackerCard` for the tracker whose preset is
 * `caffeine` — not an addition beside the generic card, a replacement of it,
 * matching the ticket's own acceptance criterion: "not the generic
 * `TrackerCard` treatment".
 *
 * ## Every figure here is cited, never invented
 *
 * The 400 mg reference and the list of effects both come from the Mayo
 * Clinic article "Caffeine: How much is too much?" (mayoclinic.org/healthy-
 * lifestyle/nutrition-and-healthy-eating/in-depth/caffeine/art-20045678),
 * which states up to 400 mg a day is a reasonable ceiling for most healthy
 * adults, and names headache, insomnia, nervousness, a fast heartbeat,
 * muscle tremors and stomach upset among the signs of having had too much.
 * The copy below paraphrases that list rather than quoting it — same
 * discipline `coffeeCaffeine.ts` already applies to its own Mayo citation —
 * and is deliberately short: this is a banner an athlete reads in passing,
 * not a medical page.
 *
 * ## The "cannot simply remove" half of this ticket
 *
 * A caffeine entry that ORIGINATED from a logged food item is marked by its
 * own id (`isFoodCaffeineEntryId`, from `foodCaffeine.ts`) rather than
 * stored as an independently-removable row with no memory of where it came
 * from — see that file's own doc comment for why a marked, real row was
 * chosen over deriving the total at read time. This component is where that
 * choice becomes visible: tapping remove on a food-caused entry does not
 * remove it — it explains why, and says where to go instead — while a
 * manual tap or a coffee-tap-caused entry (N431/N432, unaffected by this
 * ticket) removes exactly as it always has.
 *
 * ## Correcting a dose (N578)
 *
 * The banner draws no glyphs, so N437's long press had nothing to land on here,
 * and a manual 80 mg dose that was really 150 mg could only be removed and
 * re-added. Each dose row now opens the same correction screen a glyph does,
 * through `onEditEntry`. What the row does depends on which kind of dose it is:
 *
 * - **manual**: it opens the correction.
 * - **coffee-caused** (`-caf`): it opens the correction too. That is the only
 *   way to say a cup held more caffeine than its drink's reference figure.
 *   Correcting the coffee's cups still scales this dose, now from the corrected
 *   mg, and removing the coffee still removes it.
 * - **food-caused** (`-fcaf-`): it refuses, with the same explanation removal
 *   gives, because the food re-derives this number on its next edit.
 */

import { Alert, StyleSheet, View as RNView } from 'react-native';

import { Text } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { trackerFill, vola } from '@/constants/Colors';
import {
  FOOD_CAFFEINE_REDIRECT_MESSAGE,
  FOOD_CAFFEINE_REDIRECT_TITLE,
  isFoodCaffeineEntryId,
} from '@/lib/foodCaffeine';
import { cutoffLine, formatClock, lastLoggedAt, loggedAmount, type Tracker, type TrackerEntry } from '@/lib/trackerModel';
import { PressableScale } from '@/components/ui/PressableScale';

export function CaffeineBanner({
  tracker,
  entries,
  now = null,
  onAdd,
  onRemove,
  onEdit,
  onEditEntry,
  testID,
}: {
  tracker: Tracker;
  entries: TrackerEntry[];
  now?: Date | null;
  onAdd: () => void;
  onRemove: (entryID: string) => void;
  onEdit: () => void;
  /**
   * Open the correction for one dose — N578. Absent means the rows offer no
   * correction and read exactly as they did before.
   */
  onEditEntry?: (entryID: string) => void;
  testID?: string;
}) {
  const fill = trackerFill(tracker.color_key);
  const total = loggedAmount(entries);
  // `tracker.target` is nullable on the type (an athlete can clear it, like
  // any tracker's target) — 400 is the SEEDED default (`presets.go`), never
  // re-asserted here if the athlete has genuinely removed their own ceiling.
  const target = tracker.target;
  const over = target != null && total > target;
  // `cutoffLine` already folds "last at HH:MM" into its own string when the
  // last entry is past the cutoff (see its own doc comment) — so the plain
  // `lastLoggedAt` line below is only the fallback for when there is no
  // cutoff line to show at all (no cutoff configured, or nothing logged).
  const cutoff = cutoffLine(tracker, entries, now);
  const last = lastLoggedAt(entries);
  const foot = cutoff ?? (last ? `last at ${formatClock(last)}` : null);

  // The redirect this ticket's own AC asks for: refuse the direct change and
  // say where the real control is, rather than letting the tracker and the
  // food log silently disagree about whether that coffee was eaten.
  function redirectToFood() {
    Alert.alert(FOOD_CAFFEINE_REDIRECT_TITLE, FOOD_CAFFEINE_REDIRECT_MESSAGE);
  }

  function handleRemove(entryID: string) {
    if (isFoodCaffeineEntryId(entryID)) {
      redirectToFood();
      return;
    }
    onRemove(entryID);
  }

  function handleEdit(entryID: string) {
    if (isFoodCaffeineEntryId(entryID)) {
      redirectToFood();
      return;
    }
    onEditEntry?.(entryID);
  }

  return (
    <RNView style={styles.card} testID={testID ?? `caffeine-banner-${tracker.id}`}>
      <RNView style={styles.head}>
        <Text style={styles.icon} importantForAccessibility="no" accessibilityElementsHidden>
          {tracker.icon || '⚡'}
        </Text>
        <Text style={[styles.eyebrow, { color: fill }]}>Caffeine</Text>
        <PressableScale
          onPress={onEdit}
          hitSlop={14}
          accessibilityRole="button"
          accessibilityLabel="Caffeine settings"
          testID={`caffeine-menu-${tracker.id}`}
        >
          <Icon name="settings" size={16} color={vola.textMuted} />
        </PressableScale>
      </RNView>

      <Text style={styles.total} testID={`caffeine-total-${tracker.id}`}>
        {Math.round(total)} mg today
        {target != null && (
          <Text style={styles.totalMuted}>{over ? `  ·  ${Math.round(total - target)} over` : `  ·  of ${Math.round(target)}`}</Text>
        )}
      </Text>

      {/* Cited, never invented — see the file header. Shown regardless of
          whether today is over, because it is a reference fact about the
          substance, not a verdict on the day. */}
      <Text style={styles.reference} testID={`caffeine-reference-${tracker.id}`}>
        {target != null
          ? `${Math.round(target)} mg a day is a reasonable ceiling for most healthy adults — Mayo Clinic.`
          : 'Up to 400 mg a day is a reasonable ceiling for most healthy adults — Mayo Clinic.'}
      </Text>
      <Text style={styles.effects} testID={`caffeine-effects-${tracker.id}`}>
        Too much can bring on a headache, trouble sleeping, a fast heartbeat, shaky muscles or an
        upset stomach.
      </Text>

      {foot && (
        <Text style={styles.foot} testID={`caffeine-foot-${tracker.id}`}>
          {foot}
        </Text>
      )}

      <PressableScale
        onPress={onAdd}
        style={[styles.add, { borderColor: fill }]}
        accessibilityRole="button"
        accessibilityLabel={`Log ${tracker.count_noun || 'caffeine'}`}
        testID={`caffeine-add-${tracker.id}`}
      >
        <Icon name="plus" size={14} color={fill} />
        <Text style={[styles.addText, { color: fill }]}>Log caffeine</Text>
      </PressableScale>

      {entries.length > 0 && (
        <RNView style={styles.entries} testID={`caffeine-entries-${tracker.id}`}>
          {entries.map((e) => {
            const fromFood = isFoodCaffeineEntryId(e.id);
            const mg = Math.round(e.amount);
            const said = (
              <Text style={styles.entryText}>
                {mg} mg
                {fromFood ? ' · from a logged food' : ''}
              </Text>
            );
            return (
              <RNView key={e.id} style={styles.entryRow}>
                {onEditEntry ? (
                  <PressableScale
                    onPress={() => handleEdit(e.id)}
                    style={styles.entryBody}
                    // The row is 8pt of padding around 12pt text. The vertical
                    // slop brings the target to 44pt without drawing a taller
                    // row. There is no horizontal slop, because the remove
                    // control sits right beside it.
                    hitSlop={{ top: 8, bottom: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={
                      fromFood
                        ? `${mg} mg, from a logged food — change it in Food instead`
                        : `Change ${mg} mg`
                    }
                    testID={`caffeine-entry-edit-${e.id}`}
                  >
                    {said}
                    {/* A visible word, not a hidden gesture: the glyph's long
                        press was the part of N437 a device check had to
                        answer, and a row can just say what it does. */}
                    {fromFood ? null : <Text style={styles.entryChange}>Change</Text>}
                  </PressableScale>
                ) : (
                  said
                )}
                <PressableScale
                  onPress={() => handleRemove(e.id)}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel={
                    fromFood
                      ? `${mg} mg, from a logged food — edit or remove it in Food instead`
                      : `Remove ${mg} mg`
                  }
                  testID={`caffeine-entry-remove-${e.id}`}
                >
                  <Text style={[styles.entryX, fromFood && styles.entryXLocked]}>
                    {fromFood ? '🔒' : '×'}
                  </Text>
                </PressableScale>
              </RNView>
            );
          })}
        </RNView>
      )}
    </RNView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  icon: { fontSize: 14 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.4, flex: 1, textTransform: 'uppercase' },
  total: { fontSize: 20, fontWeight: '800', color: vola.text },
  totalMuted: { fontSize: 14, fontWeight: '600', color: vola.textMuted },
  reference: { fontSize: 12, color: vola.textMuted },
  effects: { fontSize: 12, color: vola.textDim },
  foot: { fontSize: 12, color: vola.textMuted, fontWeight: '600' },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 2,
  },
  addText: { fontSize: 13, fontWeight: '700' },
  entries: { gap: 6, marginTop: 2 },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: vola.surfaceRaised,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  entryBody: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  entryText: { fontSize: 12, color: vola.textMuted },
  entryChange: { fontSize: 12, fontWeight: '700', color: vola.textDim },
  entryX: { fontSize: 15, fontWeight: '700', color: vola.textMuted },
  // Locked, not danger — a food-caused entry is not an error state, it is a
  // control that points somewhere else. See the no-shame-messaging stance.
  entryXLocked: { color: vola.textDim },
});
