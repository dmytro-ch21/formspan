import { listModules, type Module } from "@/lib/modules";
import { fetchUnits, type Units } from "@/lib/unitSystem";

type Token = (opts?: { template?: string }) => Promise<string | null>;

export type Shell = { modules: Module[] } & Units;

/**
 * The dashboard shell's two server reads, started together — N159 (#576).
 *
 * Each read now ends at the request deadline. Awaited one after the other, a
 * hung API cost the shell two deadlines (60s) before it painted; started
 * together, it costs one. **Neither can fail the other**, which is what makes
 * running them at once a change to the wait and nothing else:
 *
 * - a modules failure falls back to an empty list, which the nav reads as
 *   ungated — degrading toward the pre-gating app, which is merely untidy,
 *   rather than hiding Library and Records as though that were a decision;
 * - `fetchUnits` never throws, and degrades to metric/grams.
 *
 * Directiveless for the same reason `modules.ts` and `unitSystem.ts` are: the
 * layout that calls it is a Server Component.
 */
export async function readShell(getToken: Token): Promise<Shell> {
  const [modules, units] = await Promise.all([
    listModules(getToken).catch((): Module[] => []),
    fetchUnits(getToken),
  ]);
  return { modules, ...units };
}
