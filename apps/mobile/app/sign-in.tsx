import { useSignIn } from '@clerk/clerk-expo';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';

type SecondFactorStrategy = 'totp' | 'phone_code' | 'backup_code' | 'email_code';

/**
 * Minimal email + password sign-in, plus the second-factor step Clerk
 * requires when the account has 2FA enabled. Scope matches apps/web's
 * original hello-world auth: enough to obtain a real session token so the
 * app can call authenticated endpoints. No OAuth or password reset yet —
 * those are their own increment. Account creation lives on `sign-up.tsx`,
 * which links here (and prefills `email`) when the address is already taken.
 */
export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
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

  function readClerkError(err: unknown): string {
    if (err && typeof err === 'object' && 'errors' in err) {
      // Clerk returns a structured errors array; longMessage is user-facing.
      const first = (err as { errors?: { longMessage?: string }[] }).errors?.[0];
      if (first?.longMessage) return first.longMessage;
    }
    return 'Sign in failed.';
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
        // Use whatever Clerk actually offers for this account. TOTP and
        // backup codes are entered directly; phone codes must be requested
        // first. Preference order: authenticator app, then SMS, then a
        // backup code.
        const supported = attempt.supportedSecondFactors ?? [];
        const phone = supported.find((f) => f.strategy === 'phone_code');
        const emailCode = supported.find((f) => f.strategy === 'email_code');

        if (supported.some((f) => f.strategy === 'totp')) {
          setSecondFactor('totp');
        } else if (phone) {
          await signIn.prepareSecondFactor({
            strategy: 'phone_code',
            phoneNumberId: (phone as { phoneNumberId: string }).phoneNumberId,
          });
          setSecondFactor('phone_code');
        } else if (emailCode) {
          // Emailed codes, like SMS ones, have to be requested before they
          // can be entered. Clerk's typings don't include email_code among
          // the second-factor params even though instances can be
          // configured to use it, hence the cast.
          await signIn.prepareSecondFactor({
            strategy: 'email_code',
            emailAddressId: (emailCode as { emailAddressId: string }).emailAddressId,
          } as unknown as Parameters<typeof signIn.prepareSecondFactor>[0]);
          setSecondFactor('email_code');
        } else if (supported.some((f) => f.strategy === 'backup_code')) {
          setSecondFactor('backup_code');
        } else {
          // Name what Clerk actually returned instead of a dead end, so the
          // gap is diagnosable rather than mysterious.
          const names = supported.map((f) => f.strategy).join(', ') || 'none reported';
          setError(`Unsupported second factor (${names}). Sign in on web instead for now.`);
        }
        return;
      }

      setError(`Additional step required (${attempt.status}).`);
    } catch (err) {
      setError(readClerkError(err));
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
      setError(readClerkError(err));
    } finally {
      setBusy(false);
    }
  }

  const codeLabel =
    secondFactor === 'phone_code'
      ? 'Enter the code we texted you'
      : secondFactor === 'email_code'
        ? 'Enter the code we emailed you'
        : secondFactor === 'backup_code'
          ? 'Enter a backup code'
          : 'Enter the code from your authenticator app';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign in to VOLA</Text>

      {secondFactor === null ? (
        <>
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

      <Pressable
        style={[styles.button, busy && styles.buttonDisabled]}
        onPress={secondFactor === null ? onSubmitPassword : onSubmitCode}
        disabled={busy || !isLoaded}
        accessibilityRole="button"
        accessibilityLabel={secondFactor === null ? 'Sign in' : 'Verify code'}
        accessibilityState={{ busy, disabled: busy || !isLoaded }}
        testID="sign-in-submit"
      >
        {busy ? (
          <ActivityIndicator color={vola.navy} />
        ) : (
          <Text style={styles.buttonText}>{secondFactor === null ? 'Sign in' : 'Verify'}</Text>
        )}
      </Pressable>

      {/* Only on the first step: partway through a second factor there is an
          account already, so offering to create one is noise. */}
      {secondFactor === null && (
        <Pressable
          style={styles.footer}
          onPress={() =>
            router.replace(
              email.trim() ? { pathname: '/sign-up', params: { email: email.trim() } } : '/sign-up'
            )
          }
          accessibilityRole="link"
          accessibilityLabel="New to VOLA? Create an account"
          testID="sign-in-to-sign-up"
        >
          <Text style={styles.footerText}>
            New to VOLA? <Text style={styles.footerLink}>Create an account</Text>
          </Text>
        </Pressable>
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
