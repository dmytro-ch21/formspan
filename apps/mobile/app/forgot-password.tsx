import { useSignIn } from '@clerk/clerk-expo';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
} from 'react-native';

import { Text, View } from '@/components/Themed';
import { vola } from '@/constants/Colors';
import { AuthFieldErrors, AuthFieldKey, hasClerkCode, toFieldErrors } from '@/lib/clerkErrors';
import {
  describeFactors,
  prepareBestSecondFactor,
  secondFactorPrompt,
  SecondFactorStrategy,
  SetActive,
  SignInResource,
} from '@/lib/secondFactor';

/**
 * Password reset: emailed code, then a new password, then straight into the app.
 *
 * This was the last hole in mobile auth and the worst of them. Sign-up let a
 * new athlete in and sign-in let a returning one back, but an athlete who
 * forgot their password had *no* route into the app from the phone at all —
 * and unlike the sign-up gap there was no workaround, because resetting on the
 * web app is only discoverable if you already know the web app exists.
 *
 * Two things here are specific to reset and don't appear on the other screens:
 *
 * 1. **The password changes before the sign-in completes.** Clerk's
 *    `attemptFirstFactor` with `reset_password_email_code` sets the new
 *    password and *then* reports whether the account still needs a second
 *    factor. So on a 2FA account there is a real window where the password is
 *    already updated and the user is not yet signed in. Saying "check your
 *    authenticator" without saying "your password is saved" invites them to
 *    abandon the screen believing nothing happened — and then to reset again.
 * 2. **We tell the truth about an unrecognised email.** Neutral "if an account
 *    exists we've sent a code" copy is the usual advice, and it is the right
 *    call when it actually prevents enumeration. It doesn't here: sign-up
 *    already reveals whether an address is registered, unavoidably, by
 *    refusing to reuse it. So the neutral wording would close nothing and cost
 *    a real user — the one who mistyped their address — a silent dead end
 *    where they wait for an email that was never going to arrive. If sign-up
 *    ever stops leaking it, revisit this together with it, not on its own.
 */

const MIN_PASSWORD = 8;
const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const RESET_STRATEGY = 'reset_password_email_code';

type Step = 'request' | 'reset' | 'second_factor';

export default function ForgotPasswordScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const router = useRouter();
  // Sign-in hands over whatever was already typed, so the address isn't
  // entered twice by someone who just failed to sign in with it.
  const { email: prefill } = useLocalSearchParams<{ email?: string }>();

  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState(prefill ?? '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [secondFactor, setSecondFactor] = useState<SecondFactorStrategy | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<AuthFieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [busy, setBusy] = useState(false);
  const [unknownEmail, setUnknownEmail] = useState(false);
  // The password is already saved from here on, whatever happens to the rest
  // of the sign-in. The UI has to say so or the user re-resets.
  const [passwordChanged, setPasswordChanged] = useState(false);
  // A session Clerk created that `setActive` then failed to activate. Without
  // this the only button on screen would re-attempt a spent verification.
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);

  const emailRef = useRef<TextInput>(null);
  const codeRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // `accessibilityRole="alert"` doesn't make VoiceOver announce a message
  // appearing, and `accessibilityLiveRegion` is Android-only. This is what
  // actually reaches both.
  useEffect(() => {
    const message = errors.form ?? errors.email ?? errors.password ?? errors.code ?? notice;
    if (message) AccessibilityInfo.announceForAccessibility(message);
  }, [errors, notice]);

  function clearFieldError(field: AuthFieldKey) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  /**
   * Fold errors for fields the current step doesn't render into the
   * form-level slot. This screen shows different inputs per step, so a Clerk
   * error tagged `identifier` arriving during a *resend* — the account was
   * deleted mid-flow, say — would otherwise be assigned to an email field that
   * isn't on screen, and simply never appear. A failure you can't see is worse
   * than one attributed to the wrong place.
   */
  function visibleOn(next: AuthFieldErrors, shown: AuthFieldKey[]): AuthFieldErrors {
    const out: AuthFieldErrors = {};
    let spilled: string | undefined;
    for (const key of ['email', 'password', 'code', 'form'] as AuthFieldKey[]) {
      const message = next[key];
      if (!message) continue;
      if (key === 'form' || shown.includes(key)) out[key] = message;
      else spilled ??= message;
    }
    out.form ??= spilled;
    return out;
  }

  function goToSignIn() {
    const trimmed = email.trim();
    router.replace(trimmed ? { pathname: '/sign-in', params: { email: trimmed } } : '/sign-in');
  }

  // Takes the resource rather than closing over it: `signIn` is only narrowed
  // to non-undefined inside the function that checked `isLoaded`, and that
  // narrowing does not survive a call into a helper.
  async function sendCode(resource: SignInResource) {
    await resource.create({ strategy: RESET_STRATEGY, identifier: email.trim() });
    setResendIn(RESEND_COOLDOWN_SECONDS);
  }

  async function onRequest() {
    if (!isLoaded || busy) return;

    const trimmed = email.trim();
    if (!trimmed || !EMAIL_RE.test(trimmed)) {
      setErrors({
        email: trimmed ? "That doesn't look like an email address." : 'Enter your email address.',
      });
      emailRef.current?.focus();
      return;
    }

    setBusy(true);
    setErrors({});
    setNotice(null);
    setUnknownEmail(false);
    try {
      await sendCode(signIn);
      setStep('reset');
    } catch (err) {
      setErrors(visibleOn(toFieldErrors(err), ['email']));
      // Clerk's own message for this is clear; the extra affordance is the
      // offer to go create the account instead, since "no account" and "wrong
      // address" are the only two things it can mean.
      setUnknownEmail(hasClerkCode(err, 'form_identifier_not_found'));
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
      await sendCode(signIn);
      setCode('');
      setNotice('New code sent.');
    } catch (err) {
      // The email field isn't on screen during a resend, so an identifier-level
      // rejection has to surface at form level or not at all.
      setErrors(visibleOn(toFieldErrors(err), ['code', 'password']));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Shared tail: a `complete` status that still has to survive `setActive`.
   * Handles its own failure rather than throwing, because the caller's catch
   * is about *verification* errors and this isn't one — the code was accepted
   * and the password is saved; only the session activation missed.
   *
   * The session id is recorded here and not before the attempt: recorded
   * up-front it would flip the screen into its stranded state for a frame on
   * the way out of a perfectly successful reset.
   */
  async function activate(activate_: SetActive, sessionId: string | null | undefined) {
    if (!sessionId) {
      // `setActive({ session: null })` is a legal *deactivate* call: it would
      // resolve, navigate nowhere, and report nothing — a silent dead end on
      // the one screen that must never produce one.
      setErrors({
        form: "Your password is saved, but we couldn't open your session. Sign in with your new password.",
      });
      return;
    }
    try {
      await activate_({ session: sessionId });
    } catch {
      setPendingSessionId(sessionId ?? null);
      // The hero explains this state, so no form error — it would print the
      // same sentence twice, in red, about something that mostly succeeded.
      // Still announced, because a VoiceOver user won't notice a heading
      // changing under them.
      AccessibilityInfo.announceForAccessibility(
        'Your new password is saved. Tap Continue to finish signing in.',
      );
    }
  }

  async function onReset() {
    if (!isLoaded || busy) return;

    const local: AuthFieldErrors = {};
    if (code.length !== CODE_LENGTH) local.code = `Enter the ${CODE_LENGTH}-digit code.`;
    if (!password) local.password = 'Choose a new password.';
    else if (password.length < MIN_PASSWORD) {
      local.password = `Use at least ${MIN_PASSWORD} characters.`;
    }
    if (local.code || local.password) {
      setErrors(local);
      (local.code ? codeRef : passwordRef).current?.focus();
      return;
    }

    setBusy(true);
    setErrors({});
    setNotice(null);
    try {
      const attempt = await signIn.attemptFirstFactor({
        strategy: RESET_STRATEGY,
        code,
        password,
      });

      // `needs_new_password` is the one status that means the code was
      // accepted and the password was NOT set. It can't happen while we always
      // send `password`, but the flag is claimed in four places downstream, so
      // it gets set per-branch rather than eagerly — an eager `true` here would
      // make this branch assert the exact opposite of what happened.
      if (attempt.status === 'needs_new_password') {
        setErrors({
          form: 'Your code was accepted but the new password was not saved. Enter it again.',
        });
        return;
      }

      if (attempt.status === 'complete') {
        setPasswordChanged(true);
        await activate(setActive, attempt.createdSessionId);
        return; // Root layout's auth effect routes onward.
      }

      if (attempt.status === 'needs_second_factor') {
        setPasswordChanged(true);
        const supported = attempt.supportedSecondFactors ?? [];

        // Preparing an emailed or texted factor is a *network call*, and email
        // code is this instance's configured method — so this is the common
        // path, not an exotic one. Left inside the outer try, a failure here
        // would land in the catch below as "check your connection and try
        // again" over the reset form, with the now-spent code still in it, on
        // a screen whose whole reason for existing is to never let someone
        // walk away thinking their password didn't change. Same shape as
        // sign-up's create/prepare split.
        try {
          const chosen = await prepareBestSecondFactor(signIn, supported);
          if (chosen) {
            setSecondFactor(chosen);
            setStep('second_factor');
            return;
          }
          setErrors({
            form: `Your password is saved, but this account's second factor (${describeFactors(
              supported,
            )}) isn't supported here yet. Sign in on the web app with your new password.`,
          });
        } catch {
          setErrors({
            form: "Your password is saved, but we couldn't send your verification code. Sign in with your new password to finish.",
          });
        }
        return;
      }

      // Deliberately does not claim the password was saved: this branch is
      // whatever Clerk adds next, and guessing on its behalf is how the "we
      // sent you a code" lie gets written.
      setErrors({
        form: `Your code was accepted, but signing in needs another step (${attempt.status}). Finish on the web app.`,
      });
    } catch (err) {
      const next = toFieldErrors(err);
      setErrors(visibleOn(next, ['code', 'password']));
      // Only a rejected code gets cleared. A network failure leaves a
      // correctly typed code alone.
      if (next.code) setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function onSecondFactor() {
    if (!isLoaded || busy || !secondFactor) return;
    if (!mfaCode.trim()) {
      setErrors({ code: 'Enter your verification code.' });
      return;
    }

    setBusy(true);
    setErrors({});
    setNotice(null);
    try {
      const attempt = await signIn.attemptSecondFactor({
        strategy: secondFactor,
        code: mfaCode.trim(),
        // Same typings gap as prepareSecondFactor — see lib/secondFactor.ts.
      } as unknown as Parameters<typeof signIn.attemptSecondFactor>[0]);

      if (attempt.status === 'complete') {
        await activate(setActive, attempt.createdSessionId);
        return;
      }
      setErrors({ form: `Verification incomplete (${attempt.status}).` });
    } catch (err) {
      setErrors(visibleOn(toFieldErrors(err), ['code']));
    } finally {
      setBusy(false);
    }
  }

  /** Retry for a session that was created but whose activation failed. */
  async function onFinish() {
    if (!isLoaded || busy) return;
    setBusy(true);
    setErrors({});
    try {
      await setActive({ session: pendingSessionId ?? signIn.createdSessionId });
    } catch (err) {
      setErrors(visibleOn(toFieldErrors(err), []));
    } finally {
      setBusy(false);
    }
  }

  const meetsLength = password.length >= MIN_PASSWORD;
  /**
   * Verified and the password saved, but the session never activated. Not
   * gated on `!busy`: once `pendingSessionId` is only written on failure there
   * is nothing to debounce, and gating it would flash the reset form back on
   * screen for the duration of the Continue retry.
   */
  const stranded = pendingSessionId !== null;
  const submitting = busy || !isLoaded;

  const submitLabel = stranded
    ? 'Continue'
    : step === 'request'
      ? 'Send reset code'
      : step === 'reset'
        ? 'Reset password'
        : 'Verify';
  const submitAction = stranded
    ? onFinish
    : step === 'request'
      ? onRequest
      : step === 'reset'
        ? onReset
        : onSecondFactor;

  // `stranded` first: the step-specific titles all describe something the user
  // has already done by then, and "Choose a new password" over a screen whose
  // only control is Continue reads as a form that failed to load.
  const title = stranded
    ? 'Almost there'
    : step === 'request'
      ? 'Reset your password'
      : step === 'reset'
        ? 'Choose a new password'
        : 'One more step';

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>VOLA</Text>
        <Text style={styles.title}>{title}</Text>

        {/* Every subtitle below describes a step still to be done, so all of
            them are wrong once the only remaining action is Continue. */}
        {stranded ? (
          <Text style={styles.subtitle}>
            <Text style={styles.subtitleGood}>Your new password is saved.</Text> We just
            couldn&apos;t open your session — tap Continue, or sign in with your new password.
          </Text>
        ) : (
          <>
            {step === 'request' && (
              <Text style={styles.subtitle}>
                We&apos;ll email you a {CODE_LENGTH}-digit code to confirm it&apos;s you.
              </Text>
            )}

            {/* No "we couldn't send it" variant here, unlike sign-up: a failed
                send leaves this screen on the request step, because nothing was
                created that would make going back a dead end. Reaching 'reset'
                at all means a code went out. */}
            {step === 'reset' && (
              <Text style={styles.subtitle}>
                Enter the code we sent to <Text style={styles.subtitleStrong}>{email.trim()}</Text>,
                then pick a new password.
              </Text>
            )}

            {step === 'second_factor' && (
              <Text style={styles.subtitle}>
                <Text style={styles.subtitleGood}>Your new password is saved.</Text>{' '}
                {secondFactor ? secondFactorPrompt(secondFactor) : 'Enter your verification code'}{' '}
                to finish signing in.
              </Text>
            )}
          </>
        )}
      </View>

      {step === 'request' && (
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
              setUnknownEmail(false);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            keyboardType="email-address"
            returnKeyType="go"
            onSubmitEditing={onRequest}
            editable={!busy}
            accessibilityLabel="Email address"
            testID="forgot-email"
          />
          {errors.email && (
            <Text style={styles.fieldError} accessibilityRole="alert" testID="forgot-email-error">
              {errors.email}
            </Text>
          )}
          {unknownEmail && (
            <Pressable
              onPress={() =>
                router.replace(
                  email.trim()
                    ? { pathname: '/sign-up', params: { email: email.trim() } }
                    : '/sign-up',
                )
              }
              hitSlop={12}
              accessibilityRole="link"
              testID="forgot-to-sign-up"
            >
              <Text style={styles.inlineLink}>Create an account with that email instead</Text>
            </Pressable>
          )}
        </View>
      )}

      {step === 'reset' && !stranded && (
        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>Verification code</Text>
            <TextInput
              ref={codeRef}
              style={[styles.input, styles.codeInput, errors.code && styles.inputInvalid]}
              placeholder="000000"
              placeholderTextColor={vola.textDim}
              value={code}
              onChangeText={(raw) => {
                // No `maxLength`: it truncates natively before this runs, so a
                // pasted "123 456" would silently keep five digits.
                setCode(raw.replace(/\D/g, '').slice(0, CODE_LENGTH));
                clearFieldError('code');
              }}
              autoFocus
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              editable={!busy}
              accessibilityLabel={`${CODE_LENGTH}-digit verification code`}
              testID="forgot-code"
            />
            {errors.code && (
              <Text style={styles.fieldError} accessibilityRole="alert" testID="forgot-code-error">
                {errors.code}
              </Text>
            )}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>New password</Text>
            <View style={styles.passwordRow}>
              <TextInput
                ref={passwordRef}
                style={[styles.input, styles.passwordInput, errors.password && styles.inputInvalid]}
                placeholder="Enter a new password"
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
                onSubmitEditing={onReset}
                editable={!busy}
                accessibilityLabel="New password"
                testID="forgot-password-input"
              />
              <Pressable
                style={styles.reveal}
                onPress={() => setShowPassword((v) => !v)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                testID="forgot-reveal"
              >
                <Text style={styles.revealText}>{showPassword ? 'Hide' : 'Show'}</Text>
              </Pressable>
            </View>
            <Text style={[styles.hint, meetsLength && styles.hintMet]}>
              {meetsLength ? '✓' : '•'} At least {MIN_PASSWORD} characters
            </Text>
            {errors.password && (
              <Text
                style={styles.fieldError}
                accessibilityRole="alert"
                testID="forgot-password-error"
              >
                {errors.password}
              </Text>
            )}
          </View>

          <View style={styles.resendRow}>
            {resendIn > 0 ? (
              <Text style={styles.hint} testID="forgot-resend-cooldown">
                Resend in {resendIn}s
              </Text>
            ) : (
              <Pressable
                onPress={onResend}
                disabled={busy}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Resend reset code"
                accessibilityState={{ disabled: busy }}
                testID="forgot-resend"
              >
                <Text style={[styles.inlineLink, busy && styles.dimmed]}>Resend code</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                setStep('request');
                setCode('');
                setErrors({});
                setNotice(null);
              }}
              disabled={busy}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Use a different email address"
              accessibilityState={{ disabled: busy }}
              testID="forgot-change-email"
            >
              <Text style={[styles.mutedLink, busy && styles.dimmed]}>Use a different email</Text>
            </Pressable>
          </View>
        </View>
      )}

      {step === 'second_factor' && !stranded && (
        <View style={styles.field}>
          <Text style={styles.label}>
            {secondFactor === 'backup_code' ? 'Backup code' : 'Verification code'}
          </Text>
          <TextInput
            style={[styles.input, styles.codeInput, errors.code && styles.inputInvalid]}
            placeholder={secondFactor === 'backup_code' ? 'Backup code' : '000000'}
            placeholderTextColor={vola.textDim}
            value={mfaCode}
            onChangeText={(v) => {
              setMfaCode(v);
              clearFieldError('code');
            }}
            autoFocus
            autoCapitalize="none"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            keyboardType={secondFactor === 'backup_code' ? 'default' : 'number-pad'}
            editable={!busy}
            accessibilityLabel="Two-factor verification code"
            testID="forgot-mfa-code"
          />
          {errors.code && (
            <Text style={styles.fieldError} accessibilityRole="alert" testID="forgot-mfa-error">
              {errors.code}
            </Text>
          )}
        </View>
      )}

      {notice && (
        <Text style={styles.notice} accessibilityLiveRegion="polite" testID="forgot-notice">
          {notice}
        </Text>
      )}
      {errors.form && (
        <Text style={styles.formError} accessibilityRole="alert" testID="forgot-error">
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
        testID="forgot-submit"
      >
        {busy ? (
          <ActivityIndicator color={vola.navy} />
        ) : (
          <Text style={styles.buttonText}>{submitLabel}</Text>
        )}
      </Pressable>

      <Pressable
        style={styles.footer}
        onPress={goToSignIn}
        hitSlop={12}
        accessibilityRole="link"
        accessibilityLabel="Back to sign in"
        testID="forgot-to-sign-in"
      >
        {/* Even after the password is saved: if they abandon a second factor,
            sign-in with the new password is the way back, not this screen. */}
        <Text style={styles.footerText}>
          {passwordChanged ? 'Password saved — ' : ''}
          <Text style={styles.footerLink}>Back to sign in</Text>
        </Text>
      </Pressable>
    </ScrollView>
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
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
    gap: 20,
  },

  hero: { gap: 6 },
  eyebrow: { color: vola.accent, fontSize: 11, letterSpacing: 1.6, fontWeight: '700' },
  title: { fontSize: 26, fontWeight: '700' },
  subtitle: { color: vola.textMuted, fontSize: 14, lineHeight: 20 },
  subtitleStrong: { color: vola.text, fontWeight: '600' },
  subtitleGood: { color: vola.green, fontWeight: '600' },

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
    // letterSpacing trails the final glyph, pulling centred text half a step
    // left; the extra 10 on the left puts it back.
    paddingLeft: 24,
    paddingRight: 14,
  },

  resendRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },

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
    minHeight: 52,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: vola.navy, fontWeight: '700', fontSize: 16 },

  footer: { alignItems: 'center', paddingVertical: 4 },
  footerText: { color: vola.textMuted, fontSize: 14 },
  footerLink: { color: vola.accent, fontWeight: '600' },
});
