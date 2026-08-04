import Link from "next/link";

import { listAuthoredTechniques } from "@/lib/api";
import { formatUTC } from "@/lib/format";

/**
 * The techniques this console owns.
 *
 * Deliberately NOT the whole catalog. `PATCH /v1/admin/techniques/{id}` refuses
 * a seeded row — the JSON owns those and an edit here would be reverted by the
 * next deploy — so listing all 466 would offer hundreds of rows that 409 when
 * clicked. The empty state and the note below say where the rest live instead.
 */
export default async function ContentPage() {
  const techniques = await listAuthoredTechniques();

  return (
    <div className="min-h-screen w-full">
      <header className="flex w-full items-center justify-between border-b border-border bg-card px-10 py-5">
        <div className="flex items-center gap-4">
          <h1 className="font-barlow-condensed text-[17px] font-bold tracking-[0.1em] uppercase">
            Content
          </h1>
          <span className="text-[13px] text-text-secondary">
            {techniques.length} authored here
          </span>
        </div>
        <nav className="flex items-center gap-5 text-[13px] text-text-secondary">
          <Link href="/users" className="underline">
            Users
          </Link>
          <Link href="/health" className="underline">
            Health
          </Link>
          <Link
            href="/content/new"
            className="rounded-[10px] bg-accent-dark px-4 py-2 font-semibold text-page no-underline"
          >
            New technique
          </Link>
        </nav>
      </header>

      <main className="flex flex-col gap-6 px-10 py-8">
        <p className="max-w-3xl rounded-lg border border-border bg-card px-4 py-3 text-[13px] text-text-secondary">
          Techniques written here are live in the catalog immediately — no deploy. They are
          marked <code className="font-mono">source=admin</code>, which the seeder cannot
          touch, so a release never reverts them.{" "}
          <strong className="text-text">
            A release does not carry them either until they are exported.
          </strong>{" "}
          Run <code className="font-mono">go run ./cmd/exportcontent</code> to write them into
          the seed files, review that diff, and merge it.
          <br />
          <br />
          The rest of the library — everything from the spreadsheet — is owned by the deploy
          and is not editable here. Editing one of those means editing{" "}
          <code className="font-mono">techniques.json</code> and releasing.
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
