import { Redirect, useLocalSearchParams } from 'expo-router';

import { PromotionForm, type EditablePromotion } from '@/components/PromotionForm';
import { BELTS, type Belt } from '@/lib/bjj';

/**
 * No GET-by-id promotion endpoint exists — only the list. The `/bjj` screen
 * already has the full row in hand from that list, so it's carried here as
 * route params rather than paying for a fetch the server has no route for.
 *
 * That means this screen's correctness depends entirely on the caller having
 * supplied a real row — there is nothing here to fetch and cross-check
 * against. `/bjj` always does. A partial or malformed link (hand-typed, or a
 * future caller that gets it wrong) must not fall through to an edit form
 * that silently defaults to White/0 stripes/blank fields: saving that would
 * overwrite real history with fabricated values instead of refusing to guess.
 */
export default function EditPromotionScreen() {
  const params = useLocalSearchParams<{
    id: string;
    belt: string;
    stripes: string;
    degree: string;
    promoted_on: string;
    academy: string;
    instructor: string;
    note: string;
  }>();

  if (!params.id || !BELTS.includes(params.belt as Belt)) {
    return <Redirect href="/bjj" />;
  }

  const initial: EditablePromotion = {
    id: params.id,
    belt: params.belt as Belt,
    stripes: Number(params.stripes) || 0,
    degree: Number(params.degree) || 0,
    promoted_on: params.promoted_on || null,
    academy: params.academy ?? '',
    instructor: params.instructor ?? '',
    note: params.note ?? '',
  };

  return <PromotionForm initial={initial} />;
}
