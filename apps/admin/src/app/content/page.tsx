import Link from "next/link";

import { listAuthoredTechniques } from "@/lib/api";
import { formatUTC } from "@/lib/format";
import { AdminMasthead } from "../AdminMasthead";
import { OwnershipNote } from "./ContentNav";

/**
 * What the console authored, plus a search box that reaches the whole catalog.
 *
 * The default is deliberately NOT all 542: that is ~570 KB of mostly prose to
 * render a list, and the authored set is the useful default — it is what you
 * were last working on and what `exportcontent -adopt` drains. Search is how
 * you reach the other 450, which became editable when the authoring
 * spreadsheet was retired. Server-rendered from a plain GET form, so a result
 * page is a URL you can keep.
 */
export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  // `?q=a&q=b` arrives as an array at runtime whatever the type says, and
  // `.trim()` on one would 500 the page. It is a hand-editable URL on an admin
  // tool, so take the first and move on.
  const raw = Array.isArray(q) ? q[0] : q;
  const query = raw?.trim() ?? "";
  const techniques = await listAuthoredTechniques(query);

  return (
    <div className="min-h-screen w-full">
      <AdminMasthead
        title="Techniques"
        section="content"
        meta={
          query
            ? // The API caps search at 100. Saying "100 matching" would read as
              // complete when it is a ceiling — the same silent truncation the
              // authored list refuses to do.
              `${techniques.length === 100 ? "first 100" : techniques.length} matching "${query}"`
            : `${techniques.length} authored here`
        }
        action={
          <Link
            href="/content/new"
            className="rounded-[10px] bg-accent-dark px-4 py-2 font-semibold text-page no-underline"
          >
            New technique
          </Link>
        }
      />

      <main className="flex flex-col gap-6 px-10 py-8">
        <OwnershipNote catalog="Techniques" file="techniques.json" />

        {/* A plain GET form: no client component, no state, and the result is a
            shareable URL. `defaultValue` rather than `value` so the field stays
            uncontrolled and typing does not need React. */}
        <form className="flex gap-2" action="/content">
          <label htmlFor="technique-search" className="sr-only">
            Search techniques
          </label>
          <input
            id="technique-search"
            type="search"
            name="q"
            // `key` so a client-side nav (the Clear link) REMOUNTS the input.
            // Without it React keeps the uncontrolled DOM value and the box goes
            // on showing the query it just cleared.
            key={query}
            defaultValue={query}
            placeholder="Search the whole catalog by name, id or alias…"
            className="w-full max-w-md rounded-[10px] border border-border-strong bg-card px-3 py-2 text-[13.5px] text-text placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dark"
          />
          <button
            type="submit"
            className="rounded-[10px] border border-border px-4 py-2 text-[13px] font-semibold"
          >
            Search
          </button>
          {query ? (
            <Link href="/content" className="self-center text-[13px] underline">
              Clear
            </Link>
          ) : null}
        </form>

        {/* The Description field is parsed rather than displayed, and nothing on
            the form said so until this existed. Linked from the list as well as
            from the field, because the useful time to read it is before writing
            a technique rather than halfway through one. */}
        <p className="text-[13px] text-text-secondary">
          Writing one for the first time?{" "}
          <Link href="/content/guide" className="underline">
            Read the writing guide
          </Link>{" "}
          — the description is split into numbered steps, and how you punctuate it decides
          whether that works.
        </p>

        {techniques.length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-[13px] text-text-secondary">
            {query ? (
              <>Nothing matches “{query}”. Try a shorter term, or an alias.</>
            ) : (
              <>
                Nothing authored yet. <Link href="/content/new" className="underline">Add a
                technique</Link> — the one you saw in class and could not find in the library.
                Or search above to edit one that already exists.
              </>
            )}
          </p>
        ) : (
          <div>
            <div className="grid grid-cols-[1.5fr_1.4fr_0.9fr_1.2fr_1fr] px-3 pb-2 font-barlow-condensed text-[9px] font-bold tracking-[0.16em] text-text-muted uppercase">
              <span>Name</span>
              <span>Id</span>
              <span>Category</span>
              <span>Position</span>
              <span className="justify-self-end">{query ? "Owner" : "Updated"}</span>
            </div>
            <div className="flex flex-col">
              {techniques.map((t, i) => (
                <Link
                  key={t.id}
                  href={`/content/${t.id}`}
                  className={`grid grid-cols-[1.5fr_1.4fr_0.9fr_1.2fr_1fr] items-center rounded-lg px-3 py-4 text-[13.5px] ${
                    i % 2 === 0 ? "bg-card" : ""
                  }`}
                >
                  <span className="font-semibold">
                    {t.name}
                    {/* Drafts are the rows that need finishing, so they are
                        marked rather than left to be inferred from a column
                        that only appears in search results. */}
                    {t.status === "draft" ? (
                      <span className="ml-2 rounded-full border border-accent-dark px-2 py-0.5 align-middle font-barlow-condensed text-[9px] font-bold tracking-[0.12em] text-text uppercase">
                        Draft
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate font-mono text-[12px] text-text-secondary">
                    {t.id}
                  </span>
                  <span className="text-text-secondary">{t.category}</span>
                  <span className="truncate text-text-secondary">{t.position}</span>
                  <span className="justify-self-end text-text-secondary">
                    {/* In search results the useful column is WHO OWNS IT:
                        editing a `seed` row moves it to `admin`, which is the
                        thing an operator should be able to see before and
                        after. The authored list is all `admin` by definition,
                        so it shows the timestamp instead. */}
                    {query ? (t.source === "admin" ? "console" : "deploy") : formatUTC(t.updated_at ?? null)}
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
