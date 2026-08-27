import { Stack, useRouter } from 'expo-router';

import { CurriculumEditor } from '@/components/curriculum/CurriculumEditor';
import { type Curriculum } from '@/lib/curriculum';
import { useAuthToken } from '@/lib/useAuthToken';

/**
 * Build a curriculum from scratch, on the phone (N83). See
 * `CurriculumEditor`'s own doc comment for what is reduced from web's
 * two-pane builder and why each reduction holds up.
 *
 * Lands on the roadmap viewer for the curriculum it just created — the same
 * place web's builder pushes to, and the screen an athlete needs next: it is
 * where enrolling and, once N83 lands there too, editing again both live.
 */
export default function NewCurriculumScreen() {
  const router = useRouter();
  const getToken = useAuthToken();

  return (
    <>
      <Stack.Screen options={{ title: 'New curriculum' }} />
      <CurriculumEditor
        getToken={getToken}
        onSaved={(c: Curriculum) => router.replace(`/curriculum/${c.id}`)}
        onCancel={() => router.back()}
      />
    </>
  );
}
