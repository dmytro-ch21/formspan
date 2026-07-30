import { Stack } from 'expo-router';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { UNIT_SYSTEMS } from '@/lib/units';
import { useUnits } from '@/lib/useUnits';

/**
 * Units, as its own screen under Settings.
 *
 * A drill-down rather than a row of chips on the settings list: this is the
 * first of several preference groups, and a flat screen that grows a new
 * control per feature becomes unnavigable long before it becomes complete.
 */
export default function UnitsSettingsScreen() {
  const { units, setUnits } = useUnits();

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="units-screen">
      <Stack.Screen options={{ title: 'Units' }} />

      <View style={styles.group}>
        {UNIT_SYSTEMS.map((u, i) => {
          const selected = units === u.key;
          return (
            <Pressable
              key={u.key}
              style={[styles.row, i > 0 && styles.rowDivided]}
              onPress={() => setUnits(u.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${u.label} — ${u.detail}`}
              testID={`units-${u.key}`}
            >
              <View style={styles.rowBody}>
                <Text style={styles.rowLabel}>{u.label}</Text>
                <Text style={styles.muted}>{u.detail}</Text>
              </View>
              {selected && <Text style={styles.tick}>✓</Text>}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.note}>
        Your training is always stored in kilograms and metres — this only changes how weights and
        distances are shown and entered. Switching it never rewrites anything you&apos;ve logged.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 48 },
  group: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 60,
  },
  rowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: vola.lineSoft },
  rowBody: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 16, fontWeight: '600' },
  muted: { color: vola.textMuted, fontSize: 13 },
  tick: { color: vola.lime, fontSize: 18, fontWeight: '700' },
  note: { color: vola.textDim, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
});
