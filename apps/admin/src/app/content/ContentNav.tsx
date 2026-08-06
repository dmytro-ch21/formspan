/**
 * The ownership note both catalog screens carry.
 *
 * Rewritten twice in two days, which is the point of keeping it in one file:
 * it described a spreadsheet that no longer exists, and then a refusal that no
 * longer happens. It is the only place the console explains who owns what, so
 * it is the first thing to go stale when ownership changes.
 *
 * This file also held a `ContentNav` header, which `AdminMasthead` now does
 * console-wide and better — it carries the brand mark, the section links and
 * `aria-current` for every screen rather than just these two. Deleted rather
 * than kept beside it: two mastheads is how the console got six of them.
 */
export function OwnershipNote({ catalog, file }: { catalog: string; file: string }) {
  return (
    <p className="max-w-3xl rounded-lg border border-border bg-card px-4 py-3 text-[13px] text-text-secondary">
      {catalog} written here are live immediately — no deploy.{" "}
      <strong className="text-text">
        Editing any row takes ownership of it
      </strong>
      : the write marks it <code className="font-mono">source=admin</code>, which the seeder
      skips, so a release never reverts your change — and never updates that row again either.
      <br />
      <br />
      <strong className="text-text">A release does not carry your edits until they are
      exported.</strong>{" "}
      Run <code className="font-mono">go run ./cmd/exportcontent</code> to write them into{" "}
      <code className="font-mono">{file}</code>, review that diff and merge it, then{" "}
      <code className="font-mono">-adopt</code> to hand the rows back to the deploy.
    </p>
  );
}
