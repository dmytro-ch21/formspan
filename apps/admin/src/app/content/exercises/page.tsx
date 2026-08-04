import Link from "next/link";

import { listAuthoredExercises } from "@/lib/api";
import { formatUTC } from "@/lib/format";
import { ContentNav, OwnershipNote } from "../ContentNav";

/**
 * The exercises this console owns.
 *
 * Deliberately NOT the whole catalog: `PATCH` refuses a seeded row, so listing
 * all 504 would offer hundreds that 409 when clicked.
 */
export default async function ExerciseContentPage() {
  const exercises = await listAuthoredExercises();

  return (
    <div className="min-h-screen w-full">
      <ContentNav
        current="exercises"
        title="Exercises"
        subtitle={`${exercises.length} authored here`}
        action={{ href: "/content/exercises/new", label: "New exercise" }}
      />
      <main className="flex flex-col gap-6 px-10 py-8">
        <OwnershipNote catalog="Exercises" file="exercises.json" />

        {exercises.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-[13px] text-text-secondary">
            Nothing authored yet.{" "}
            <Link href="/content/exercises/new" className="underline">
              Add an exercise
            </Link>{" "}
            — the variation you programme that the catalog does not have.
          </p>
        ) : (
          <div>
            <div className="grid grid-cols-[1.5fr_1.4fr_0.8fr_1fr_1fr] px-3 pb-2 font-barlow-condensed text-[9px] font-bold tracking-[0.16em] text-text-muted uppercase">
              <span>Name</span>
              <span>Id</span>
              <span>Sport</span>
              <span>Pattern</span>
              <span className="justify-self-end">Updated</span>
            </div>
            <div className="flex flex-col">
              {exercises.map((e, i) => (
                <Link
                  key={e.id}
                  href={`/content/exercises/${e.id}`}
                  className={`grid grid-cols-[1.5fr_1.4fr_0.8fr_1fr_1fr] items-center rounded-lg px-3 py-4 text-[13.5px] ${
                    i % 2 === 0 ? "bg-card" : ""
                  }`}
                >
                  <span className="font-semibold">{e.name}</span>
                  <span className="truncate font-mono text-[12px] text-text-secondary">
                    {e.id}
                  </span>
                  <span className="text-text-secondary">{e.sport}</span>
                  <span className="truncate text-text-secondary">{e.movement_pattern}</span>
                  <span className="justify-self-end text-text-secondary">
                    {formatUTC(e.updated_at ?? null)}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
