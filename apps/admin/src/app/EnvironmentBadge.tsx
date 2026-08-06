/**
 * Which environment this console is writing to.
 *
 * **Why this exists at all.** Content authored here is live to athletes the
 * moment it saves — no pull request, no deploy, no review. The one input to
 * that which the operator cannot see from the screen is *which database they
 * are talking to*, and the console is a URL you keep open in a tab. Editing
 * production while believing you are on staging is the same class of silent
 * mistake the rest of this design spends its effort on, and it is the only one
 * with no undo path that helps: the revision history faithfully records that
 * you did it, in the wrong place.
 *
 * **Explicit, not derived.** `NEXT_PUBLIC_CONTENT_ENV` names the environment
 * rather than the badge guessing from the API hostname. A guess is a rule that
 * is right until someone adds a domain, and being wrong here is exactly the
 * failure the badge exists to prevent.
 *
 * **Loud where it is dangerous, quiet where it is not.** A localhost API needs
 * no warning and gets muted styling; an unset variable against a REMOTE API is
 * the genuinely dangerous state and says so. That asymmetry is deliberate — a
 * banner that shouts on every local `pnpm dev` is a banner nobody reads by
 * Thursday, which is precisely how the warning stops working on the day it
 * matters.
 */

type Tone = "local" | "safe" | "danger" | "unknown";

const KNOWN: Record<string, { label: string; tone: Tone }> = {
  local: { label: "Local", tone: "local" },
  staging: { label: "Staging", tone: "safe" },
  production: { label: "Production", tone: "danger" },
};

/** Exported for the test: the classification, without the markup. */
export function classifyEnvironment(
  contentEnv: string | undefined,
  apiUrl: string | undefined,
): { label: string; tone: Tone } {
  const named = KNOWN[(contentEnv ?? "").trim().toLowerCase()];
  if (named) return named;

  // Unset. A localhost API is the ordinary dev case and needs no alarm.
  const url = apiUrl ?? "";
  if (url === "" || url.includes("localhost") || url.includes("127.0.0.1")) {
    return KNOWN.local;
  }
  // Unset AND remote: this console writes live content somewhere and cannot say
  // where. Naming that plainly beats inventing a reassuring default.
  return { label: "Unlabelled environment", tone: "unknown" };
}

const TONE_CLASS: Record<Tone, string> = {
  local: "border-border text-text-muted",
  safe: "border-border-strong text-text",
  // Production is the one an operator must never mistake for anything else.
  danger: "border-danger-border bg-danger-bg text-danger-text",
  unknown: "border-danger-border bg-danger-bg text-danger-text",
};

export function EnvironmentBadge() {
  const { label, tone } = classifyEnvironment(
    process.env.NEXT_PUBLIC_CONTENT_ENV,
    process.env.NEXT_PUBLIC_API_URL,
  );

  return (
    <span
      // The accessible name says what the visual conveys by placement and
      // colour, since "Production" alone is not obviously *this console's
      // target* to a screen reader reading the header in order.
      aria-label={`This console is writing to: ${label}`}
      title={`Writes go to ${label}. Set NEXT_PUBLIC_CONTENT_ENV to change what this says.`}
      className={`rounded-full border px-2.5 py-0.5 font-barlow-condensed text-[10px] font-bold tracking-[0.14em] uppercase ${TONE_CLASS[tone]}`}
    >
      {label}
    </span>
  );
}
