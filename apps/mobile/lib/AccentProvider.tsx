import { useAuth } from '@clerk/clerk-expo';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { accents, DEFAULT_ACCENT, type Accent, type AccentName } from '@/constants/Colors';
import { PREF_ACCENT, readPref, writePref } from './prefs';

/**
 * The chosen accent, available everywhere.
 *
 * A context rather than a hook per screen, for the reason `ModulesProvider`
 * spells out: a per-call-site hook for an account-level value is how this
 * codebase once ended up making one `GET /v1/profile` per rendered session.
 * The accent is cheaper than that — it never leaves the device — but it is
 * read by *every* component that draws a button, so a shared value is the only
 * shape that does not multiply.
 *
 * **`ready` exists so the first frame is not the wrong colour.** The tab bar,
 * the header and every primary button take their colour from here; a value
 * that arrives one render late means an athlete who chose purple watches their
 * app come up green and change, on every cold start. The same trick the module
 * shell already uses, for the same reason.
 *
 * There is no server involved and deliberately so — see `PREF_ACCENT`. That
 * also means this never fails: the worst case is the default.
 */

type AccentState = {
  /** The resolved palette — `accent`, `ink`, `on`. */
  accent: Accent;
  /** Which one, for a settings picker to check against. */
  name: AccentName;
  /** False until the stored choice has been read. Hold the frame, don't guess. */
  ready: boolean;
  choose: (next: AccentName) => Promise<void>;
};

const AccentContext = createContext<AccentState>({
  accent: accents[DEFAULT_ACCENT],
  name: DEFAULT_ACCENT,
  ready: false,
  choose: async () => {},
});

/** Guards against a stored value from a build that offered a colour this one doesn't. */
function parse(value: string | null): AccentName {
  return value && value in accents ? (value as AccentName) : DEFAULT_ACCENT;
}

export function AccentProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  const [name, setName] = useState<AccentName>(DEFAULT_ACCENT);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      // Signed out: the auth screens are the only thing rendering, and they
      // get the default rather than the previous account's choice.
      setName(DEFAULT_ACCENT);
      setReady(true);
      return;
    }
    readPref(userId, PREF_ACCENT)
      .then((v) => {
        if (cancelled) return;
        setName(parse(v));
        setReady(true);
      })
      .catch(() => {
        // A preference that cannot be read is a preference nobody set.
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const choose = useCallback(
    async (next: AccentName) => {
      // Applied before the write, not after: this is the one setting whose
      // whole point is being seen immediately, and a round trip to SQLite
      // before the colour moves reads as a laggy control.
      setName(next);
      if (userId) await writePref(userId, PREF_ACCENT, next);
    },
    [userId],
  );

  const value = useMemo<AccentState>(
    () => ({ accent: accents[name], name, ready, choose }),
    [name, ready, choose],
  );

  return <AccentContext.Provider value={value}>{children}</AccentContext.Provider>;
}

/**
 * The accent, for anything that draws chrome.
 *
 * Returns the three-value palette, not a single colour, because one is never
 * enough: `accent` fills, `ink` is the same idea as text on a dark ground, and
 * `on` is what may be written on the fill. Using `accent` where `ink` belongs
 * is how the purple theme ends up with 3.64:1 body text.
 */
export function useAccent(): Accent {
  return useContext(AccentContext).accent;
}

/** The full state — for the settings picker, which needs the name and the setter. */
export function useAccentChoice(): AccentState {
  return useContext(AccentContext);
}
