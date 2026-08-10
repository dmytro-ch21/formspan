import type { Criterion } from '@/components/ui/TechniqueRow';
import type { CurriculumItem, Progress } from '@/lib/curriculum';

/**
 * The mapping layer between a curriculum item and the row that draws it.
 *
 * **In a module, and tested, because this is exactly where the last bug
 * lived.** The roadmap redesign's blocking finding was a display state derived
 * from the wrong field, and it sat in the screen file where no test could reach
 * it — the component test that now covers `TechniqueRow` stays green if you
 * swap `attempts` for `scored` here, because the row only ever sees the answer.
 *
 * It belongs out of the row for a second reason: which glyph means "landed" is
 * a fact about BJJ, and `TechniqueRow` should stay usable by anything with
 * thresholds.
 */

/**
 * Any evidence at all — what draws the row's "started" rule.
 *
 * Deliberately not "has a criterion been met": a met criterion is a *cleared*
 * target, and the span this state exists to mark is the one before the first
 * clears. `attempts` is `scored + attempted`, so it already covers landing it;
 * `defended` and `sessions` are their own axes.
 *
 * **Drilled training counts now.** An earlier version of this comment
 * recorded drilled-only work reading as untouched, forced by the payload
 * carrying no drilled count — an athlete twenty classes into a movement drew
 * the same rule as one who had never seen it. The API sends
 * `drilled_sessions` since the phases redesign, so practice finally moves
 * this. Live criteria still exclude it; "started" is a weaker claim than any
 * criterion and honestly includes having drilled.
 *
 * Null progress means not enrolled: no evidence is being counted, so there is
 * nothing to have started.
 */
export function hasEvidence(p: Progress | null | undefined): boolean {
  return (
    p != null &&
    (p.attempts > 0 || p.defended > 0 || p.sessions > 0 || p.drilled_sessions > 0)
  );
}

/** Turns one item's criteria into the chips the row draws. */
export function criteriaChips(item: CurriculumItem, enrolled: boolean): Criterion[] {
  const c = item.criteria;
  if (c === null) return [];
  const p = item.progress;
  const out: Criterion[] = [];

  const volume = (
    icon: Criterion['icon'],
    label: string,
    have: number | undefined,
    need: number,
  ) => {
    const got = have ?? 0;
    out.push({
      icon,
      // Browsing shows the bar, working shows the climb. Zero-filling for
      // someone not enrolled would report a shortfall they were never asked
      // to make up.
      value: enrolled ? `${got}/${need}` : String(need),
      met: enrolled && got >= need,
      label: enrolled ? `${label}, ${got} of ${need}` : `${label}, ${need} needed`,
    });
  };

  if (c.target_scored !== null) volume('goal', 'Landed', p?.scored, c.target_scored);
  if (c.target_defended !== null) volume('recovery', 'Stopped theirs', p?.defended, c.target_defended);
  if (c.target_sessions !== null) volume('calendar', 'Sessions', p?.sessions, c.target_sessions);
  if (c.target_drilled_sessions !== null)
    volume('progress', 'Classes drilled', p?.drilled_sessions, c.target_drilled_sessions);

  if (c.min_hit_rate !== null) {
    const need = Math.round(c.min_hit_rate * 100);
    // `—`, never `0%`. Zero from zero is not a rate, and the API sends null so
    // the client cannot report a failure the athlete has not had.
    const have = p?.hit_rate == null ? null : Math.round(p.hit_rate * 100);
    out.push({
      icon: 'chart',
      value: enrolled ? `${have === null ? '—' : `${have}%`}/${need}%` : `${need}%`,
      met: enrolled && have !== null && have >= need,
      label:
        enrolled && have !== null
          ? `Hit rate, ${have} percent of ${need} needed`
          : `Hit rate, ${need} percent needed`,
    });
  }
  return out;
}
