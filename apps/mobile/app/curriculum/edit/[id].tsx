import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { HoldToConfirm } from '@/components/HoldToConfirm';
import { CurriculumEditor } from '@/components/curriculum/CurriculumEditor';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { deleteCurriculum, getCurriculum, type Curriculum } from '@/lib/curriculum';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Correct an existing curriculum, on the phone (N83) — the edit half of
 * `curriculum/new.tsx`, split into its own route rather than a mode flag on
 * the belt-roadmap viewer (`curriculum/[id].tsx`), because that screen's own
 * doc comment is explicit about what it refuses to be: "It does not offer a
 * checkbox, and cannot" — it reads back logged evidence, and bolting an
 * authoring form onto it would blur the one property that screen exists to
 * hold.
 *
 * `/curriculum/edit/:id` rather than the web app's `/curricula/:id/edit`:
 * this app's viewer already owns the filename `curriculum/[id].tsx`, and
 * Expo Router — like Next.js — cannot have a dynamic FILE and a same-named
 * dynamic FOLDER as siblings. Putting `edit` before the id avoids that
 * collision without restructuring the viewer.
 */
export default function EditCurriculumScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const getToken = useAuthToken();

  const [curriculum, setCurriculum] = useState<Curriculum | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setCurriculum(await getCurriculum(getToken, id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [getToken, id]);

  // On focus, not on mount — matching `curriculum/[id].tsx`'s own load, so
  // the `curriculum` state itself is never staler than it has to be.
  //
  // **This does NOT re-seed `CurriculumEditor`'s draft.** Its name/items/
  // etc. are seeded once from `existing` via a lazy `useState` initializer,
  // which does not re-run when the `existing` prop changes underneath it —
  // so a refetch here updates what THIS screen would render if it re-mounted,
  // not what the athlete is currently typing into. Harmless today because
  // nothing else currently links out from this screen while it's open (there
  // is no second editor of the same curriculum to race), but worth fixing
  // properly (e.g. keying `CurriculumEditor` on something that changes per
  // save, such as a future `updated_at`) before anything does.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const deleteNow = useCallback(async () => {
    if (!curriculum) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteCurriculum(getToken, curriculum.id);
      router.replace('/curriculum');
    } catch (err) {
      setDeleting(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [curriculum, getToken, router]);

  if (error && !curriculum) {
    return (
      <View style={styles.centre}>
        <Stack.Screen options={{ title: 'Edit curriculum' }} />
        <Text style={styles.error} testID="curriculum-edit-error">
          {error}
        </Text>
      </View>
    );
  }

  if (!curriculum) {
    return (
      <View style={styles.centre}>
        <Stack.Screen options={{ title: 'Edit curriculum' }} />
        <ActivityIndicator accessibilityLabel="Loading curriculum" testID="curriculum-edit-loading" />
      </View>
    );
  }

  // Resolved server-side — never inferred from ownership fields the client
  // does not reliably have. A belt syllabus or another athlete's shared
  // curriculum both read `editable: false`, and the server's PATCH/DELETE
  // refuse them anyway; this just says so before the athlete fills in a form
  // that can only 403.
  if (!curriculum.editable) {
    return (
      <View style={styles.centre}>
        <Stack.Screen options={{ title: 'Edit curriculum' }} />
        <Text style={styles.error} testID="curriculum-edit-not-editable">
          This one isn&apos;t yours to edit.
        </Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Edit curriculum' }} />
      <CurriculumEditor
        existing={curriculum}
        getToken={getToken}
        onSaved={(c: Curriculum) => router.replace(`/curriculum/${c.id}`)}
        onCancel={() => router.back()}
        footer={
          <>
            <HoldToConfirm
              label="Delete curriculum"
              holdingLabel="Keep holding to delete…"
              confirmTitle="Delete curriculum?"
              confirmBody={`"${curriculum.name}" will be removed. This can't be undone.`}
              style={styles.deleteButton}
              textStyle={styles.deleteText}
              fillColor={vola.danger}
              destructive
              testID="curriculum-delete"
              onConfirm={() => void deleteNow()}
            />
            {/* A failed delete used to be silent: `deleteNow`'s catch set
                `error`, but the only branch that ever rendered it was the
                initial-load failure above — a HoldToConfirm can fire, the
                overlay flash and vanish, and the athlete would have no way
                to tell the curriculum still exists. Rendered here, next to
                the control that just failed, matching where
                `curriculum/[id].tsx`'s own delete-confirm errors surface. */}
            {error && (
              <Text
                style={styles.deleteError}
                accessibilityLiveRegion="polite"
                testID="curriculum-delete-error"
              >
                {error}
              </Text>
            )}
          </>
        }
      />
      {deleting && (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator accessibilityLabel="Deleting" />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { color: vola.danger, fontSize: 14, textAlign: 'center' },
  deleteButton: { alignItems: 'center', paddingVertical: 16, marginTop: 8 },
  deleteText: { color: vola.danger, fontWeight: '600' },
  deleteError: { color: vola.danger, fontSize: 13, textAlign: 'center', marginTop: 4 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
