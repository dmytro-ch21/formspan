import { notFound } from "next/navigation";

import { ApiError, getTechnique, listAuthoredTechniques, listPositions } from "@/lib/api";
import { AdminMasthead } from "../../AdminMasthead";
import { updateTechniqueAction } from "../actions";
import { TechniqueForm } from "../TechniqueForm";

/**
 * Editing one authored technique.
 *
 * Ownership comes from `listAuthoredTechniques`, NOT from a `source` field on
 * the technique. That is deliberate and was got wrong first: the public
 * `GET /techniques/{id}` does not select `source` — it is not in the contract
 * for that endpoint, by design — so reading `technique.source !== "admin"`
 * marked *everything* deploy-owned, including the row the console had just
 * written. The admin list is the one definition of what this console owns, the
 * same one `cmd/exportcontent` reads, so it cannot disagree with the list
 * screen about which techniques are editable.
 *
 * Three outcomes, all reachable by typing a URL:
 *  - in the authored list  → the form, populated from that row (which carries
 *    every field, so no second request).
 *  - not authored but real → seeded, and the fix is a completely different one:
 *    edit the JSON and release. Saying so is the difference between a dead end
 *    and a next step.
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

  if (!technique) {
    // Only now is a second request worth making, and only to tell "seeded"
    // from "no such thing" — two states that need different copy.
    const seeded = await getTechnique(id).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });
    if (!seeded) notFound();

    return (
      <div className="min-h-screen w-full">
        <AdminMasthead
          title={seeded.name}
          meta={<code className="font-mono text-[12px]">{seeded.id}</code>}
          back={{ href: "/content", label: "Back to content" }}
        />
        <main className="max-w-4xl px-10 py-8">
          <div className="flex flex-col gap-3 rounded-lg border border-danger-border bg-danger-bg px-5 py-4 text-[13px] text-danger-text">
            <p>
              <strong>This one comes from the seeded library, so a deploy owns it.</strong> The
              API would refuse an edit here, and it is right to: the seeder rewrites this row
              on every release, so a change made in the console would be silently reverted.
            </p>
            <p>
              To change it, edit{" "}
              <code className="font-mono">
                backend/internal/modules/technique/techniques.json
              </code>{" "}
              and release. The form is not shown rather than shown-and-rejected, because a save
              button that always fails is worse than no save button.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full">
      <AdminMasthead
        title={technique.name}
        meta={<code className="font-mono text-[12px]">{technique.id}</code>}
        back={{ href: "/content", label: "Back to content" }}
      />

      <main className="max-w-4xl px-10 py-8">
        <TechniqueForm
          mode="edit"
          positions={positions}
          initial={technique}
          action={updateTechniqueAction.bind(null, technique.id)}
        />
      </main>
    </div>
  );
}
