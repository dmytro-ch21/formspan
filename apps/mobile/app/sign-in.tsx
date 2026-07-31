import { useSignIn } from '@clerk/clerk-expo';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
} from 'react-native';

import { GoogleAuthButton } from '@/components/GoogleAuthButton';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { firstClerkMessage, hasClerkCode } from '@/lib/clerkErrors';
import {
  describeFactors,
  prepareBestSecondFactor,
  secondFactorPrompt,
  SecondFactorStrategy,
} from '@/lib/secondFactor';
import { useGoogleSignIn } from '@/lib/useGoogleSignIn';

/**
 * Minimal email + password sign-in, plus the second-factor step Clerk
 * requires when the account has 2FA enabled. Scope matches apps/web's
 * original hello-world auth: enough to obtain a real session token so the
 * app can call authenticated endpoints. No OAuth yet — that's its own
 * increment. Account creation lives on `sign-up.tsx` and password reset on
 * `forgot-password.tsx`; all three link to each other and hand the typed
 * address across as an `email` route param.
 */
export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const { signInWithGoogle, googleBusy } = useGoogleSignIn();
  const router = useRouter();
  // Set when sign-up hands off an address that already has an account, so
  // the same email isn't typed twice on a phone keyboard.
  const { email: prefill } = useLocalSearchParams<{ email?: string }>();

  const [email, setEmail] = useState(prefill ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [secondFactor, setSecondFactor] = useState<SecondFactorStrategy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when the failure looks like "this account has no password because it
  // was created through Google", so the answer can point at the button above
  // instead of leaving them retyping a password that never existed.
  const [tryGoogle, setTryGoogle] = useState(false);

  // `accessibilityRole="alert"` doesn't make VoiceOver announce a message
  // *appearing*, so without this the errors on this screen are visual-only —
  // including the "use Google" hint, whose entire job is to un-stick someone.
  // sign-up.tsx already does this; the two screens should not differ.
  useEffect(() => {
    if (error) AccessibilityInfo.announceForAccessibility(error);
  }, [error]);

  async function onGoogle() {
    setError(null);
    setTryGoogle(false);
    const outcome = await signInWithGoogle();

    // 'signed_in' needs nothing: the root layout's auth effect routes onward.
    // 'cancelled' needs nothing either — backing out of the sheet is a
    // decision, and reporting it as an error would be a lie about what
    // happened.
    if (outcome.kind === 'signed_in' || outcome.kind === 'cancelled') return;

    if (outcome.kind === 'failed') {
      setError(outcome.message);
      return;
    }

    // Google authenticated them but the account has 2FA. This is the *same*
    // state the password path reaches, so it reuses the same step rather than
    // growing a second copy of the second-factor UI.
    //
    // `busy` is held across the prepare because it *sends* the code. Without
    // it both buttons stay live during a network call, and a stray "Sign in"
    // tap would fire `signIn.create` and replace the attempt just prepared.
    // The password path already holds it across the identical call.
    setBusy(true);
    try {
      const supported = outcome.signIn.supportedSecondFactors ?? [];
      const chosen = await prepareBestSecondFactor(outcome.signIn, supported);
      if (chosen) {
        setSecondFactor(chosen);
      } else {
        setError(
          `Unsupported second factor (${describeFactors(supported)}). Sign in on web instead for now.`,
        );
      }
    } catch (err) {
      setError(firstClerkMessage(err, 'Sign in failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitPassword() {
    if (!isLoaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.create({ identifier: email, password });

      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId });
        return; // Root layout's auth effect routes onward.
      }

      if (attempt.status === 'needs_second_factor') {
        // Whatever Clerk actually offers for this account, in preference
        // order — shared with forgot-password.tsx, which reaches the same
        // state after a reset on a 2FA account.
        const supported = attempt.supportedSecondFactors ?? [];
        const chosen = await prepareBestSecondFactor(signIn, supported);
        if (chosen) {
          setSecondFactor(chosen);
        } else {
          // Name what Clerk actually returned instead of a dead end, so the
          // gap is diagnosable rather than mysterious.
          setError(
            `Unsupported second factor (${describeFactors(supported)}). Sign in on web instead for now.`,
          );
        }
        return;
      }

      setError(`Additional step required (${attempt.status}).`);
    } catch (err) {
      setError(firstClerkMessage(err, 'Sign in failed.'));
      // Clerk's code for "that strategy isn't valid for this user", which is
      // what a password attempt against a Google-only account produces. The
      // exact code is unverified against this instance; if it differs the
      // generic message still shows and the Google button is still on screen,
      // so this only ever adds signal.
      setTryGoogle(hasClerkCode(err, 'strategy_for_user_invalid'));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitCode() {
    if (!isLoaded || busy || !secondFactor) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await signIn.attemptSecondFactor({
        strategy: secondFactor,
        code: code.trim(),
        // Same typings gap as prepareSecondFactor above for email_code.
      } as unknown as Parameters<typeof signIn.attemptSecondFactor>[0]);

      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId });
      } else {
        setError(`Verification incomplete (${attempt.status}).`);
      }
    } catch (err) {
      setError(firstClerkMessage(err, 'Sign in failed.'));
    } finally {
      setBusy(false);
    }
  }

  const codeLabel = secondFactor ? secondFactorPrompt(secondFactor) : '';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign in to VOLA</Text>

      {secondFactor === null ? (
        <>
          <GoogleAuthButton onPress={onGoogle} busy={googleBusy} disabled={busy || !isLoaded} />
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#767676"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            testID="sign-in-email"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor="#767676"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            testID="sign-in-password"
          />
        </>
      ) : (
        <>
          <Text style={styles.hint}>{codeLabel}</Text>
          <TextInput
            style={styles.input}
            placeholder="Verification code"
            placeholderTextColor="#767676"
            value={code}
            onChangeText={setCode}
            autoCapitalize="none"
            autoComplete="one-time-code"
            keyboardType={secondFactor === 'backup_code' ? 'default' : 'number-pad'}
            testID="sign-in-code"
          />
        </>
      )}

      {error && (
        <Text style={styles.error} testID="sign-in-error">
          {error}
        </Text>
      )}
      {tryGoogle && (
        <Text style={styles.hint} testID="sign-in-use-google">
          This account was created with Google — use Continue with Google above.
        </Text>
      )}

      <Pressable
        style={[styles.button, busy && styles.buttonDisabled]}
        onPress={secondFactor === null ? onSubmitPassword : onSubmitCode}
        disabled={busy || googleBusy || !isLoaded}
        accessibilityRole="button"
        accessibilityLabel={secondFactor === null ? 'Sign in' : 'Verify code'}
        accessibilityState={{ busy, disabled: busy || googleBusy || !isLoaded }}
        testID="sign-in-submit"
      >
        {busy ? (
          <ActivityIndicator color={vola.navy} />
        ) : (
          <Text style={styles.buttonText}>{secondFactor === null ? 'Sign in' : 'Verify'}</Text>
        )}
      </Pressable>

      {/* Only on the first step: partway through a second factor there is an
          account already and its password already worked, so neither of these
          is anything but noise. */}
      {secondFactor === null && (
        <>
          {/* Above "create an account", because a wrong password is the more
              likely reason someone is stuck on this screen than no account. */}
          <Pressable
            style={styles.footer}
            onPress={() =>
              router.replace(
                email.trim()
                  ? { pathname: '/forgot-password', params: { email: email.trim() } }
                  : '/forgot-password',
              )
            }
            hitSlop={12}
            accessibilityRole="link"
            accessibilityLabel="Forgot your password?"
            testID="sign-in-to-forgot"
          >
            <Text style={styles.footerLink}>Forgot your password?</Text>
          </Pressable>

          <Pressable
            style={styles.footer}
            onPress={() =>
              router.replace(
                email.trim()
                  ? { pathname: '/sign-up', params: { email: email.trim() } }
                  : '/sign-up',
              )
            }
            hitSlop={12}
            accessibilityRole="link"
            accessibilityLabel="New to VOLA? Create an account"
            testID="sign-in-to-sign-up"
          >
            <Text style={styles.footerText}>
              New to VOLA? <Text style={styles.footerLink}>Create an account</Text>
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 12,
    textAlign: 'center',
  },
  hint: {
    fontSize: 14,
    textAlign: 'center',
  },
  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  button: {
    backgroundColor: vola.lime,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: vola.navy,
    fontWeight: '600',
    fontSize: 16,
  },
  error: {
    color: vola.danger,
    fontSize: 14,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  footerText: {
    color: vola.textMuted,
    fontSize: 14,
  },
  footerLink: {
    color: vola.lime,
    fontWeight: '600',
  },
});
