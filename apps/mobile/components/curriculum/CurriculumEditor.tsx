import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, TextInput, View as RNView } from 'react-native';

import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { SectionHeader } from '@/components/ui/Section';
import { vola } from '@/constants/Colors';
import { useAccent } from '@/lib/AccentProvider';
import { BELTS } from '@/lib/bjj';
import {
  CRITERIA_DEFAULTS,
  createCurriculum,
  updateCurriculum,
  type Curriculum,
  type CurriculumItemWrite,
  type Visibility,
} from '@/lib/curriculum';
import {
  draftToWrite,
  itemDraftsOf,
  moveAt,
  movePhase,
  nextKey,
  phaseDraftsOf,
  removePhaseAt,
  techniqueMetaOf,
  validateDraft,
  type ItemDraft,
  type PhaseDraft,
} from '@/lib/curriculumDraft';
import type { TechniqueSummary } from '@/lib/techniques';
import type { TokenGetter } from '@/lib/useAuthToken';

import { TechniquePicker } from './TechniquePicker';

/**
 * Build or correct a curriculum, on the phone (N83).
 *
 * `curriculum-and-gameplan-design.md` put roadmap *building* on web
 * exclusively — reasonably, at the time: picking a dozen techniques out of
 * 542 and setting four numeric criteria each reads like a desk job. That is
 * superseded on the exclusivity, not on the design (`CLAUDE.md`'s mobile-first
 * rule): web's two-pane builder with the catalog always visible stays the
 * richer way to do this, but an athlete who trains and logs entirely on their
 * phone can now do the whole thing here too.
 *
 * # What is reduced, and why each reduction is defensible
 *
 * - **One column, not two panes.** The catalog opens as a full-screen picker
 *   (`TechniquePicker`) instead of sitting beside the list permanently —
 *   there is no room for both on a phone width, and a picker you summon and
 *   dismiss is the same interaction `workout/[id].tsx`'s exercise picker and
 *   `food/recipe/[id].tsx`'s `IngredientPicker` already use for the identical
 *   problem (choosing one row out of a big catalog while building a list).
 * - **Up/down buttons, not drag-and-drop**, for both items and phases —
 *   `workout/[id].tsx`'s `move(index, ±1)` is the established pattern this
 *   session has used everywhere reordering needs to work with a thumb, and it
 *   is the one reduction CLAUDE.md names explicitly as acceptable.
 * - **One item's criteria editor open at a time is NOT enforced** — unlike
 *   the belt-roadmap viewer's one-thing-open discipline, a builder is edited
 *   top to bottom and closing every other row while typing in one would
 *   fight the athlete's own scroll position.
 *
 * What is NOT reduced: every field the web builder writes is here — five
 * criteria numbers, phases, concepts, visibility, belt. A reduced authoring
 * screen that could not produce a roadmap with a defence-only criterion, say,
 * would not be a smaller version of the capability; it would be a different,
 * incomplete one, which is exactly what the mobile-first rule forbids.
 */

const BELT_OPTIONS = ['', ...BELTS] as const;

export function CurriculumEditor({
  existing,
  getToken,
  onSaved,
  onCancel,
  footer,
}: {
  /** Absent for a new curriculum. */
  existing?: Curriculum;
  getToken: TokenGetter;
  onSaved: (c: Curriculum) => void;
  onCancel: () => void;
  /** Rendered below Save/Cancel — the edit screen's own Delete, so this
   *  component does not need to know deletion exists to stay reusable by
   *  `curriculum/new.tsx`, which has nothing to delete yet. */
  footer?: React.ReactNode;
}) {
  const accent = useAccent();

  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [belt, setBelt] = useState(existing?.belt ?? '');
  const [visibility, setVisibility] = useState<Visibility>(existing?.visibility ?? 'private');
  const [phases, setPhases] = useState<PhaseDraft[]>(() => phaseDraftsOf(existing));
  const [items, setItems] = useState<ItemDraft[]>(() => itemDraftsOf(existing));
  // Seeded from the existing curriculum's items (which carry name/position on
  // every read) and grown as the picker hands over freshly-added techniques —
  // a draft item carries only `technique_id`, never the catalog fields, so
  // this is the only place the row's display name comes from.
  const [techniqueMeta, setTechniqueMeta] = useState(() => techniqueMetaOf(existing));

  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = useMemo(
    () => new Set(items.map((i) => i.technique_id).filter((id): id is string => !!id)),
    [items],
  );

  const addTechnique = useCallback((t: TechniqueSummary) => {
    setTechniqueMeta((m) => ({ ...m, [t.id]: { name: t.name, position: t.position } }));
    setItems((prev) =>
      prev.some((i) => i.technique_id === t.id)
        ? prev
        : // Added as READING, criteria off — matching web, so adding a
          // technique never silently starts a roadmap the athlete did not
          // ask to track.
          [...prev, { _key: nextKey(), technique_id: t.id, notes: '' }],
    );
    setPicking(false);
  }, []);

  const addConcept = useCallback(() => {
    setItems((prev) => [...prev, { _key: nextKey(), kind: 'concept', title: '', notes: '' }]);
  }, []);

  const removeItemAt = useCallback((idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const moveItem = useCallback((idx: number, delta: -1 | 1) => {
    setItems((prev) => moveAt(prev, idx, delta));
  }, []);

  const patchItem = useCallback((idx: number, patch: Partial<CurriculumItemWrite>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }, []);

  const addPhase = useCallback(() => {
    setPhases((prev) => [...prev, { _key: nextKey(), title: '', description: '' }]);
  }, []);

  const patchPhase = useCallback((idx: number, patch: Partial<PhaseDraft>) => {
    setPhases((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }, []);

  const removePhase = useCallback(
    (idx: number) => {
      const result = removePhaseAt(phases, items, idx);
      setPhases(result.phases);
      setItems(result.items);
    },
    [phases, items],
  );

  const shiftPhase = useCallback(
    (idx: number, delta: -1 | 1) => {
      const result = movePhase(phases, items, idx, delta);
      setPhases(result.phases);
      setItems(result.items);
    },
    [phases, items],
  );

  const save = useCallback(async () => {
    const problem = validateDraft(name, phases, items);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = draftToWrite({ name, description, belt, visibility, phases, items });
      const saved = existing
        ? await updateCurriculum(getToken, existing.id, payload)
        : await createCurriculum(getToken, payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }, [belt, description, existing, getToken, items, name, onSaved, phases, visibility]);

  if (picking) {
    // NOT wrapped in `KeyboardAwareScrollView` here — `TechniquePicker` owns a
    // `KeyboardAwareFlatList` internally, and nesting that inside another
    // scroll container is the exact anti-pattern `IngredientPicker`'s own doc
    // comment warns about (a second container breaking the one that works).
    return (
      <View style={styles.pickerWrap}>
        <TechniquePicker getToken={getToken} chosen={chosen} onPick={addTechnique} onCancel={() => setPicking(false)} />
      </View>
    );
  }

  return (
    <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.field}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Guard passing for the winter"
          placeholderTextColor={vola.textDim}
          style={styles.input}
          accessibilityLabel="Curriculum name"
          testID="curriculum-name"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Description</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Optional"
          placeholderTextColor={vola.textDim}
          style={styles.input}
          accessibilityLabel="Curriculum description"
          testID="curriculum-description"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Belt</Text>
        <RNView style={styles.chipRow}>
          {BELT_OPTIONS.map((b) => (
            <Pressable
              key={b || 'none'}
              onPress={() => setBelt(b)}
              accessibilityRole="button"
              accessibilityState={{ selected: belt === b }}
              style={[
                styles.chip,
                belt === b && { backgroundColor: accent.accent, borderColor: accent.accent },
              ]}
              testID={`curriculum-belt-${b || 'none'}`}
            >
              <Text style={[styles.chipText, belt === b && { color: accent.on }]}>
                {b === '' ? 'Not belt-specific' : b.charAt(0).toUpperCase() + b.slice(1)}
              </Text>
            </Pressable>
          ))}
        </RNView>
      </View>

      <RNView style={styles.switchRow}>
        <Text style={styles.label}>Share this with other athletes</Text>
        <Switch
          value={visibility === 'public'}
          onValueChange={(v) => setVisibility(v ? 'public' : 'private')}
          accessibilityLabel="Share this curriculum with other athletes"
          testID="curriculum-visibility"
        />
      </RNView>

      <BuilderHeader
        label={`Phases${phases.length > 0 ? ` (${phases.length})` : ''}`}
        action="+ Add phase"
        onAction={addPhase}
        testID="curriculum-add-phase"
      />
      {phases.length === 0 ? (
        <Text style={styles.muted}>
          Optional. Phases split a long curriculum into named sections — each
          item below can be assigned to one.
        </Text>
      ) : (
        phases.map((p, idx) => (
          <RNView key={p._key} style={styles.card} testID={`curriculum-phase-${idx}`}>
            <RNView style={styles.cardBody}>
              <TextInput
                value={p.title}
                onChangeText={(t) => patchPhase(idx, { title: t })}
                placeholder={`Phase ${idx + 1} title`}
                placeholderTextColor={vola.textDim}
                style={styles.inputCompact}
                accessibilityLabel={`Phase ${idx + 1} title`}
                testID={`curriculum-phase-${idx}-title`}
              />
              <TextInput
                value={p.description}
                onChangeText={(t) => patchPhase(idx, { description: t })}
                placeholder="What this phase is for (optional)"
                placeholderTextColor={vola.textDim}
                style={styles.inputCompact}
                accessibilityLabel={`Phase ${idx + 1} description`}
                testID={`curriculum-phase-${idx}-description`}
              />
            </RNView>
            <RowActions
              onUp={() => shiftPhase(idx, -1)}
              onDown={() => shiftPhase(idx, 1)}
              onRemove={() => removePhase(idx)}
              upDisabled={idx === 0}
              downDisabled={idx === phases.length - 1}
              removeLabel={`Remove phase ${idx + 1}`}
              testIDPrefix={`curriculum-phase-${idx}`}
            />
          </RNView>
        ))
      )}

      <SectionHeader
        label={`Items (${items.length})`}
        info={
          <Text style={styles.countable}>
            {items.filter((i) => i.target_scored != null || i.target_defended != null || i.target_drilled_sessions != null).length} with criteria
          </Text>
        }
      />
      {items.length === 0 ? (
        <Text style={styles.muted} testID="curriculum-no-items">
          Nothing in it yet. Add techniques from the library, and concepts for
          the ideas between them.
        </Text>
      ) : (
        items.map((it, idx) => (
          <ItemRow
            key={it._key}
            item={it}
            index={idx}
            total={items.length}
            meta={it.technique_id ? techniqueMeta[it.technique_id] : undefined}
            phases={phases}
            onMove={(d) => moveItem(idx, d)}
            onRemove={() => removeItemAt(idx)}
            onPatch={(patch) => patchItem(idx, patch)}
          />
        ))
      )}

      <RNView style={styles.addRow}>
        <Pressable
          onPress={() => setPicking(true)}
          style={[styles.addButton, { borderColor: accent.accent }]}
          accessibilityRole="button"
          testID="curriculum-add-technique"
        >
          <Text style={[styles.addButtonText, { color: accent.ink }]}>+ Add technique</Text>
        </Pressable>
        <Pressable
          onPress={addConcept}
          style={styles.addButton}
          accessibilityRole="button"
          testID="curriculum-add-concept"
        >
          <Text style={styles.addButtonText}>+ Add a concept</Text>
        </Pressable>
      </RNView>

      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID="curriculum-error">
          {error}
        </Text>
      )}

      <RNView style={styles.saveRow}>
        <Pressable
          onPress={() => void save()}
          disabled={saving || name.trim() === ''}
          accessibilityRole="button"
          accessibilityState={{ disabled: saving || name.trim() === '' }}
          style={[
            styles.save,
            { backgroundColor: accent.accent },
            (saving || name.trim() === '') && styles.saveOff,
          ]}
          testID="curriculum-save"
        >
          <Text style={[styles.saveText, { color: accent.on }]}>
            {saving ? 'Saving…' : existing ? 'Save changes' : 'Create'}
          </Text>
        </Pressable>
        <Pressable onPress={onCancel} accessibilityRole="button" testID="curriculum-cancel">
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </RNView>

      {footer}
    </KeyboardAwareScrollView>
  );
}

/**
 * A section label with an inline "+ Add …" beside it — deliberately NOT
 * `SectionHeader`'s `action`, which draws a chevron and means "go look
 * elsewhere" (a filtered list, a detail screen). Adding a phase or an item
 * happens right here, so a chevron pointing at nothing would be the exact
 * broken promise `SectionHeader`'s own doc comment forbids for that prop.
 */
function BuilderHeader({
  label,
  action,
  onAction,
  testID,
}: {
  label: string;
  action: string;
  onAction: () => void;
  testID: string;
}) {
  const accent = useAccent();
  return (
    <RNView style={styles.builderHead}>
      <Text style={styles.builderHeadLabel}>{label.toUpperCase()}</Text>
      <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button" testID={testID}>
        <Text style={[styles.builderHeadAction, { color: accent.ink }]}>{action}</Text>
      </Pressable>
    </RNView>
  );
}

/** Up/down/remove, shared by the phase list and the item list — the same
 *  three controls `workout/[id].tsx`'s `ItemRow` draws, laid out the same
 *  way, so an athlete who has reordered a workout already knows this. */
function RowActions({
  onUp,
  onDown,
  onRemove,
  upDisabled,
  downDisabled,
  removeLabel,
  testIDPrefix,
}: {
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  upDisabled: boolean;
  downDisabled: boolean;
  removeLabel: string;
  testIDPrefix: string;
}) {
  return (
    <RNView style={styles.rowActions}>
      <Pressable
        onPress={onUp}
        disabled={upDisabled}
        style={[styles.smallButton, upDisabled && styles.disabled]}
        accessibilityRole="button"
        accessibilityLabel="Move up"
        accessibilityState={{ disabled: upDisabled }}
        testID={`${testIDPrefix}-up`}
      >
        <Text style={styles.smallButtonText}>↑</Text>
      </Pressable>
      <Pressable
        onPress={onDown}
        disabled={downDisabled}
        style={[styles.smallButton, downDisabled && styles.disabled]}
        accessibilityRole="button"
        accessibilityLabel="Move down"
        accessibilityState={{ disabled: downDisabled }}
        testID={`${testIDPrefix}-down`}
      >
        <Text style={styles.smallButtonText}>↓</Text>
      </Pressable>
      <Pressable
        onPress={onRemove}
        style={styles.smallButton}
        accessibilityRole="button"
        accessibilityLabel={removeLabel}
        testID={`${testIDPrefix}-remove`}
      >
        <Text style={[styles.smallButtonText, styles.removeText]}>✕</Text>
      </Pressable>
    </RNView>
  );
}

function ItemRow({
  item,
  index,
  total,
  meta,
  phases,
  onMove,
  onRemove,
  onPatch,
}: {
  item: ItemDraft;
  index: number;
  total: number;
  meta: { name: string; position: string } | undefined;
  phases: PhaseDraft[];
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onPatch: (patch: Partial<CurriculumItemWrite>) => void;
}) {
  const [open, setOpen] = useState(false);
  const isConcept = item.kind === 'concept';
  // An EXPLICIT flag, not derived from the volume fields — see
  // `CurriculumBuilder.tsx`'s identical comment. Deriving it made clearing
  // both anchors on a defence-only item collapse the row back to "+ Add
  // completion criteria" while the draft still carried the other fields, so
  // the save 400'd on a rule the row no longer showed anything about.
  const hasCriteria =
    open ||
    item.target_scored != null ||
    item.target_defended != null ||
    item.target_sessions != null ||
    item.min_hit_rate != null ||
    item.target_drilled_sessions != null;

  const title = isConcept ? item.title || '(untitled concept)' : meta?.name ?? item.technique_id ?? '';

  return (
    <RNView style={styles.card} testID={`curriculum-item-${index}`}>
      {isConcept ? (
        <RNView style={styles.cardBody}>
          <TextInput
            value={item.title ?? ''}
            onChangeText={(t) => onPatch({ title: t })}
            placeholder="Concept title — an idea, not a technique"
            placeholderTextColor={vola.textDim}
            style={styles.inputCompact}
            accessibilityLabel={`Title of concept ${title}`}
            testID={`curriculum-item-${index}-title`}
          />
          <TextInput
            value={item.notes ?? ''}
            onChangeText={(t) => onPatch({ notes: t })}
            placeholder="The idea itself (optional)"
            placeholderTextColor={vola.textDim}
            style={styles.inputCompact}
            multiline
            accessibilityLabel={`Body of concept ${title}`}
            testID={`curriculum-item-${index}-notes`}
          />
        </RNView>
      ) : (
        <RNView style={styles.cardBody}>
          <Text style={styles.itemName}>{title}</Text>
          {meta?.position && <Text style={styles.muted}>{meta.position}</Text>}
        </RNView>
      )}

      {phases.length > 0 && (
        <RNView style={styles.chipRow}>
          <PhaseChip
            label="No phase"
            selected={item.phase == null}
            onPress={() => onPatch({ phase: null })}
            testID={`curriculum-item-${index}-phase-none`}
          />
          {phases.map((p, i) => (
            <PhaseChip
              key={p._key}
              label={p.title || `Phase ${i + 1}`}
              selected={item.phase === i}
              onPress={() => onPatch({ phase: i })}
              testID={`curriculum-item-${index}-phase-${i}`}
            />
          ))}
        </RNView>
      )}

      {!isConcept &&
        (!hasCriteria ? (
          <Pressable
            onPress={() => {
              setOpen(true);
              onPatch({
                target_scored: CRITERIA_DEFAULTS.target_scored,
                target_defended: CRITERIA_DEFAULTS.target_defended,
                target_sessions: CRITERIA_DEFAULTS.target_sessions,
                min_hit_rate: CRITERIA_DEFAULTS.min_hit_rate,
              });
            }}
            accessibilityRole="button"
            testID={`curriculum-item-${index}-add-criteria`}
          >
            <Text style={styles.linkText}>+ Add completion criteria</Text>
          </Pressable>
        ) : (
          <RNView style={styles.criteria}>
            <NumField
              label="Land it"
              value={item.target_scored}
              onChange={(v) =>
                onPatch(v == null ? { target_scored: null, min_hit_rate: null } : { target_scored: v })
              }
              testID={`curriculum-item-${index}-target-scored`}
            />
            <NumField
              label="Stop theirs"
              value={item.target_defended}
              onChange={(v) => onPatch({ target_defended: v })}
              testID={`curriculum-item-${index}-target-defended`}
            />
            <NumField
              label="Sessions"
              value={item.target_sessions}
              onChange={(v) => onPatch({ target_sessions: v })}
              testID={`curriculum-item-${index}-target-sessions`}
            />
            <NumField
              label="Classes drilled"
              value={item.target_drilled_sessions}
              onChange={(v) => onPatch({ target_drilled_sessions: v })}
              testID={`curriculum-item-${index}-target-drilled`}
            />
            <NumField
              label="Hit rate %"
              disabled={item.target_scored == null}
              value={item.min_hit_rate == null ? null : Math.round(item.min_hit_rate * 100)}
              onChange={(v) => onPatch({ min_hit_rate: v == null ? null : v / 100 })}
              testID={`curriculum-item-${index}-hit-rate`}
            />
            <Pressable
              onPress={() => {
                setOpen(false);
                onPatch({
                  target_scored: null,
                  target_defended: null,
                  target_sessions: null,
                  min_hit_rate: null,
                  target_drilled_sessions: null,
                });
              }}
              accessibilityRole="button"
              testID={`curriculum-item-${index}-remove-criteria`}
            >
              <Text style={styles.linkTextSmall}>Remove criteria — just something to study</Text>
            </Pressable>
          </RNView>
        ))}

      <RowActions
        onUp={() => onMove(-1)}
        onDown={() => onMove(1)}
        onRemove={onRemove}
        upDisabled={index === 0}
        downDisabled={index === total - 1}
        removeLabel={`Remove ${title}`}
        testIDPrefix={`curriculum-item-${index}`}
      />
    </RNView>
  );
}

function PhaseChip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  const accent = useAccent();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.chip, styles.chipSmall, selected && { backgroundColor: accent.accent, borderColor: accent.accent }]}
      testID={testID}
    >
      <Text style={[styles.chipText, selected && { color: accent.on }]}>{label}</Text>
    </Pressable>
  );
}

/** A clamped positive-integer field — empty clears the target rather than
 *  sending 0, which the schema refuses. Clamped here rather than left to the
 *  keyboard type, since a paste or a locale's decimal separator can still
 *  produce something `Math.floor`+`> 0` has to catch. */
function NumField({
  label,
  value,
  onChange,
  disabled,
  testID,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  testID: string;
}) {
  const shown = value == null ? '' : String(value);
  return (
    <RNView style={styles.numField}>
      <Text style={styles.numLabel}>{label}</Text>
      <TextInput
        value={shown}
        editable={!disabled}
        keyboardType="number-pad"
        inputMode="numeric"
        placeholder="—"
        placeholderTextColor={vola.textDim}
        style={[styles.numInput, disabled && styles.disabled]}
        accessibilityLabel={label}
        onChangeText={(text) => {
          const raw = text.trim();
          if (raw === '') {
            onChange(null);
            return;
          }
          const n = Math.floor(Number(raw));
          onChange(Number.isFinite(n) && n > 0 ? n : null);
        }}
        testID={testID}
      />
    </RNView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 14, paddingBottom: 64 },
  pickerWrap: { flex: 1, padding: 16 },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600', color: vola.textMuted },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  inputCompact: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  builderHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 20,
  },
  builderHeadLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, color: vola.textDim },
  builderHeadAction: { fontSize: 13, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipSmall: { paddingVertical: 5 },
  chipText: { fontSize: 13, fontWeight: '600', color: vola.text },
  muted: { color: vola.textMuted, fontSize: 13, lineHeight: 18 },
  countable: { color: vola.textDim, fontSize: 12 },
  card: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 14,
    backgroundColor: vola.surface,
    padding: 12,
    gap: 10,
  },
  cardBody: { gap: 8 },
  itemName: { fontSize: 15, fontWeight: '600', color: vola.text },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  smallButton: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
  },
  smallButtonText: { fontWeight: '600', fontSize: 14, color: vola.text },
  removeText: { color: vola.danger },
  disabled: { opacity: 0.35 },
  linkText: { fontSize: 14, color: vola.textMuted, fontWeight: '600' },
  linkTextSmall: { fontSize: 12, color: vola.textDim },
  criteria: { gap: 8 },
  numField: { gap: 4 },
  numLabel: { fontSize: 12, color: vola.textMuted },
  numInput: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  addRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  addButton: {
    flexGrow: 1,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: vola.line,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  addButtonText: { fontWeight: '700', fontSize: 14, color: vola.text },
  error: { color: vola.danger, fontSize: 14 },
  saveRow: { gap: 10, marginTop: 4 },
  save: { borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  saveOff: { opacity: 0.5 },
  saveText: { fontSize: 16, fontWeight: '700' },
  cancelText: { fontSize: 14, color: vola.textMuted, textAlign: 'center' },
});
