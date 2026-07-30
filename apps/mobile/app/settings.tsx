import { Stack } from 'expo-router';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { UNIT_SYSTEMS } from '@/lib/units';
import { useUnits } from '@/lib/useUnits';

/**
 * Settings.
 *
 * Units are an account preference rather than a device one — someone who
 * thinks in pounds thinks in pounds on the web app too, and on their next
 * phone. So it's stored on the profile and merely cached locally.
 *
 * Changing it can never alter a recorded number: everything is stored in
 * kilograms and metres, and this only decides how those are shown and typed.
 * The screen says so, because a units toggle is exactly the kind of control
 * people are afraid will rewrite their history.
 */
export default function SettingsScreen() {
  const { units, setUnits } = useUnits();

  return (
    <View style={styles.container} testID="settings-screen">
      <Stack.Screen options={{ title: 'Settings' }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.sectionLabel}>Units</Text>

        {UNIT_SYSTEMS.map((u) => {
          const selected = units === u.key;
          return (
            <Pressable
              key={u.key}
              style={[styles.option, selected && styles.optionSelected]}
              onPress={() => setUnits(u.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`${u.label} — ${u.detail}`}
              testID={`units-${u.key}`}
            >
              <View style={styles.optionBody}>
                <Text style={styles.optionTitle}>{u.label}</Text>
                <Text style={styles.muted}>{u.detail}</Text>
              </View>
              {selected && <Text style={styles.tick}>✓</Text>}
            </Pressable>
          );
        })}

        <Text style={styles.note}>
          Your training is always stored in kilograms and metres — this only changes how weights
          and distances are shown and entered. Switching it never rewrites anything you've logged.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 16, gap: 10, paddingBottom: 48 },
  sectionLabel: { fontSize: 12, color: vola.textDim, textTransform: 'uppercase' },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 16,
    minHeight: 60,
  },
  optionSelected: { borderColor: vola.lime },
  optionBody: { flex: 1, gap: 2 },
  optionTitle: { fontSize: 16, fontWeight: '600' },
  tick: { color: vola.lime, fontSize: 20, fontWeight: '700' },
  muted: { color: vola.textMuted, fontSize: 13 },
  note: { color: vola.textDim, fontSize: 12, marginTop: 12, lineHeight: 17 },
});
