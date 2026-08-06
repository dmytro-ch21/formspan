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
 * **Drilled-only training reads as untouched, and that is forced rather than
 * chosen.** The backend excludes `drilled` from every one of these counters on
 * purpose — `sessions` is `COUNT(DISTINCT …) FILTER (WHERE event IN
 * ('attempted','scored','defended'))`, so that a technique cannot clear its
 * spread requirement without being used on somebody who was resisting — and
 * `Progress` carries no drilled count at all. So the client has no signal to
 * read even if it wanted one.
 *
 * It is also defensible on its own terms: drilling moves none of the numbers
 * the chips display, and a "started" rule beside three `0/25` chips would claim
 * progress the criteria do not recognise. But it is a real limitation — an
 * athlete who has drilled a technique twenty times sees the same rule as one
 * who has never seen it — and closing it needs a `drilled` count on the
 * progress payload, not a client change.
 *
 * Null progress means not enrolled: no evidence is being counted, so there is
 * nothing to have started.
 */
export function hasEvidence(p: Progress | null | undefined): boolean {
  return p != null && (p.attempts > 0 || p.defended > 0 || p.sessions > 0);
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
