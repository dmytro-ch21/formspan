import { newTraceId, traceparent } from "@/lib/trace";
import type { UnitSystem } from "@/lib/units";

/**
 * The athlete's unit preference, server half — deliberately WITHOUT "use client".
 *
 * Same reason as `lib/modules.ts`, and the same trap: `api.ts` carries a
 * `"use client"` directive, so every one of its exports is a *client
 * reference*, and `dashboard/layout.tsx` is a Server Component. Calling
 * `getProfile` from there throws
 *
 *   Attempted to call getProfile() from the server but getProfile is on the
 *   client.
 *
 * — at runtime, not at build time, which is how the module-gating feature
 * silently ran in its own failure mode for a while. This file exists so the
 * layout can read one enum before anything renders.
 *
 * It reads the whole profile and returns one field on purpose: there is no
 * narrower endpoint, and inventing a `unit_system`-only response would be a
 * contract change to save a few hundred bytes on one request per page load.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

type Token = (opts?: { template?: string }) => Promise<string | null>;

/**
 * The preference, or `metric` if it cannot be established.
 *
 * **Never throws**, and that is deliberate rather than lazy. The caller is a
 * layout that must render: a units read failing has to degrade to a default,
 * exactly as the modules read degrades to "show everything", because the
 * alternative is a blank dashboard when the API hiccups. `metric` is also what
 * a new account gets, so the fallback is the same value the server would have
 * returned for most of the accounts that have never touched the setting.
 */
export async function fetchUnitSystem(getToken: Token, signal?: AbortSignal): Promise<UnitSystem> {
  try {
    const token = await getToken();
    if (!token) return "metric";
    const res = await fetch(`${API_BASE}/profile`, {
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        traceparent: traceparent(newTraceId()),
      },
      // The preference changes about once in an account's lifetime, but it is
      // read on every dashboard render, so a stale cache would show the wrong
      // units for as long as it lived. Correctness over one request.
      cache: "no-store",
    });
    if (!res.ok) return "metric";
    const body = await res.json().catch(() => null);
    return body?.unit_system === "imperial" ? "imperial" : "metric";
  } catch {
    return "metric";
  }
}
