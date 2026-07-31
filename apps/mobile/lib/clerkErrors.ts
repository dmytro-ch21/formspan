/**
 * Turning Clerk's error shape into something a form can render.
 *
 * Clerk returns `{ errors: [{ code, message, longMessage, meta: { paramName } }] }`.
 * The `paramName` is what lets a message land under the input that caused it
 * instead of pooling at the bottom of the screen — the difference between
 * "that email is taken" being an answer and being an announcement.
 *
 * The important case is the one with no `errors` array at all: no signal, DNS
 * failure, a 5xx. Nothing about the user's input is known to be wrong then, so
 * it must never be attributed to a field. That is the whole reason this lives
 * in one place rather than being re-derived per screen.
 */

export type ClerkFieldError = {
  code?: string;
  message?: string;
  longMessage?: string;
  meta?: { paramName?: string };
};

export type AuthFieldKey = 'email' | 'password' | 'code' | 'form';
export type AuthFieldErrors = Partial<Record<AuthFieldKey, string>>;

export const GENERIC_AUTH_ERROR = 'Something went wrong. Check your connection and try again.';

/**
 * Clerk's param names across the three auth screens. `email_address` is what
 * sign-up calls it; `identifier` is what sign-in and password reset call the
 * same field. Both map to the same input.
 */
const PARAM_TO_FIELD: Record<string, AuthFieldKey> = {
  email_address: 'email',
  identifier: 'email',
  password: 'password',
  code: 'code',
};

export function clerkErrors(err: unknown): ClerkFieldError[] {
  if (err && typeof err === 'object' && 'errors' in err) {
    const list = (err as { errors?: ClerkFieldError[] }).errors;
    if (Array.isArray(list)) return list;
  }
  return [];
}

export function hasClerkCode(err: unknown, code: string): boolean {
  return clerkErrors(err).some((e) => e.code === code);
}

/**
 * The first user-facing message, for screens that show one error at a time.
 *
 * `longMessage` only, then the fallback — deliberately NOT `|| message`.
 * Clerk's `message` is sometimes a sentence fragment ("is incorrect") that
 * reads as gibberish standing alone, and this function replaced sign-in's own
 * helper, which had the same rule. An extraction that quietly changes the
 * behaviour of the screen it was extracted from is a regression wearing a
 * refactor's clothes.
 */
export function firstClerkMessage(err: unknown, fallback: string): string {
  return clerkErrors(err)[0]?.longMessage || fallback;
}

/** Route each error to the input that produced it; anything unmapped is form-level. */
export function toFieldErrors(err: unknown): AuthFieldErrors {
  const list = clerkErrors(err);
  if (list.length === 0) return { form: GENERIC_AUTH_ERROR };

  const out: AuthFieldErrors = {};
  for (const e of list) {
    const field = PARAM_TO_FIELD[e.meta?.paramName ?? ''] ?? 'form';
    // First message per field wins: Clerk can return several for one param and
    // stacking them reads as noise on a phone.
    if (!out[field]) out[field] = e.longMessage || e.message || GENERIC_AUTH_ERROR;
  }
  return out;
}
