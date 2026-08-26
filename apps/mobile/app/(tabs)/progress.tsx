import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { ScreenHeader, TAB_BAR_CLEARANCE } from '@/components/ScreenHeader';
import { Text, View } from '@/components/Themed';
import { Icon } from '@/components/ui/Icon';
import { vola } from '@/constants/Colors';

/**
 * Progress — "am I getting better?"
 *
 * ## What this is
 *
 * A **shell**, deliberately, and a smaller one than Train's. N176 (#581) added
 * the tab; N178 (#583) builds it by reorganising the analytical components this
 * app already has — the weight trend, records, the training summary, the belt
 * roadmap — into an answer that leads with interpretation rather than with raw
 * data.
 *
 * That reorganisation is explicitly somebody else's ticket, so this file does
 * **not** start it. Rendering `TrainingSummary` and `RecordsCard` here would be
 * a second, unowned arrangement of exactly the components N178 is about to
 * arrange, and the two would then have to be reconciled.
 *
 * ## So what it does instead: it signposts, and does not orphan anything
 *
 * The surfaces that answer this question today are reachable, named, and
 * honestly labelled as where they live *for now*. A tab that silently leads
 * nowhere is the N61 failure in its purest form — an athlete cannot tell an
 * empty screen from a broken one, and cannot report what they cannot see.
 *
 * Both rows point at routes that already exist and already work. Neither is
 * module-gated here, on purpose: `goals/trend` is body weight and check-ins
 * rather than nutrition, and You holds records and training history for every
 * athlete. A gate would be a hiding decision, and this bar just stopped making
 * those.
 */
export default function ProgressScreen() {
  const router = useRouter();

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Progress" />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lead}>
          Whether the work is landing — weight, records and how much you have actually
          trained.
        </Text>

        <Row
          title="Weight trend"
          note="The line, the projection and the entries behind it."
          onPress={() => router.push('/goals/trend')}
          testID="progress-weight-trend"
        />
        <Row
          title="Records and training history"
          note="On You for now — this tab takes them over next."
          onPress={() => router.push('/(tabs)/you')}
          testID="progress-history"
        />

        {/*
          Dashed, per #468: standing where content would stand, not beside it.
        */}
        <View style={styles.soon} testID="progress-soon">
          <Text style={styles.soonTitle}>One place for the answer</Text>
          <Text style={styles.soonNote}>
            Strength, BJJ and body composition read together, with what changed said
            first and the numbers underneath it.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * One destination.
 *
 * A `Pressable` with an explicit role and label rather than a bare `Text` in a
 * touchable: the note underneath is supplementary, so it goes in the hint and
 * the title carries the label — otherwise a screen reader reads the whole
 * paragraph as the name of the control.
 */
function Row({
  title,
  note,
  onPress,
  testID,
}: {
  title: string;
  note: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={note}
      testID={testID}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowNote}>{note}</Text>
      </View>
      <Icon name="chevron" size={16} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: vola.bg },
  body: { paddingHorizontal: 20, paddingBottom: TAB_BAR_CLEARANCE, gap: 12 },
  lead: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: vola.lineSoft,
    backgroundColor: vola.surface,
  },
  rowPressed: { opacity: 0.85 },
  rowText: { flex: 1, gap: 3, backgroundColor: 'transparent' },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  // textMuted, not textDim — textDim is 3.96:1 on `bg`, under AA at this size.
  rowNote: { color: vola.textMuted, fontSize: 13, lineHeight: 18 },

  soon: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.lineSoft,
    borderRadius: 16,
    padding: 20,
    gap: 6,
    marginTop: 4,
  },
  soonTitle: { fontSize: 15, fontWeight: '700' },
  soonNote: { color: vola.textMuted, fontSize: 13, lineHeight: 19 },
});
