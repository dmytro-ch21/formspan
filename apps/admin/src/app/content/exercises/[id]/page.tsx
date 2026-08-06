import { notFound } from "next/navigation";

import {
  ApiError,
  getExercise,
  listAuthoredExercises,
  listExerciseVocabularies,
} from "@/lib/api";
import { AdminMasthead } from "../../../AdminMasthead";
import { ExerciseForm } from "../../ExerciseForm";
import { updateExerciseAction } from "../../exerciseActions";

/**
 * Editing one exercise — any exercise.
 *
 * Ownership comes from `listAuthoredExercises`, NOT from a `source` field on the
 * exercise: the public read path does not select it, so reading it there marks
 * everything deploy-owned including the row just written. That is the mistake
 * the technique screen made first; it is the same endpoint shape here.
 *
 * What ownership decides is the WARNING, not whether there is a form — the same
 * change the technique screen made when the authoring spreadsheet was retired,
 * and for the same reason: `UpdateExercise` no longer refuses a seeded row, it
 * takes ownership of it, so a dead end here would be a false refusal in front of
 * an edit that works.
 *
 * Note the exercise list has no search yet, so a deploy-owned row is reachable
 * only by typing its URL. That is scope, not design — see the history entry.
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

  // Only when it is not ours is a second request worth making — both to fill
  // the form and to tell "deploy-owned" from "no such thing".
  const seeded = exercise
    ? null
    : await getExercise(id).catch((err) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      });
  if (!exercise && !seeded) notFound();

  const initial = exercise ?? seeded!;

  return (
    <div className="min-h-screen w-full">
      <AdminMasthead
        title={initial.name}
        meta={<code className="font-mono text-[12px]">{initial.id}</code>}
        back={{ href: "/content/exercises", label: "Back to exercises" }}
      />
      <main className="flex max-w-4xl flex-col gap-5 px-10 py-8">
        {seeded ? (
          // A warning, not a refusal, and before the form: the transfer happens
          // on save, so this is where it has to be said.
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4 text-[13px] text-text-secondary">
            <p>
              <strong className="text-text">
                A deploy owns this one — saving takes it over.
              </strong>{" "}
              Editing it here sets its source to <code className="font-mono">admin</code>, and
              the seeder stops managing it: releases will no longer update this row.
            </p>
            <p>
              Reversible in two steps. Run{" "}
              <code className="font-mono">go run ./cmd/exportcontent</code> to write the edit
              back into <code className="font-mono">exercises.json</code>, merge and release it,
              then <code className="font-mono">-adopt</code> to hand the row back.
            </p>
          </div>
        ) : null}

        <ExerciseForm
          mode="edit"
          vocabularies={vocabularies}
          initial={initial}
          action={updateExerciseAction.bind(null, initial.id)}
        />
      </main>
    </div>
  );
}
