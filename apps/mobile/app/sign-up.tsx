import { useSignUp } from '@clerk/clerk-expo';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
} from 'react-native';

import { GoogleAuthButton } from '@/components/GoogleAuthButton';
import { KeyboardAwareScrollView } from '@/components/KeyboardAwareScroll';
import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { AuthFieldErrors, AuthFieldKey, hasClerkCode, toFieldErrors } from '@/lib/clerkErrors';
import { useGoogleSignIn } from '@/lib/useGoogleSignIn';

/**
 * Email + password sign-up, then the emailed verification code.
 *
 * Until this screen existed a new athlete could not onboard from a phone at
 * all — they had to find the web app, register there, and remember to set a
 * password, because mobile sign-in is email+password. For a mobile-first
 * logging app that is the wrong front door.
 *
 * Three UX properties are load-bearing here, and each one is a failure mode
 * this screen is deliberately built around:
 *
 * 1. **Errors land on the field that caused them.** Clerk tags each error
 *    with `meta.paramName`, so "that email is taken" belongs under the email
 *    input, not in a blob at the bottom of the form.
 * 2. **An interrupted sign-up resumes where it stopped.** Clerk keeps the
 *    in-flight `signUp` on the client. Without the resume below, an app
 *    killed at the verify step reopens on a blank form that then rejects its
 *    own half-registered email as already taken — a dead end with no way out
 *    but a different address.
 * 3. **The password rule is stated before it is enforced.** The requirement
 *    is visible from the first frame rather than delivered as a rejection.
 *
 * Scope: no OAuth and no password reset. Both are their own increment, and
 * password reset in particular belongs on the sign-in screen.
 */

/**
 * Clerk's own default minimum. The instance is the real authority — if it is
 * configured stricter, its rejection is surfaced verbatim rather than
 * second-guessed, which is also why no other rule is asserted in the hint.
 */
const MIN_PASSWORD = 8;
const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 30;

/**
 * Deliberately permissive: this catches the typo that would otherwise cost a
 * round trip ("no @ sign"), and leaves genuine address validity to Clerk.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignUpScreen() {
  const { signUp, setActive, isLoaded } = useSignUp();
  const { signInWithGoogle, googleBusy } = useGoogleSignIn();
  const router = useRouter();
  // Sign-in hands the address over when someone arrives there without an
  // account, so it isn't typed twice on a phone keyboard.
  const { email: prefill } = useLocalSearchParams<{ email?: string }>();

  const [step, setStep] = useState<'details' | 'verify'>('details');
  const [email, setEmail] = useState(prefill ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<AuthFieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [emailTaken, setEmailTaken] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [busy, setBusy] = useState(false);
  // Whether a code was actually sent *this mount*. The verify step must not
  // say "we sent a code" when the send is exactly what failed.
  const [codeSent, setCodeSent] = useState(false);
  // Email verified but the session not yet activated — a `setActive` that
  // failed on its own. Without this the Verify button re-attempts an
  // already-consumed verification and Clerk rejects it, which reads as being
  // stuck one tap from the finish line.
  const [verified, setVerified] = useState(false);

  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const resumed = useRef(false);

  // Resume an interrupted sign-up. Runs exactly once per mount, guarded by a
  // ref rather than by dependencies, so a later render can never yank someone
  // back to the verify step while they are typing on the details step.
  useEffect(() => {
    if (!isLoaded || !signUp || resumed.current) return;
    resumed.current = true;

    if (
      signUp.status === 'missing_requirements' &&
      signUp.unverifiedFields?.includes('email_address')
    ) {
      setEmail(signUp.emailAddress ?? '');
      setStep('verify');
      // Resend stays available immediately: the original code was sent
      // before this mount, so counting a cooldown from now would be a guess.
    }
  }, [isLoaded, signUp]);

  // A chain of one-second timeouts rather than an interval — an interval
  // would need to be excluded from the dependency array to avoid being torn
  // down and rebuilt on every tick, and this is the same behaviour honestly.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // Speak errors and confirmations. `accessibilityRole="alert"` does not make
  // VoiceOver announce a message *appearing*, and `accessibilityLiveRegion` is
  // Android-only — so a sighted user sees the error land and a VoiceOver user
  // hears nothing until they re-explore the screen. This is the part that
  // actually reaches both.
  useEffect(() => {
    const message = errors.form ?? errors.email ?? errors.password ?? errors.code ?? notice;
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }, [errors, notice]);

  function clearFieldError(field: AuthFieldKey) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  async function onGoogle() {
    setErrors({});
    const outcome = await signInWithGoogle();
    if (outcome.kind === 'signed_in' || outcome.kind === 'cancelled') return;

    if (outcome.kind === 'failed') {
      setErrors({ form: outcome.message });
      return;
    }

    // Google matched an existing account that has 2FA. Only sign-in has the
    // second-factor UI, so that's where they have to finish.
    //
    // It does NOT resume. An earlier version of this comment claimed Clerk's
    // client-persisted `signIn` would be picked up over there — the resource
    // does persist, but nothing on sign-in reads it at mount, so the user
    // would land on an email+password form for an account that has no
    // password. What actually works is tapping Continue with Google again on
    // that screen: `startSSOFlow` begins with `signIn.create`, so it restarts
    // cleanly and re-lands on the second factor, which sign-in then drives.
    //
    // A mount effect on sign-in could make the resume real, but it would have
    // to call `prepareBestSecondFactor` — a call that *sends* an SMS or email
    // code. Firing that on every mount that happens to find a stale in-flight
    // attempt would spray unrequested codes at people. So the copy tells them
    // the one action that works instead.
    setErrors({
      form: 'That Google account already exists and needs its two-factor code. Go to sign in and tap Continue with Google there.',
    });
  }

  function goToSignIn() {
    // Carry the address across so someone who already has an account doesn't
    // retype it. Replace rather than push: sign-in and sign-up are peers, not
    // a stack to climb back out of.
    const trimmed = email.trim();
    router.replace(trimmed ? { pathname: '/sign-in', params: { email: trimmed } } : '/sign-in');
  }

  async function onCreate() {
    if (!isLoaded || busy) return;

    // Validate locally first: an obviously incomplete form should cost no
    // round trip, and the message should land on the field that caused it.
    const trimmed = email.trim();
    const local: AuthFieldErrors = {};
    if (!trimmed) local.email = 'Enter your email address.';
    else if (!EMAIL_RE.test(trimmed)) local.email = "That doesn't look like an email address.";
    if (!password) local.password = 'Choose a password.';
    else if (password.length < MIN_PASSWORD) {
      local.password = `Use at least ${MIN_PASSWORD} characters.`;
    }

    if (local.email || local.password) {
      setErrors(local);
      setEmailTaken(false);
      (local.email ? emailRef : passwordRef).current?.focus();
      return;
    }

    setBusy(true);
    setErrors({});
    setEmailTaken(false);
    setNotice(null);
    try {
      const attempt = await signUp.create({ emailAddress: trimmed, password });

      if (attempt.status === 'complete') {
        // An instance configured without email verification — nothing left
        // to do. Not this one today, but the branch costs one line and its
        // absence would strand every user on an unreachable verify step.
        await setActive({ session: attempt.createdSessionId });
        return; // Root layout's auth effect routes onward.
      }

      // The account exists from here on, so advance even if the code send
      // fails: Resend is exactly the retry for that, whereas returning to
      // the details form would show "that email is taken" — about the
      // half-registered account we just created.
      setStep('verify');
      try {
        await signUp.prepareEmailAddressVerification({
          strategy: 'email_code',
        });
        setCodeSent(true);
        setResendIn(RESEND_COOLDOWN_SECONDS);
      } catch {
        setErrors({
          form: "We couldn't send the code. Tap Resend to try again.",
        });
      }
    } catch (err) {
      setErrors(toFieldErrors(err));
      setEmailTaken(hasClerkCode(err, 'form_identifier_exists'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Takes the code as an argument rather than reading state, so the
   * auto-submit on the sixth digit can't fire against a stale value.
   */
  async function onVerify(entered: string) {
    if (!isLoaded || busy) return;
    if (entered.length !== CODE_LENGTH) {
      setErrors({ code: `Enter the ${CODE_LENGTH}-digit code.` });
      return;
    }

    setBusy(true);
    setErrors({});
    setNotice(null);
    try {
      const attempt = await signUp.attemptEmailAddressVerification({
        code: entered,
      });

      if (attempt.status === 'complete') {
        // Verification is spent from here — a second attempt with the same
        // code fails. So record that it succeeded *before* activating, and
        // let a failed activation fall through to `onFinish` rather than
        // back to a Verify button that can no longer do anything.
        setVerified(true);
        await setActive({ session: attempt.createdSessionId });
        return; // Root layout's auth effect routes onward.
      }

      // Verified, but the instance wants fields this screen doesn't collect.
      // Name them instead of dead-ending, the same way sign-in names an
      // unsupported second factor — a gap you can read is a gap you can fix.
      const missing = attempt.missingFields?.join(', ') || attempt.status || 'unknown';
      setErrors({
        form: `Your email is verified, but this account still needs: ${missing}. Finish setting it up on the web app.`,
      });
    } catch (err) {
      const next = toFieldErrors(err);
      setErrors(next);
      // Clear only when the code itself was rejected. A network failure
      // leaves a correctly typed code alone — retyping six digits because
      // the wifi dropped is a punishment for the wrong mistake.
      if (next.code) setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    if (!isLoaded || busy || resendIn > 0) return;

    setBusy(true);
    setErrors({});
    setNotice(null);
    try {
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
      setCodeSent(true);
      setResendIn(RESEND_COOLDOWN_SECONDS);
      setCode('');
      setNotice('New code sent.');
    } catch (err) {
      setErrors(toFieldErrors(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The retry for an email that verified but whose session didn't activate.
   * Separate from `onVerify` because the verification can't be replayed —
   * only the activation can.
   */
  async function onFinish() {
    if (!isLoaded || busy) return;

    setBusy(true);
    setErrors({});
    try {
      await setActive({ session: signUp.createdSessionId });
    } catch (err) {
      setErrors(toFieldErrors(err));
    } finally {
      setBusy(false);
    }
  }

  const meetsLength = password.length >= MIN_PASSWORD;
  const submitting = busy || googleBusy || !isLoaded;

  const submitLabel =
    step === 'details' ? 'Create account' : verified ? 'Continue' : 'Verify email';
  const submitAction =
    step === 'details' ? onCreate : verified ? onFinish : () => void onVerify(code);

  return (
    /* Keyboard handling is the scroll view's own, not a KeyboardAvoidingView's.
       KAV with `behavior="padding"` needs a `keyboardVerticalOffset` equal to
       the nav header's height to land correctly, and reading that height means
       depending on @react-navigation/elements, which pnpm's strict layout
       doesn't expose here. `automaticallyAdjustKeyboardInsets` is UIKit doing
       the same job natively, header included; it's a no-op on Android, where
       Expo's default `resize` mode already shrinks the window. Either way the
       content still scrolls by hand, so nothing is ever unreachable. */
    <KeyboardAwareScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>VOLA</Text>
        <Text style={styles.title}>
          {step === 'details'
            ? 'Create your account'
            : verified
              ? 'Email verified'
              : 'Check your email'}
        </Text>
        {step === 'details' ? (
          <Text style={styles.subtitle}>One account for your training, sessions and history.</Text>
        ) : verified ? (
          <Text style={styles.subtitle}>
            Your account is ready — we just need to finish signing you in.
          </Text>
        ) : codeSent ? (
          <Text style={styles.subtitle}>
            We sent a {CODE_LENGTH}-digit code to <Text style={styles.subtitleStrong}>{email}</Text>
            .
          </Text>
        ) : (
          /* Deliberately not "we sent a code": either the send is what just
             failed, or this is a resumed sign-up whose code was requested in
             some earlier run. Claiming a send we can't vouch for is the exact
             failure this app keeps making a rule against. */
          <Text style={styles.subtitle}>
            Enter the {CODE_LENGTH}-digit code for{' '}
            <Text style={styles.subtitleStrong}>{email}</Text>, or tap Resend to get a new one.
          </Text>
        )}
      </View>

      {step === 'details' ? (
        <View style={styles.form}>
          <GoogleAuthButton
            onPress={onGoogle}
            busy={googleBusy}
            disabled={busy || !isLoaded}
            label="Sign up with Google"
          />
          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              ref={emailRef}
              style={[styles.input, errors.email && styles.inputInvalid]}
              placeholder="you@example.com"
              placeholderTextColor={vola.textDim}
              value={email}
              onChangeText={(v) => {
                setEmail(v);
                clearFieldError('email');
                setEmailTaken(false);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              keyboardType="email-address"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              editable={!busy}
              accessibilityLabel="Email address"
              testID="sign-up-email"
            />
            {errors.email && (
              <Text
                style={styles.fieldError}
                accessibilityRole="alert"
                testID="sign-up-email-error"
              >
                {errors.email}
              </Text>
            )}
            {emailTaken && (
              <Pressable
                onPress={goToSignIn}
                hitSlop={12}
                accessibilityRole="link"
                testID="sign-up-existing"
              >
                <Text style={styles.inlineLink}>Sign in to that account instead</Text>
              </Pressable>
            )}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.passwordRow}>
              <TextInput
                ref={passwordRef}
                style={[styles.input, styles.passwordInput, errors.password && styles.inputInvalid]}
                placeholder="Create a password"
                placeholderTextColor={vola.textDim}
                value={password}
                onChangeText={(v) => {
                  setPassword(v);
                  clearFieldError('password');
                }}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                passwordRules={`minlength: ${MIN_PASSWORD};`}
                returnKeyType="go"
                onSubmitEditing={onCreate}
                editable={!busy}
                accessibilityLabel="Password"
                testID="sign-up-password"
              />
              {/* Typing a strong password blind on a phone keyboard is the
                    single biggest source of sign-up abandonment. */}
              <Pressable
                style={styles.reveal}
                onPress={() => setShowPassword((v) => !v)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                testID="sign-up-reveal"
              >
                <Text style={styles.revealText}>{showPassword ? 'Hide' : 'Show'}</Text>
              </Pressable>
            </View>
            {/* The rule is on screen before the first keystroke, so it is
                  never news delivered as a rejection. */}
            <Text style={[styles.hint, meetsLength && styles.hintMet]}>
              {meetsLength ? '✓' : '•'} At least {MIN_PASSWORD} characters
            </Text>
            {errors.password && (
              <Text
                style={styles.fieldError}
                accessibilityRole="alert"
                testID="sign-up-password-error"
              >
                {errors.password}
              </Text>
            )}
          </View>
        </View>
      ) : verified ? null : ( // Nothing left to enter — the button below finishes it.
        <View style={styles.form}>
          <View style={styles.field}>
            <TextInput
              style={[styles.input, styles.codeInput, errors.code && styles.inputInvalid]}
              placeholder="000000"
              placeholderTextColor={vola.textDim}
              value={code}
              onChangeText={(raw) => {
                const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
                setCode(digits);
                clearFieldError('code');
                // Submit on the sixth digit — the button stays as the
                // explicit path, but nobody should have to reach for it.
                if (digits.length === CODE_LENGTH) void onVerify(digits);
              }}
              autoFocus
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              // No `maxLength`: it truncates natively *before* the sanitizer
              // above runs, so pasting "123 456" would silently keep five
              // digits. The slice already bounds it.
              editable={!busy}
              accessibilityLabel={`${CODE_LENGTH}-digit verification code`}
              testID="sign-up-code"
            />
            {errors.code && (
              <Text style={styles.fieldError} accessibilityRole="alert" testID="sign-up-code-error">
                {errors.code}
              </Text>
            )}
          </View>

          {/* hitSlop on both: these are ~18pt of text on the screen most
              likely to be used one-handed, well under the 44pt target. */}
          <View style={styles.resendRow}>
            {resendIn > 0 ? (
              <Text style={styles.hint} testID="sign-up-resend-cooldown">
                Resend in {resendIn}s
              </Text>
            ) : (
              <Pressable
                onPress={onResend}
                disabled={busy}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Resend verification code"
                accessibilityState={{ disabled: busy }}
                testID="sign-up-resend"
              >
                <Text style={[styles.inlineLink, busy && styles.dimmed]}>Resend code</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                setStep('details');
                setCode('');
                setCodeSent(false);
                setErrors({});
                setNotice(null);
              }}
              disabled={busy}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Use a different email address"
              accessibilityState={{ disabled: busy }}
              testID="sign-up-change-email"
            >
              <Text style={[styles.mutedLink, busy && styles.dimmed]}>Use a different email</Text>
            </Pressable>
          </View>
        </View>
      )}

      {notice && (
        <Text style={styles.notice} accessibilityLiveRegion="polite" testID="sign-up-notice">
          {notice}
        </Text>
      )}
      {errors.form && (
        <Text style={styles.formError} accessibilityRole="alert" testID="sign-up-error">
          {errors.form}
        </Text>
      )}

      <Pressable
        style={[styles.button, submitting && styles.buttonDisabled]}
        onPress={submitAction}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityLabel={submitLabel}
        accessibilityState={{ busy, disabled: submitting }}
        testID="sign-up-submit"
      >
        {busy ? (
          <ActivityIndicator color={vola.navy} />
        ) : (
          <Text style={styles.buttonText}>{submitLabel}</Text>
        )}
      </Pressable>

      {step === 'details' && (
        <Pressable
          style={styles.footer}
          onPress={goToSignIn}
          accessibilityRole="link"
          accessibilityLabel="Already have an account? Sign in"
          testID="sign-up-to-sign-in"
        >
          <Text style={styles.footerText}>
            Already have an account? <Text style={styles.footerLink}>Sign in</Text>
          </Text>
        </Pressable>
      )}
    </KeyboardAwareScrollView>
  );
}

/**
 * NOTE ON COLOUR: this screen renders *before* sign-in, where there is no
 * account and therefore no stored accent — `AccentProvider` deliberately
 * serves the default rather than the last user's choice. So these reference
 * `vola.accent` (the default) directly instead of `useAccent()`, which would
 * provably return the same constant here. If a device-level accent ever
 * exists, this is the set of call sites to revisit.
 */
const styles = StyleSheet.create({
  // flexGrow rather than flex so the form centres on a tall screen but still
  // scrolls once the keyboard takes half of it.
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
    gap: 20,
  },

  hero: { gap: 6 },
  eyebrow: {
    color: vola.accent,
    fontSize: 11,
    letterSpacing: 1.6,
    fontWeight: '700',
  },
  title: { fontSize: 26, fontWeight: '700' },
  subtitle: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
  subtitleStrong: { color: vola.text, fontWeight: '600' },

  form: { gap: 18 },
  field: { gap: 7 },
  label: { color: vola.textMuted, fontSize: 13, fontWeight: '600' },

  input: {
    borderWidth: 1,
    borderColor: vola.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
    color: vola.text,
    backgroundColor: vola.surface,
  },
  // Colour is not the only signal — every invalid field also carries a
  // written message directly beneath it.
  inputInvalid: { borderColor: vola.danger },

  passwordRow: { position: 'relative' },
  passwordInput: { paddingRight: 64 },
  reveal: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  revealText: { color: vola.accent, fontSize: 13, fontWeight: '600' },

  codeInput: {
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: 10,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    paddingVertical: 16,
    // letterSpacing trails the final glyph, which pulls centred text half a
    // step left; the extra 10 on the left puts it back.
    paddingLeft: 24,
    paddingRight: 14,
  },

  resendRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  hint: { color: vola.textDim, fontSize: 13 },
  hintMet: { color: vola.green },
  dimmed: { opacity: 0.5 },

  fieldError: { color: vola.danger, fontSize: 13 },
  formError: { color: vola.danger, fontSize: 14, lineHeight: 19 },
  notice: { color: vola.green, fontSize: 14 },

  inlineLink: { color: vola.accent, fontSize: 14, fontWeight: '600' },
  mutedLink: { color: vola.textMuted, fontSize: 14 },

  button: {
    backgroundColor: vola.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    // Holds its height while the spinner replaces the label, so the footer
    // below doesn't jump on every submit.
    minHeight: 52,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: vola.navy, fontWeight: '700', fontSize: 16 },

  footer: { alignItems: 'center', paddingVertical: 4 },
  footerText: { color: vola.textMuted, fontSize: 14 },
  footerLink: { color: vola.accent, fontWeight: '600' },
});
