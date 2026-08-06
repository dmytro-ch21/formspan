import Link from "next/link";

import { listAuthoredTechniques } from "@/lib/api";
import { formatUTC } from "@/lib/format";
import { AdminMasthead } from "../AdminMasthead";
import { OwnershipNote } from "./ContentNav";

/**
 * The techniques this console owns.
 *
 * Deliberately NOT the whole catalog. `PATCH /v1/admin/techniques/{id}` refuses
 * a seeded row — the JSON owns those and an edit here would be reverted by the
 * next deploy — so listing all 542 would offer hundreds of rows that 409 when
 * clicked. The empty state and the note below say where the rest live instead.
 */
export default async function ContentPage() {
  const techniques = await listAuthoredTechniques();

  return (
    <div className="min-h-screen w-full">
      <AdminMasthead
        title="Techniques"
        section="content"
        meta={`${techniques.length} authored here`}
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
            Nothing authored yet. <Link href="/content/new" className="underline">Add a
            technique</Link> — the one you saw in class and could not find in the library.
          </p>
        ) : (
          <div>
            <div className="grid grid-cols-[1.5fr_1.4fr_0.9fr_1.2fr_1fr] px-3 pb-2 font-barlow-condensed text-[9px] font-bold tracking-[0.16em] text-text-muted uppercase">
              <span>Name</span>
              <span>Id</span>
              <span>Category</span>
              <span>Position</span>
              <span className="justify-self-end">Updated</span>
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
                  <span className="font-semibold">{t.name}</span>
                  <span className="truncate font-mono text-[12px] text-text-secondary">
                    {t.id}
                  </span>
                  <span className="text-text-secondary">{t.category}</span>
                  <span className="truncate text-text-secondary">{t.position}</span>
                  <span className="justify-self-end text-text-secondary">
                    {formatUTC(t.updated_at ?? null)}
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
