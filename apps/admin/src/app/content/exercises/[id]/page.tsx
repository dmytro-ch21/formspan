import { notFound } from "next/navigation";

import {
  ApiError,
  getExercise,
  listAuthoredExercises,
  listExerciseVocabularies,
} from "@/lib/api";
import { ContentNav } from "../../ContentNav";
import { ExerciseForm } from "../../ExerciseForm";
import { updateExerciseAction } from "../../exerciseActions";

/**
 * Editing one authored exercise.
 *
 * Ownership comes from `listAuthoredExercises`, NOT from a `source` field on the
 * exercise: the public read path does not select it, so reading it there marks
 * everything deploy-owned including the row just written. That is the mistake
 * the technique screen made first; it is the same endpoint shape here.
 */
export default async function EditExercisePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [authored, vocabularies] = await Promise.all([
    listAuthoredExercises(),
    listExerciseVocabularies(),
  ]);
  const exercise = authored.find((e) => e.id === id);

  if (!exercise) {
    // Only now is a second request worth making, and only to tell "seeded" from
    // "no such thing" — two states that need different advice.
    const seeded = await getExercise(id).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });
    if (!seeded) notFound();

    return (
      <div className="min-h-screen w-full">
        <ContentNav title={seeded.name} subtitle={seeded.id} />
        <main className="max-w-4xl px-10 py-8">
          <div className="flex flex-col gap-3 rounded-lg border border-danger-border bg-danger-bg px-5 py-4 text-[13px] text-danger-text">
            <p>
              <strong>This one comes from the seeded catalog, so a deploy owns it.</strong> The
              API would refuse an edit here, and it is right to: the seeder rewrites this row on
              every release, so a change made in the console would be silently reverted.
            </p>
            <p>
              To change it, edit{" "}
              <code className="font-mono">
                backend/internal/modules/exercise/exercises.json
              </code>{" "}
              and release. The form is not shown rather than shown-and-rejected, because a save
              button that always fails is worse than no save button.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full">
      <ContentNav title={exercise.name} subtitle={exercise.id} />
      <main className="max-w-4xl px-10 py-8">
        <ExerciseForm
          mode="edit"
          vocabularies={vocabularies}
          initial={exercise}
          action={updateExerciseAction.bind(null, exercise.id)}
        />
      </main>
    </div>
  );
}
