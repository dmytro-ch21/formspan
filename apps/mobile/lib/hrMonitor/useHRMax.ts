import { useEffect, useState } from 'react';

import { hrMaxFromDateOfBirth } from '../biometric';
import { getProfile } from '../profile';
import type { TokenGetter } from '../useAuthToken';

/**
 * N528/#958 — the same HRmax seed the enrichment passes use (220 − age from
 * the profile's date of birth), for colouring a live number by zone. `null`
 * until the profile answers, or when there is no date of birth — the number
 * then renders without a zone rather than against a guessed ceiling.
 */
export function useHRMax(getToken: TokenGetter, enabled: boolean): number | null {
  const [hrMax, setHRMax] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    getProfile(getToken)
      .then((p) => {
        if (live) setHRMax(hrMaxFromDateOfBirth(p.date_of_birth, new Date()));
      })
      .catch(() => {
        // Offline — no zone colour this time; the number itself is unaffected.
      });
    return () => {
      live = false;
    };
  }, [getToken, enabled]);
  return hrMax;
}
