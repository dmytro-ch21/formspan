/**
 * How a failure reaches admin's error boundary in a PRODUCTION build — F65 (#1182).
 *
 * Every admin screen reads through `@/lib/api` from a Server Component, and a
 * production build does not send a Server Component error's message to the
 * browser. Measured on `next build` + `next start`: the boundary received
 * "Minified React error #441" in place of `API responded 403 for /admin/users`,
 * and nothing else but `digest`. `error.tsx` used to classify by
 * `error.message.includes("403")`, so in production every failure — the
 * ADMIN_USER_IDS-drift 403 it was written for included — told the operator to
 * check that the API was running.
 *
 * `digest` is the one field that crosses. Next generates one (a hash) unless
 * the thrown error already carries one, and then keeps it —
 * `next/dist/server/app-render/create-error-handler.js`, "respect the original
 * digest". So a failure is classified where it is CREATED, on the server, and
 * the classification rides to the browser in the digest:
 *
 *     VOLA_ADMIN;<kind>;<ref>          forbidden | unauthorized | timeout | unreachable
 *     VOLA_ADMIN;api;<status>;<ref>    any other status the API answered with
 *
 * - **Nothing sensitive crosses**: a kind, an HTTP status, a random reference.
 *   The page's own copy already tells the viewer the kind.
 * - **`ref` is per throw**, so the operator can find the one server log line —
 *   Next logs the full error, message and all, beside its digest.
 * - **Never a `NEXT_` prefix.** Next routes several of its own digests by prefix
 *   (`NEXT_REDIRECT`, `NEXT_HTTP_ERROR_FALLBACK;404`), and a collision would turn
 *   a failure into a navigation.
 *
 * No `server-only` here on purpose: `error.tsx` is a Client Component and reads
 * this module's parser.
 */

export type AdminFailureKind = "forbidden" | "unauthorized" | "timeout" | "unreachable" | "api";

export type AdminFailure = {
  kind: AdminFailureKind;
  /** Only on `api`: the status the API answered with. */
  status?: number;
  /** Per-throw reference, printed beside the full error in the server log. */
  ref: string;
};

const PREFIX = "VOLA_ADMIN";
const KINDS: readonly AdminFailureKind[] = ["forbidden", "unauthorized", "timeout", "unreachable", "api"];

/** What an HTTP status from the API means to an operator. */
export function kindForStatus(status: number): AdminFailureKind {
  if (status === 403) return "forbidden";
  if (status === 401) return "unauthorized";
  return "api";
}

export function failureDigest(kind: AdminFailureKind, status?: number, ref = newRef()): string {
  return kind === "api" ? `${PREFIX};api;${status ?? 0};${ref}` : `${PREFIX};${kind};${ref}`;
}

/**
 * The classification a digest carries, or null for any digest this console did
 * not write — Next's own hash for an error nothing classified, most commonly.
 * Null is a real answer and the boundary says so; it is not "the API is down".
 */
export function failureFromDigest(digest: string | undefined): AdminFailure | null {
  if (!digest) return null;
  const parts = digest.split(";");
  if (parts[0] !== PREFIX) return null;
  const kind = parts[1] as AdminFailureKind;
  if (!KINDS.includes(kind)) return null;
  if (kind === "api") {
    if (parts.length !== 4 || !/^\d+$/.test(parts[2])) return null;
    return { kind, status: Number(parts[2]), ref: parts[3] };
  }
  if (parts.length !== 3) return null;
  return { kind, ref: parts[2] };
}

/**
 * Stamp a thrown value with a classification — for the failures whose class is
 * not this app's to construct (a `TimeoutError`, a `fetch` rejection). Leaves a
 * digest that is already there alone: whoever set it knew more.
 */
export function withFailureDigest<T>(err: T, kind: AdminFailureKind): T {
  if (err !== null && typeof err === "object") {
    const e = err as { digest?: unknown };
    if (!e.digest) e.digest = failureDigest(kind);
  }
  return err;
}

function newRef(): string {
  return globalThis.crypto.randomUUID().slice(0, 8);
}
