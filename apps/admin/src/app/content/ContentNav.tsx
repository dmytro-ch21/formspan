/**
 * The ownership note both catalog screens carry.
 *
 * This file also held a `ContentNav` header, which `AdminMasthead` now does
 * console-wide and better — it carries the brand mark, the section links and
 * `aria-current` for every screen rather than just these two. Deleted rather
 * than kept beside it: two mastheads is how the console got six of them.
 */
export function OwnershipNote({ catalog, file }: { catalog: string; file: string }) {
  return (
    <p className="max-w-3xl rounded-lg border border-border bg-card px-4 py-3 text-[13px] text-text-secondary">
      {catalog} written here are live in the catalog immediately — no deploy. They are marked{" "}
      <code className="font-mono">source=admin</code>, which the seeder cannot touch, so a
      release never reverts them.{" "}
      <strong className="text-text">
        A release does not carry them either until they are exported.
      </strong>{" "}
      Run <code className="font-mono">go run ./cmd/exportcontent</code> to write them into the
      seed files, review that diff, and merge it.
      <br />
      <br />
      The rest of the library — everything from the spreadsheet — is owned by the deploy and is
      not editable here. Changing one of those means editing{" "}
      <code className="font-mono">{file}</code> and releasing —{" "}
      <strong className="text-text">
        and that edit survives only until the next spreadsheet import
      </strong>
      , which regenerates the file wholesale. A durable change to a sheet-sourced row means
      changing the sheet. Only the <code className="font-mono">*.additions.json</code> files
      survive an import, which is why the export writes both.
    </p>
  );
}
