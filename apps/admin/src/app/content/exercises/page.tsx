import Link from "next/link";

import { listAuthoredExercises } from "@/lib/api";
import { formatUTC } from "@/lib/format";
import { AdminMasthead } from "../../AdminMasthead";
import { OwnershipNote } from "../ContentNav";

/**
 * What the console authored, plus a search box that reaches the whole catalog.
 *
 * The default is deliberately NOT all 504 — that is payload to render a list,
 * and the authored set is what you were last working on. Search is how you
 * reach the rest, which became editable when the spreadsheet was retired. The
 * old comment here said `PATCH` refuses a seeded row; it has not since step 2.
 */
export default async function ExerciseContentPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  const raw = Array.isArray(q) ? q[0] : q;
  const query = raw?.trim() ?? "";
  const exercises = await listAuthoredExercises(query);

  return (
    <div className="min-h-screen w-full">
      <AdminMasthead
        title="Exercises"
        section="exercises"
        meta={
          query
            ? // The API caps search at 100; "100 matching" would read as
              // complete when it is a ceiling.
              `${exercises.length === 100 ? "first 100" : exercises.length} matching "${query}"`
            : `${exercises.length} authored here`
        }
        action={
          <Link
            href="/content/exercises/new"
            className="rounded-[10px] bg-accent-dark px-4 py-2 font-semibold text-page no-underline"
          >
            New exercise
          </Link>
        }
      />
      <main className="flex flex-col gap-6 px-10 py-8">
        <OwnershipNote catalog="Exercises" file="exercises.json" />

        {/* A plain GET form: no client component, and a result is a URL. */}
        <form className="flex gap-2" action="/content/exercises">
          <label htmlFor="exercise-search" className="sr-only">
            Search exercises
          </label>
          <input
            id="exercise-search"
            type="search"
            name="q"
            // `key` remounts on a client-side nav (the Clear link), or the
            // uncontrolled input keeps showing the query it just cleared.
            key={query}
            defaultValue={query}
            placeholder="Search the whole catalog by name or id…"
            className="w-full max-w-md rounded-[10px] border border-border-strong bg-card px-3 py-2 text-[13.5px] text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark"
          />
          <button
            type="submit"
            className="rounded-[10px] border border-border px-4 py-2 text-[13px] font-semibold"
          >
            Search
          </button>
          {query ? (
            <Link href="/content/exercises" className="self-center text-[13px] underline">
              Clear
            </Link>
          ) : null}
        </form>

        {exercises.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-[13px] text-text-secondary">
            {query ? (
              <>Nothing matches “{query}”. Try a shorter term.</>
            ) : (
              <>
                Nothing authored yet.{" "}
                <Link href="/content/exercises/new" className="underline">
                  Add an exercise
                </Link>{" "}
                — the variation you programme that the catalog does not have. Or search above
                to edit one that already exists.
              </>
            )}
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
                  <span className="font-semibold">
                    {e.name}
                    {e.status === "draft" ? (
                      <span className="ml-2 rounded-full border border-accent-dark px-2 py-0.5 align-middle font-barlow-condensed text-[9px] font-bold tracking-[0.12em] text-text uppercase">
                        Draft
                      </span>
                    ) : null}
                  </span>
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
