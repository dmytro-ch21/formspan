import { describe, expect, it } from "vitest";

import { classifyEnvironment } from "../EnvironmentBadge";

/**
 * The badge's whole job is to be right about which database this console
 * writes to. Content saved here is live to athletes immediately, so a badge
 * that says "Staging" over a production API is worse than no badge at all — a
 * wrong answer to a question the operator has stopped asking.
 *
 * The classification is the part with branches; the markup is not.
 */
describe("classifyEnvironment", () => {
  it("uses the explicit variable when it names a known environment", () => {
    expect(classifyEnvironment("production", "https://api.example.com")).toEqual({
      label: "Production",
      tone: "danger",
    });
    expect(classifyEnvironment("staging", "https://api-staging.example.com")).toEqual({
      label: "Staging",
      tone: "safe",
    });
  });

  it("is case- and whitespace-insensitive, because env vars arrive how they arrive", () => {
    expect(classifyEnvironment("  PRODUCTION ", "https://api.example.com").label).toBe(
      "Production",
    );
  });

  it("says Local when unset against a local API, without shouting", () => {
    // The quiet branch, and it has to stay quiet: a red banner on every
    // `pnpm dev` is a banner nobody reads by Thursday, which is exactly how
    // the warning stops working on the day it matters.
    for (const url of ["http://localhost:8080", "http://127.0.0.1:8080", "", undefined]) {
      const got = classifyEnvironment(undefined, url);
      expect(got, `for ${String(url)}`).toEqual({ label: "Local", tone: "local" });
    }
  });

  it("refuses to guess when unset against a REMOTE api", () => {
    // The dangerous state: this console writes live content somewhere and
    // cannot say where. Naming that plainly beats inventing a reassuring
    // default — and "safe-looking default" is the failure mode worth a test,
    // because it is the tempting implementation.
    const got = classifyEnvironment(undefined, "https://api.example.com");
    expect(got.label).toBe("Unlabelled environment");
    expect(got.tone).toBe("unknown");
    expect(got.label).not.toBe("Local");
    expect(got.label).not.toBe("Staging");
  });

  it("does not treat an unrecognised value as safe", () => {
    // A typo ("prod", "PROD-EU") must not fall through to something calm.
    expect(classifyEnvironment("prod", "https://api.example.com").tone).toBe("unknown");
  });
});
