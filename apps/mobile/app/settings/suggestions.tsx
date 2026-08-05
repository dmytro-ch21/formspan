import { useAuth } from '@clerk/clerk-expo';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { enabledSports, labelFor } from '@/lib/modules';
import { useModules } from '@/lib/ModulesProvider';
import {
  PREF_DISMISSED_SUGGESTIONS,
  PREF_SUGGESTIONS,
  PREF_SUGGESTIONS_OFF,
  readPref,
  writePref,
} from '@/lib/prefs';
import { parseIdSet, parseMaster, serialiseIdSet } from '@/lib/suggestion';
import { fetchTechniques } from '@/lib/techniques';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * What VOLA is allowed to suggest, and what it has been told to stop
 * suggesting.
 *
 * Its own screen for the reason the units drill-down gives: the settings list
 * grows a control per feature and becomes unnavigable long before it becomes
 * complete. It also puts the master switch, the per-discipline switches and
 * the dismissal list in one place, which is the only place they make sense
 * together — "why am I not getting suggestions" has three possible answers and
 * this screen shows all three at once.
 *
 * **Everything here is device-local.** `writePref` only pushes what is marked
 * owed, and none of these are: they bound a nudge, and the sync surface is not
 * worth it for a preference whose worst failure is seeing one more card on a
 * second phone. Said out loud on the screen rather than left for someone to
 * discover.
 */
export default function SuggestionSettingsScreen() {
  const accent = useAccent();
  const { userId } = useAuth();
  const { modules } = useModules();
  const getToken = useAuthToken();

  const [master, setMaster] = useState(true);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string> | null>(null);
  /** Technique id → display name. Absent means the id is all we can show. */
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    Promise.all([
      readPref(userId, PREF_SUGGESTIONS),
      readPref(userId, PREF_SUGGESTIONS_OFF),
      readPref(userId, PREF_DISMISSED_SUGGESTIONS),
    ])
      .then(([m, o, d]) => {
        if (!alive) return;
        setMaster(parseMaster(m));
        setOff(parseIdSet(o));
        setDismissed(parseIdSet(d));
      })
      .catch(() => {
        // Reading a preference must not leave a settings screen that cannot
        // say what the preference is. Defaults are the honest fallback and the
        // athlete can set them again.
        if (alive) setDismissed(new Set());
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  /**
   * Resolve the dismissed ids to names.
   *
   * Best-effort and after the list has rendered: a name is what makes the row
   * useful, but an id is a readable slug and a failed lookup must not stop
   * someone undoing a dismissal they can already recognise.
   */
  useEffect(() => {
    if (!dismissed || dismissed.size === 0) return;
    const c = new AbortController();
    fetchTechniques(getToken, c.signal)
      .then((all) => {
        const map: Record<string, string> = {};
        for (const t of all) if (dismissed.has(t.id)) map[t.id] = t.name;
        setNames(map);
      })
      .catch(() => {});
    return () => c.abort();
  }, [dismissed, getToken]);

  const save = useCallback(
    (key: string, value: string) => {
      if (userId) writePref(userId, key, value).catch(() => {});
    },
    [userId],
  );

  const toggleModule = useCallback(
    (sport: string, on: boolean) => {
      const next = new Set(off);
      if (on) next.delete(sport);
      else next.add(sport);
      setOff(next);
      save(PREF_SUGGESTIONS_OFF, serialiseIdSet(next));
    },
    [off, save],
  );

  const restore = useCallback(
    (id: string) => {
      if (!dismissed) return;
      const next = new Set(dismissed);
      next.delete(id);
      setDismissed(next);
      save(PREF_DISMISSED_SUGGESTIONS, serialiseIdSet(next));
    },
    [dismissed, save],
  );

  const sports = enabledSports(modules);

  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="suggestion-settings">
      <Stack.Screen options={{ title: 'Suggestions' }} />

      <View style={styles.group}>
        <Row
          label="Smart suggestions"
          hint="What to work on next, from what you have logged."
          value={master}
          onChange={(on) => {
            setMaster(on);
            // '0' or '1' explicitly. Absence already means on, but writing the
            // value the athlete chose is what makes it survive a default
            // changing later.
            save(PREF_SUGGESTIONS, on ? '1' : '0');
          }}
          testID="suggestions-master"
          last
        />
      </View>

      {/* Per discipline, and still listed when the master is off — greyed
          rather than hidden. Hiding them would lose the answer to "which ones
          did I turn off", which is exactly what someone turning the master
          back on wants to know. */}
      <Text style={styles.caption}>BY DISCIPLINE</Text>
      <View style={[styles.group, !master && styles.groupOff]}>
        {sports.map((m, i) => (
          <Row
            key={m.key}
            label={labelFor(modules, m.key)}
            value={master && !off.has(m.key)}
            disabled={!master}
            onChange={(on) => toggleModule(m.key, on)}
            testID={`suggestions-${m.key}`}
            last={i === sports.length - 1}
          />
        ))}
      </View>
      {!master && (
        <Text style={styles.note}>
          Smart suggestions are off, so none of these are used. Your choices are kept.
        </Text>
      )}

      <Text style={styles.caption}>DISMISSED</Text>
      {dismissed === null ? (
        <ActivityIndicator style={styles.loading} />
      ) : dismissed.size === 0 ? (
        <Text style={styles.note}>
          Nothing dismissed. Tapping × on a suggestion stops that technique being suggested again —
          it will show up here if you change your mind.
        </Text>
      ) : (
        <View style={styles.group}>
          {[...dismissed].map((id, i) => (
            <View key={id} style={[styles.row, i < dismissed.size - 1 && styles.rowDivided]}>
              <Text style={styles.rowLabel} numberOfLines={2}>
                {names[id] ?? id}
              </Text>
              <Pressable
                onPress={() => restore(id)}
                hitSlop={12}
                style={({ pressed }) => [styles.restore, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`Suggest ${names[id] ?? id} again`}
                testID={`suggestions-restore-${id}`}
              >
                <Text style={[styles.restoreText, { color: accent.ink }]}>Suggest again</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.note}>
        These settings are kept on this phone only, so another device may suggest something you have
        turned off here.
      </Text>
    </ScrollView>
  );
}

function Row({
  label,
  hint,
  value,
  onChange,
  disabled,
  last,
  testID,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  last?: boolean;
  testID?: string;
}) {
  const accent = useAccent();
  return (
    <View style={[styles.row, !last && styles.rowDivided]}>
      <View style={styles.rowMain}>
        <Text style={[styles.rowLabel, disabled && styles.rowLabelOff]}>{label}</Text>
        {hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: accent.accent, false: vola.line }}
        // The knob stays light on both, so the track carries the state. A knob
        // that changed colour too would be two signals for one fact and neither
        // readable in greyscale.
        thumbColor={vola.text}
        accessibilityLabel={label}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 8, paddingBottom: 48 },
  group: {
    backgroundColor: vola.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: vola.line,
    overflow: 'hidden',
  },
  // Dimmed as a group, not per row — the rows keep their own ink so the
  // labels stay readable and only the block reads as inactive.
  groupOff: { opacity: 0.75 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 56,
  },
  rowDivided: { borderBottomWidth: 1, borderBottomColor: vola.line },
  rowMain: { flex: 1, gap: 2 },
  rowLabel: { color: vola.text, fontSize: 15, fontWeight: '600', flex: 1 },
  rowLabelOff: { color: vola.textMuted },
  rowHint: { color: vola.textMuted, fontSize: 12, lineHeight: 16 },
  caption: {
    color: vola.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginTop: 18,
    marginBottom: 2,
  },
  note: { color: vola.textMuted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4, paddingTop: 6 },
  loading: { marginTop: 16 },
  restore: { paddingVertical: 6, paddingHorizontal: 4 },
  restoreText: { fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.55 },
});
