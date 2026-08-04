import { listExerciseVocabularies } from "@/lib/api";
import { ContentNav } from "../../ContentNav";
import { ExerciseForm } from "../../ExerciseForm";
import { createExerciseAction } from "../../exerciseActions";

/**
 * The vocabularies are fetched, not listed here — they come from the same maps
 * the seeder validates against, so the dropdowns and the validator cannot
 * disagree.
 */
export default async function NewExercisePage() {
  const vocabularies = await listExerciseVocabularies();

  return (
    <div className="min-h-screen w-full">
      <ContentNav title="New exercise" />
      <main className="max-w-4xl px-10 py-8">
        <p className="mb-6 max-w-2xl text-[13px] text-text-secondary">
          Search the catalog first — 504 entries is enough that a variation you have in mind is
          often already there under a name you would not have guessed. Two ids for one exercise
          cannot be undone: both stay referenced in whatever workouts and logged sets already
          point at them.
        </p>
        <ExerciseForm mode="create" vocabularies={vocabularies} action={createExerciseAction} />
      </main>
    </div>
  );
}
