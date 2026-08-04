import { listPositions } from "@/lib/api";
import { AdminMasthead } from "../../AdminMasthead";
import { createTechniqueAction } from "../actions";
import { TechniqueForm } from "../TechniqueForm";

/**
 * Authoring a technique that is not in the library.
 *
 * The position vocabulary is fetched rather than listed here — it is derived
 * server-side from the catalog, so the dropdown and the validator cannot
 * disagree. A hardcoded copy is how a technique ends up filed under a position
 * no filter matches: it renders fine and returns nothing forever.
 */
export default async function NewTechniquePage() {
  const positions = await listPositions();

  return (
    <div className="min-h-screen w-full">
      <AdminMasthead title="New technique" back={{ href: "/content", label: "Back to content" }} />

      <main className="max-w-4xl px-10 py-8">
        <p className="mb-6 max-w-2xl text-[13px] text-text-secondary">
          Check the library first. A technique that looks missing is often only unfindable —
          search folds accents and dashes now, but a name you half-remember may still need an
          alias rather than a new entry. Two ids for one technique cannot be undone: both stay
          referenced in whatever training records already point at them.
        </p>
        <TechniqueForm mode="create" positions={positions} action={createTechniqueAction} />
      </main>
    </div>
  );
}
