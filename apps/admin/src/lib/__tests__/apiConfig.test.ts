import { describe, expect, it } from "vitest";

import { resolveApiBaseUrl } from "@/lib/apiConfig";

/**
 * N165/#542 — the resolution rule that decides whether a missing/invalid
 * `NEXT_PUBLIC_API_URL` falls back to `localhost` or throws. Mirrors
 * `apps/web/src/lib/__tests__/apiConfig.test.ts` — both apps share the same
 * resolution rule, tested the same way, against the same measured
 * `vitest run` → `NODE_ENV=test` fact each module's own doc comment records.
 */
describe("resolveApiBaseUrl", () => {
  describe("development mode (isDevelopment = true)", () => {
    it("falls back to localhost when the env var is unset", () => {
      expect(resolveApiBaseUrl(undefined, true)).toBe("http://localhost:8080");
    });

    it("falls back to localhost when the env var is an empty string", () => {
      expect(resolveApiBaseUrl("", true)).toBe("http://localhost:8080");
    });

    it("falls back to localhost when the env var is whitespace only", () => {
      expect(resolveApiBaseUrl("   ", true)).toBe("http://localhost:8080");
    });

    it("uses a real, explicitly-set value instead of the fallback", () => {
      expect(resolveApiBaseUrl("http://192.168.1.50:8080", true)).toBe(
        "http://192.168.1.50:8080",
      );
    });

    it("trims surrounding whitespace off an explicit value", () => {
      expect(resolveApiBaseUrl("  https://api.vola.fitness  ", true)).toBe(
        "https://api.vola.fitness",
      );
    });

    it("still throws on a present-but-malformed value — dev tolerates absence, never garbage", () => {
      expect(() => resolveApiBaseUrl("not-a-url", true)).toThrow(/not a valid http\(s\) URL/);
    });
  });

  describe("production mode (isDevelopment = false)", () => {
    it("throws when the env var is unset, naming the missing variable", () => {
      expect(() => resolveApiBaseUrl(undefined, false)).toThrow(/NEXT_PUBLIC_API_URL is not set/);
    });

    it("throws when the env var is an empty string", () => {
      expect(() => resolveApiBaseUrl("", false)).toThrow(/NEXT_PUBLIC_API_URL is not set/);
    });

    it("throws when the env var is whitespace only", () => {
      expect(() => resolveApiBaseUrl("   ", false)).toThrow(/NEXT_PUBLIC_API_URL is not set/);
    });

    it("never mentions localhost as an available fallback in the thrown message", () => {
      try {
        resolveApiBaseUrl(undefined, false);
        throw new Error("expected resolveApiBaseUrl to throw");
      } catch (e) {
        expect(String(e)).toMatch(/refusing to silently fall back/);
      }
    });

    it("resolves to a real, explicitly-set value", () => {
      expect(resolveApiBaseUrl("https://api.vola.fitness", false)).toBe(
        "https://api.vola.fitness",
      );
    });

    it("throws on a malformed value rather than sending garbage as a host", () => {
      expect(() => resolveApiBaseUrl("apivola-fitness-platform-staging", false)).toThrow(
        /not a valid http\(s\) URL/,
      );
    });
  });
});

/**
 * The module's own top-level constants, evaluated at import time from
 * whatever `process.env.NEXT_PUBLIC_API_URL`/`NODE_ENV` actually are in THIS
 * vitest process — the "don't break local dev/tests" regression check. A
 * broken fallback would make this import throw and turn the whole file red.
 */
describe("the module import itself, under this suite's real NODE_ENV/env", () => {
  it("resolves to the localhost fallback with no env var set, matching pre-N165 behaviour", async () => {
    const { API_URL, API_BASE } = await import("@/lib/apiConfig");
    expect(API_URL).toBe("http://localhost:8080");
    expect(API_BASE).toBe("http://localhost:8080/v1");
  });
});
