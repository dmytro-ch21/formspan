import { notFound } from "next/navigation";

import { ApiError, getTechnique, listAuthoredTechniques, listPositions } from "@/lib/api";
import { AdminMasthead } from "../../AdminMasthead";
import { updateTechniqueAction } from "../actions";
import { TechniqueForm } from "../TechniqueForm";

/**
 * Editing one technique — any technique.
 *
 * Ownership comes from `listAuthoredTechniques`, NOT from a `source` field on
 * the technique. That is deliberate and was got wrong first: the public
 * `GET /techniques/{id}` does not select `source` — it is not in the contract
 * for that endpoint, by design — so reading `technique.source !== "admin"`
 * marked *everything* deploy-owned, including the row the console had just
 * written. The admin list is the one definition of what this console owns, the
 * same one `cmd/exportcontent` reads.
 *
 * What ownership decides is now the WARNING, not whether there is a form. It
 * used to be the latter: a deploy-owned row got a dead end explaining that the
 * API would refuse the edit. Since the authoring spreadsheet was retired the
 * API refuses nothing — a PATCH takes ownership of the row instead — so the
 * dead end became a false refusal in front of an edit that works, on rows the
 * list screen now deliberately surfaces through search.
 *
 * Three outcomes, all reachable by typing a URL:
 *  - in the authored list  → the form, populated from that row (which carries
 *    every field, so no second request).
 *  - not authored but real → the same form, plus a notice that saving takes the
 *    row off the deploy. Silent transfer would be worse than the old dead end:
 *    the operator would move a row between two writers without being told.
 *  - not authored, 404     → genuinely no such id.
 */
export default async function EditTechniquePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [authored, positions] = await Promise.all([
    listAuthoredTechniques(),
    listPositions(),
  ]);
  const technique = authored.find((t) => t.id === id);

  // Only when it is not ours is a second request worth making — both to fill
  // the form and to tell "deploy-owned" from "no such thing".
  const seeded = technique
    ? null
    : await getTechnique(id).catch((err) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      });
  if (!technique && !seeded) notFound();

  const initial = technique ?? seeded!;

  return (
    <div className="min-h-screen w-full">
      <AdminMasthead
        title={initial.name}
        meta={<code className="font-mono text-[12px]">{initial.id}</code>}
        back={{ href: "/content", label: "Back to techniques" }}
      />

      <main className="flex max-w-4xl flex-col gap-5 px-10 py-8">
        {seeded ? (
          // Deliberately a warning rather than a refusal, and deliberately
          // BEFORE the form: the transfer happens on save, so the place to say
          // so is where the decision is made. The list screen's Owner column
          // shows the same fact afterwards, but only if you search again.
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4 text-[13px] text-text-secondary">
            <p>
              <strong className="text-text">
                A deploy owns this one — saving takes it over.
              </strong>{" "}
              Editing it here sets its source to <code className="font-mono">admin</code>, and
              the seeder stops managing it: releases will no longer update this row, so a later
              change to <code className="font-mono">techniques.json</code> will not reach it.
            </p>
            <p>
              That is reversible, in two steps rather than one. Run{" "}
              <code className="font-mono">go run ./cmd/exportcontent</code> to write your edit
              back into the JSON, merge and release it, then{" "}
              <code className="font-mono">-adopt</code> to hand the row back to the deploy.
            </p>
          </div>
        ) : null}

        <TechniqueForm
          mode="edit"
          positions={positions}
          initial={initial}
          action={updateTechniqueAction.bind(null, initial.id)}
        />
      </main>
    </div>
  );
}
