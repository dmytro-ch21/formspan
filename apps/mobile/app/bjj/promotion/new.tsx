import { useLocalSearchParams } from 'expo-router';

import { PromotionForm } from '@/components/PromotionForm';
import { BELTS, type Belt, type Rank } from '@/lib/bjj';

export default function NewPromotionScreen() {
  const params = useLocalSearchParams<{ belt?: string; stripes?: string; degree?: string }>();

  // Set by the hub's Add button as "the obvious next step" from the current
  // rank — see `nextRank`. Absent entirely for a first-ever promotion, and
  // validated the same way the edit route validates its params: a malformed
  // or partial suggestion is treated as no suggestion, never as a half-built
  // one, so the form falls back to its own White/0/0 default rather than
  // rendering a belt with no stripes value behind it.
  const suggested: Rank | undefined = BELTS.includes(params.belt as Belt)
    ? { belt: params.belt as Belt, stripes: Number(params.stripes) || 0, degree: Number(params.degree) || 0 }
    : undefined;

  return <PromotionForm suggestedRank={suggested} />;
}
