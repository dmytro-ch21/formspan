import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { KeyboardAwareFlatList } from '@/components/KeyboardAwareScroll';
import { Text } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { fetchTechniques, rankTechniques, type TechniqueSummary } from '@/lib/techniques';
import type { TokenGetter } from '@/lib/useAuthToken';

/**
 * Choosing one technique for a curriculum (N83) — full-screen rather than a
 * modal sheet, matching `app/food/recipe/[id].tsx`'s `IngredientPicker` swap
 * rather than `workout/[id].tsx`'s `<Modal>`: the caller already owns a
 * single-column scroll and swapping its content is one fewer native surface
 * to keep in sync with the keyboard.
 *
 * `rankTechniques`, NOT a hand-rolled filter — its own module's doc records
 * why: a plain `includes()` fails "São Paulo Pass" against "sao paulo", and
 * rolling one here would make this picker disagree with the Library screen
 * and web's `CurriculumBuilder` about the same catalog.
 *
 * Capped at 60 rows for the same reason the web builder caps its own list:
 * this is a picker, not a browse surface, and a phone screen makes that even
 * truer than a desktop one does.
 */
const RESULT_CAP = 60;

export function TechniquePicker({
  getToken,
  chosen,
  onPick,
  onCancel,
}: {
  getToken: TokenGetter;
  /** Technique ids already in the curriculum — shown but disabled, exactly
   *  like the web builder's picker, so a duplicate pick is unreachable rather
   *  than merely rejected. */
  chosen: ReadonlySet<string>;
  onPick: (t: TechniqueSummary) => void;
  onCancel: () => void;
}) {
  const accent = useAccent();
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<TechniqueSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    fetchTechniques(getToken, controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) {
          setCatalog(list);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [getToken]);

  const results = useMemo(() => rankTechniques(catalog, query).slice(0, RESULT_CAP), [catalog, query]);

  return (
    <View style={styles.wrap} testID="technique-picker">
      <View style={styles.head}>
        <Pressable onPress={onCancel} accessibilityRole="button" hitSlop={12} testID="technique-picker-cancel">
          <Text style={[styles.headAction, { color: accent.ink }]}>Cancel</Text>
        </Pressable>
        <Text style={styles.headTitle}>Add technique</Text>
        <View style={{ width: 56 }} />
      </View>

      <TextInput
        style={styles.input}
        placeholder="Search techniques…"
        placeholderTextColor={vola.textDim}
        accessibilityLabel="Search the technique library"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        testID="technique-picker-search"
      />

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="technique-picker-error">
          {error}
        </Text>
      )}

      {loading ? (
        <ActivityIndicator style={styles.loading} accessibilityLabel="Loading techniques" />
      ) : (
        <KeyboardAwareFlatList
          data={results}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={styles.muted} testID="technique-picker-empty">
              Nothing matches.
            </Text>
          }
          renderItem={({ item }) => {
            const disabled = chosen.has(item.id);
            return (
              <Pressable
                onPress={() => !disabled && onPick(item)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={disabled ? `${item.name}, already added` : `Add ${item.name}`}
                accessibilityState={{ disabled }}
                style={({ pressed }) => [
                  styles.row,
                  disabled && styles.rowDisabled,
                  pressed && !disabled && styles.rowPressed,
                ]}
                testID={`technique-picker-${item.id}`}
              >
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowPosition}>{item.position}</Text>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headAction: { fontSize: 16, fontWeight: '600' },
  headTitle: { fontSize: 17, fontWeight: '700', color: vola.text },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  error: { color: vola.danger, fontSize: 14 },
  loading: { marginTop: 24 },
  list: { gap: 4, paddingBottom: 32 },
  muted: { color: vola.textMuted, fontSize: 13, paddingVertical: 16 },
  row: { paddingVertical: 10, paddingHorizontal: 4, borderRadius: 8 },
  rowPressed: { backgroundColor: vola.surfaceRaised },
  rowDisabled: { opacity: 0.4 },
  rowName: { fontSize: 15, fontWeight: '600', color: vola.text },
  rowPosition: { fontSize: 12, color: vola.textMuted, marginTop: 1 },
});
