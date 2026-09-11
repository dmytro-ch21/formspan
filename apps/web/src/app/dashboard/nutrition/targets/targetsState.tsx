import type { Target } from "@/lib/nutritionApi";

/**
 * What the targets page may claim about the athlete's targets, and when
 * (N127, #531).
 *
 * The page used to have no notion of having loaded. On a failed read `loading`
 * went false, `targets` stayed `[]`, and it rendered the error **and** "No
 * target yet. Derive one below, or type your own." — with the History section
 * gone too, so a request that never returned was pixel-identical to a brand-new
 * account. That is a positive claim about somebody's data made from nothing,
 * and every sibling nutrition page (`nutrition/page.tsx`, `days/page.tsx`,
 * `DayEditor.tsx`) had already been fixed for it with a `loaded` flag. This is
 * that fix, with the one difference below.
 *
 * **The load has its OWN error slot.** The page's shared `error` is written by
 * the derivation, the activity chip and three saves, and each of them clears it
 * before trying. Gating on the shared slot would let any of them turn a failed
 * load back into "Loading…" forever.
 */
export type TargetsView = "loading" | "failed" | "ready";

/**
 * `ready` once a read has ever succeeded on this visit — including a genuinely
 * empty one, which is the only thing allowed to say "No target yet". A LATER
 * refresh that fails keeps `ready`: what is on screen was really read, and the
 * page says separately that it could not be refreshed.
 */
export function targetsView(loaded: boolean, loadError: string | null): TargetsView {
  if (loaded) return "ready";
  return loadError != null ? "failed" : "loading";
}

export type TargetsSink<A> = {
  setTargets: (targets: Target[]) => void;
  setAdjustment: (adjustment: A) => void;
  setLoaded: (loaded: boolean) => void;
  setLoadError: (message: string | null) => void;
};

/**
 * The page's load, with the requests injected so a test can make them reject.
 *
 * `loaded` is set ONLY on success. (The order of the three writes on success is
 * not a guarantee anything relies on: React batches them into one render. A
 * mutation moving `setLoaded` first survives the tests for that reason, and it
 * should.) A read aborted by a newer one writes nothing after it, success or
 * failure.
 */
export async function loadTargetsInto<A>(
  read: () => Promise<[Target[], A]>,
  sink: TargetsSink<A>,
  signal: AbortSignal,
): Promise<void> {
  sink.setLoadError(null);
  try {
    const [targets, adjustment] = await read();
    if (signal.aborted) return;
    sink.setTargets(targets);
    sink.setAdjustment(adjustment);
    sink.setLoaded(true);
  } catch (e) {
    if (signal.aborted) return;
    sink.setLoadError(e instanceof Error && e.message ? e.message : "Could not load your targets.");
  }
}

const SOURCE_LABEL: Record<string, string> = {
  derived: "derived",
  manual: "typed",
  adjustment: "weekly adjustment",
};

/**
 * How a target got its number, in words — never a bare separator.
 *
 * `SOURCE_LABEL[t.source]` was indexed unguarded, so an absent source rendered
 * "2026-09-01 · " and stopped. An unknown one shows its own key, the same
 * fallback its siblings use (`BLOCKED[b]?.title ?? b`): a word nobody mapped is
 * still more than nothing.
 */
export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "source not recorded";
  return SOURCE_LABEL[source] ?? source;
}

/** The whole page, when the targets have never loaded on this visit. */
export function TargetsLoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section role="alert" className="flex flex-col gap-3 rounded-card border border-danger/40 bg-danger/10 p-4">
      <h2 className="eyebrow text-danger-ink">Your targets did not load</h2>
      <p className="text-sm text-danger-ink">{message}</p>
      <p className="text-sm text-text-muted">
        Nothing about your targets is shown until they do — so this page is not telling you whether
        you have one.
      </p>
      <div>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-control border border-line px-4 py-2 text-sm font-semibold"
        >
          Try again
        </button>
      </div>
    </section>
  );
}

/**
 * Every target set in the window, newest first — or nothing, when there are
 * none. The page renders this only in the `ready` view, so its absence is a
 * read that came back empty, never a read that failed.
 */
export function TargetHistory({ targets }: { targets: readonly Target[] }) {
  if (targets.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
      <h2 className="eyebrow">History</h2>
      <p className="text-xs text-text-dim">
        Every target you have set, newest first. Past days are judged against the target that was
        live then, so these rows are the record — not a setting with one current value.
      </p>
      <ul className="mt-1 divide-y divide-line-soft">
        {[...targets]
          .sort((a, b) => (a.effective_on < b.effective_on ? 1 : -1))
          .map((t) => (
            <li
              key={t.effective_on}
              className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 text-sm"
            >
              <span className="text-text-muted">
                {t.effective_on} · {sourceLabel(t.source)}
              </span>
              <span className="tabular-nums">
                {t.kcal} kcal · {t.protein_g}P / {t.carb_g}C / {t.fat_g}F
              </span>
            </li>
          ))}
      </ul>
    </section>
  );
}
