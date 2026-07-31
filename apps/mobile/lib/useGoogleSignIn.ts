import { useSSO } from '@clerk/clerk-expo';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';

import { firstClerkMessage } from './clerkErrors';
import type { SignInResource } from './secondFactor';

/**
 * "Continue with Google" for the phone.
 *
 * This closes a hole that was worse than the two before it. The Clerk instance
 * has Google enabled and `apps/web`'s prebuilt modal offers it — so athletes
 * have been signing up through Google since web shipped. Those accounts have
 * **no password at all**, which meant mobile's `signIn.create({ identifier,
 * password })` could never authenticate them: not inconvenient, locked out.
 * Every VOLA account has to be reachable from the phone, and this is the last
 * class of account that wasn't.
 *
 * One call serves both screens. Clerk's OAuth doesn't distinguish sign-in from
 * sign-up — an existing Google identity signs in, a new one is created — which
 * is why this is a hook shared by `sign-in.tsx` and `sign-up.tsx` rather than
 * duplicated logic with a different label on each.
 *
 * **Requires a real build; this will not work in Expo Go.** The OAuth redirect
 * comes back through the app's custom scheme (`vola://`, from `app.json`), and
 * Expo Go registers `exp://` instead — it has no way to hand the callback to a
 * project it is merely hosting. Verify with `expo run:ios --device`, not the
 * Expo Go simulator flow used for the other auth screens.
 */

// Required by expo-web-browser to settle a pending auth session. A no-op on
// native; it matters on web, and calling it unconditionally is what the
// library documents.
WebBrowser.maybeCompleteAuthSession();

export type GoogleOutcome =
  /** Session created and activated — the root layout takes it from here. */
  | { kind: 'signed_in' }
  /** The user backed out of the browser sheet. Not an error; say nothing. */
  | { kind: 'cancelled' }
  /**
   * Google authenticated them but Clerk wants another step — almost always
   * 2FA. Carries the resource so the caller can drive its own second-factor
   * UI rather than dead-ending.
   */
  | { kind: 'needs_second_factor'; signIn: SignInResource }
  /** Anything else, named rather than swallowed. */
  | { kind: 'failed'; message: string };

export function useGoogleSignIn() {
  const { startSSOFlow } = useSSO();
  const [busy, setBusy] = useState(false);

  // Android opens the OAuth tab noticeably faster when the browser has been
  // warmed; harmless elsewhere. Cooled down on unmount so it isn't held open.
  useEffect(() => {
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);

  const signInWithGoogle = useCallback(async (): Promise<GoogleOutcome> => {
    if (busy) return { kind: 'cancelled' };
    setBusy(true);
    try {
      const { createdSessionId, setActive, signIn, authSessionResult } = await startSSOFlow({
        strategy: 'oauth_google',
        // Resolves to `vola://` in a real build. In Expo Go it resolves to an
        // `exp://` URL that the OAuth provider will not redirect back to —
        // see the note at the top of this file.
        redirectUrl: Linking.createURL('/'),
      });

      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        return { kind: 'signed_in' };
      }

      // Dismissing the sheet is a decision, not a failure. Reporting it as an
      // error would be the same lie as an empty state that claims you have
      // nothing when the request merely failed.
      if (authSessionResult?.type === 'cancel' || authSessionResult?.type === 'dismiss') {
        return { kind: 'cancelled' };
      }

      if (signIn?.status === 'needs_second_factor') {
        return { kind: 'needs_second_factor', signIn: signIn as SignInResource };
      }

      // No session, not cancelled, no second factor: name the state instead of
      // showing a generic failure for something that isn't generic.
      const state = signIn?.status ?? authSessionResult?.type ?? 'unknown';
      return {
        kind: 'failed',
        message: `Google sign-in didn't complete (${state}). Try again, or use your email and password.`,
      };
    } catch (err) {
      return { kind: 'failed', message: firstClerkMessage(err, 'Google sign-in failed.') };
    } finally {
      setBusy(false);
    }
  }, [busy, startSSOFlow]);

  return { signInWithGoogle, googleBusy: busy };
}
