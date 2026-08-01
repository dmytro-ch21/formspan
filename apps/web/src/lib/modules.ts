import { newTraceId, traceparent } from "@/lib/trace";

/**
 * The discipline registry, client half — deliberately WITHOUT "use client".
 *
 * This lives apart from `api.ts` for one hard reason, found by running it
 * rather than reading it: `api.ts` carries a `"use client"` directive, so
 * every one of its exports is a *client reference*. `dashboard/layout.tsx` is
 * a Server Component, and calling a client reference from the server throws
 *
 *   Attempted to call listModules() from the server but listModules is on the
 *   client. It's not possible to invoke a client function from the server.
 *
 * The layout wrapped that call in a bare `catch {}` meant for network blips,
 * so the throw was swallowed on EVERY request and `modules` was always `[]` —
 * the whole gating feature silently ran in its own failure mode, while
 * `pnpm run build:web` stayed green because this is a runtime error, not a
 * compile one. The nav's fail-open fallback is what hid it: nothing looked
 * broken, it just never gated.
 *
 * So: no directive here. Client components import this happily; the server
 * layout can actually call it. Nothing in it touches a browser API.
 *
 * `api.ts` re-exports these so existing client call sites are unchanged.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

type Token = (opts?: { template?: string }) => Promise<string | null>;

/**
 * A private copy of `api.ts`'s request helper.
 *
 * Importing the original would pull the client module back in and reinstate
 * exactly the boundary error this file exists to avoid.
 */
async function modulesRequest<T>(
  getToken: Token,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Not signed in.");
  const res = await fetch(`${API_BASE}/modules`, {
    ...init,
    signal,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      traceparent: traceparent(newTraceId()),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

export type ModuleCapabilities = {
  /** "exercises" | "techniques" | "" — what the Library shows for this. */
  catalog: string;
  /** Extra filter axes beyond the catalog's own. BJJ has "position". */
  facets: string[];
  has_goals: boolean;
  has_progression: boolean;
  /**
   * Personal-best kinds that mean anything here. Empty for BJJ — which is why
   * Records is gated on "any enabled module has record kinds" rather than on
   * a sport name.
   */
  record_kinds: string[];
};

export type Module = {
  key: string;
  /** Carries the acronym: "BJJ", not the "Bjj" capitalising the key gives. */
  label: string;
  is_sport: boolean;
  default_on: boolean;
  enabled: boolean;
  capabilities: ModuleCapabilities;
};

/** Normalise at the parse boundary — an older server may omit array fields. */
function normaliseModule(m: Partial<Module> & { key: string }): Module {
  const c = m.capabilities ?? ({} as Partial<ModuleCapabilities>);
  return {
    key: m.key,
    label: m.label ?? m.key,
    is_sport: m.is_sport ?? false,
    default_on: m.default_on ?? false,
    enabled: m.enabled ?? m.default_on ?? false,
    capabilities: {
      catalog: c.catalog ?? "",
      facets: c.facets ?? [],
      has_goals: c.has_goals ?? false,
      has_progression: c.has_progression ?? false,
      record_kinds: c.record_kinds ?? [],
    },
  };
}

export function normaliseModules(raw: unknown): Module[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Partial<Module> & { key: string } => typeof m?.key === "string" && m.key)
    .map(normaliseModule);
}

export async function listModules(getToken: Token, signal?: AbortSignal): Promise<Module[]> {
  const b = await modulesRequest<{ modules: Module[] }>(getToken, {}, signal);
  return normaliseModules(b.modules);
}

/** Toggle modules. Sparse — send only what changed. */
export async function setModules(
  getToken: Token,
  changes: Record<string, boolean>,
): Promise<Module[]> {
  const b = await modulesRequest<{ modules: Module[] }>(getToken, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
  return normaliseModules(b.modules);
}

/** The enabled modules that can actually be a session's sport. */
export function enabledSports(modules: Module[]): Module[] {
  return modules.filter((m) => m.enabled && m.is_sport);
}

export function moduleFor(modules: Module[], key: string): Module | undefined {
  return modules.find((m) => m.key === key);
}

/** Label for a key, falling back to the key — never "Bjj". */
export function labelForModule(modules: Module[], key: string): string {
  return moduleFor(modules, key)?.label ?? key;
}

