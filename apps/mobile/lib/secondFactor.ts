import type { useSignIn } from '@clerk/clerk-expo';

/**
 * Choosing and preparing Clerk's second factor.
 *
 * Both sign-in and password reset can land on `needs_second_factor` — resetting
 * a password does not exempt an account from its own 2FA — and both then need
 * the identical dance: pick the best factor Clerk actually offers, and *send*
 * the ones that have to be sent before they can be entered.
 *
 * Historical note worth keeping, because it was load-bearing and is no longer
 * true: this used to carry `as unknown as Parameters<...>` on the `email_code`
 * prepare, on the belief that Clerk's types omitted `email_code` from the
 * second-factor params. At the pinned `@clerk/types`, `PrepareSecondFactorParams`
 * *does* include `EmailCodeSecondFactorConfig`, so the cast was suppressing type
 * checking on those props for no reason. Removed and verified by compiling
 * without it. The remaining cast at `attemptSecondFactor` (both call sites) is
 * still required, but for a different reason — `{ strategy: <4-way union>, code }`
 * doesn't satisfy a discriminated union — so don't "clean it up" by analogy.
 */

export type SecondFactorStrategy = 'totp' | 'phone_code' | 'backup_code' | 'email_code';

export type SignInResource = NonNullable<ReturnType<typeof useSignIn>['signIn']>;
export type SetActive = NonNullable<ReturnType<typeof useSignIn>['setActive']>;

/**
 * Clerk's own factor union, derived rather than restated — and the reason the
 * `prepareSecondFactor` calls below need no casts at all. `phoneNumberId` and
 * `emailAddressId` exist only on their respective variants, and TypeScript's
 * inferred type predicates narrow `.find((f) => f.strategy === '…')` to that
 * variant. Restate this as `{ strategy: string }` and the narrowing is gone,
 * the property accesses stop compiling, and the temptation is to paper over it
 * with a cast — which is exactly how the stale one described above survived.
 */
type SupportedFactor = NonNullable<SignInResource['supportedSecondFactors']>[number];

/**
 * Preference order: authenticator app, then SMS, then emailed code, then a
 * backup code. TOTP and backup codes are typed straight in; phone and email
 * codes must be requested first, which is why this is async.
 *
 * Returns `null` when Clerk offered nothing this app can drive — use
 * {@link describeFactors} to say what it *did* offer rather than dead-ending.
 */
export async function prepareBestSecondFactor(
  signIn: SignInResource,
  supported: readonly SupportedFactor[],
): Promise<SecondFactorStrategy | null> {
  if (supported.some((f) => f.strategy === 'totp')) return 'totp';

  const phone = supported.find((f) => f.strategy === 'phone_code');
  if (phone) {
    await signIn.prepareSecondFactor({
      strategy: 'phone_code',
      phoneNumberId: phone.phoneNumberId,
    });
    return 'phone_code';
  }

  const emailCode = supported.find((f) => f.strategy === 'email_code');
  if (emailCode) {
    await signIn.prepareSecondFactor({
      strategy: 'email_code',
      emailAddressId: emailCode.emailAddressId,
    });
    return 'email_code';
  }

  if (supported.some((f) => f.strategy === 'backup_code')) return 'backup_code';

  return null;
}

/** What Clerk actually offered, for an error message that can be acted on. */
export function describeFactors(supported: readonly SupportedFactor[]): string {
  return supported.map((f) => f.strategy).join(', ') || 'none reported';
}

export function secondFactorPrompt(strategy: SecondFactorStrategy): string {
  switch (strategy) {
    case 'phone_code':
      return 'Enter the code we texted you';
    case 'email_code':
      return 'Enter the code we emailed you';
    case 'backup_code':
      return 'Enter a backup code';
    case 'totp':
      return 'Enter the code from your authenticator app';
  }
}
