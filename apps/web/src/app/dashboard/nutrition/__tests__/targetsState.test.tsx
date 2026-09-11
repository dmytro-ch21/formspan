import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Target } from "@/lib/nutritionApi";
import {
  loadTargetsInto,
  sourceLabel,
  TargetHistory,
  TargetsLoadFailed,
  targetsView,
} from "../targets/targetsState";

/**
 * N127 (#531) — a failed load of the targets page must not read as "you have
 * never set a target".
 *
 * The acceptance criterion asks for this to be shown by forcing the fetch to
 * reject rather than by reading the code, so the page's load runs here with a
 * request that rejects, and the page's own gate is applied to what it recorded.
 */

const target = (over: Partial<Target> = {}): Target => ({
  user_id: "u",
  effective_on: "2026-09-01",
  kcal: 2500,
  protein_g: 180,
  carb_g: 250,
  fat_g: 80,
  fibre_g: null,
  source: "manual",
  basis: null,
  created_at: "",
  updated_at: "",
  ...over,
});

/** A stand-in for the page's four setters, keeping every call in order. */
function recorder() {
  const calls = {
    targets: [] as Target[][],
    adjustment: [] as unknown[],
    loaded: [] as boolean[],
    loadError: [] as (string | null)[],
  };
  const sink = {
    setTargets: (t: Target[]) => void calls.targets.push(t),
    setAdjustment: (a: unknown) => void calls.adjustment.push(a),
    setLoaded: (v: boolean) => void calls.loaded.push(v),
    setLoadError: (m: string | null) => void calls.loadError.push(m),
  };
  /** The state the page would render from, after these calls. */
  const view = () => targetsView(calls.loaded.at(-1) ?? false, calls.loadError.at(-1) ?? null);
  return { calls, sink, view };
}

const signal = () => new AbortController().signal;

describe("the load, with a request that rejects", () => {
  it("is a failure the page shows as one — never marked loaded, never handed an empty list", async () => {
    const { calls, sink, view } = recorder();
    await loadTargetsInto(() => Promise.reject(new TypeError("Failed to fetch")), sink, signal());

    expect(calls.loaded).toEqual([]);
    expect(calls.targets).toEqual([]);
    expect(calls.loadError).toEqual([null, "Failed to fetch"]);
    expect(view()).toBe("failed");

    const html = renderToStaticMarkup(<TargetsLoadFailed message="Failed to fetch" onRetry={() => {}} />);
    expect(html).toContain("Your targets did not load");
    expect(html).toContain("Failed to fetch");
    expect(html).toContain("not telling you whether you have one");
    expect(html).toContain("Try again");
  });

  it("still says it failed when the rejection carries no message", async () => {
    const { calls, sink, view } = recorder();
    await loadTargetsInto(() => Promise.reject("nope"), sink, signal());
    expect(calls.loadError.at(-1)).toBe("Could not load your targets.");
    expect(view()).toBe("failed");
  });

  it("writes nothing after it once a newer load has aborted it", async () => {
    const c = new AbortController();
    const { calls, sink, view } = recorder();
    const pending = loadTargetsInto(
      () => new Promise<[Target[], null]>((_, reject) => setTimeout(() => reject(new Error("late")), 0)),
      sink,
      c.signal,
    );
    c.abort();
    await pending;
    expect(calls.loadError).toEqual([null]);
    expect(calls.loaded).toEqual([]);
    expect(view()).toBe("loading");
  });
});

describe("the load, with a request that succeeds", () => {
  it("sets the data, then marks it loaded", async () => {
    const { calls, sink, view } = recorder();
    await loadTargetsInto(() => Promise.resolve([[target()], null]), sink, signal());
    expect(calls.targets).toEqual([[target()]]);
    expect(calls.loaded).toEqual([true]);
    expect(calls.loadError).toEqual([null]);
    expect(view()).toBe("ready");
  });

  it("a genuinely empty read is ready — the only state allowed to say there is no target", async () => {
    const { sink, view } = recorder();
    await loadTargetsInto(() => Promise.resolve([[], null]), sink, signal());
    expect(view()).toBe("ready");
  });
});

describe("targetsView", () => {
  it("never loaded: loading until a read fails, then failed", () => {
    expect(targetsView(false, null)).toBe("loading");
    expect(targetsView(false, "Failed to fetch")).toBe("failed");
  });

  it("loaded once: ready, even when a later refresh fails", () => {
    expect(targetsView(true, null)).toBe("ready");
    expect(targetsView(true, "Failed to fetch")).toBe("ready");
  });
});

describe("sourceLabel and the history rows", () => {
  it("names every known source, and something for an absent or unknown one", () => {
    expect(sourceLabel("manual")).toBe("typed");
    expect(sourceLabel("derived")).toBe("derived");
    expect(sourceLabel("adjustment")).toBe("weekly adjustment");
    expect(sourceLabel(undefined)).toBe("source not recorded");
    expect(sourceLabel("")).toBe("source not recorded");
    expect(sourceLabel("coach")).toBe("coach");
  });

  it("an absent source renders as words, not a bare trailing separator", () => {
    const html = renderToStaticMarkup(
      <TargetHistory targets={[target({ source: undefined as unknown as Target["source"] })]} />,
    );
    expect(html).toContain("source not recorded");
    expect(html).not.toMatch(/·\s*<\/span>/);
  });

  it("renders newest first, and nothing at all for an empty list", () => {
    const html = renderToStaticMarkup(
      <TargetHistory
        targets={[target({ effective_on: "2026-01-01" }), target({ effective_on: "2026-06-01", source: "derived" })]}
      />,
    );
    expect(html.indexOf("2026-06-01")).toBeLessThan(html.indexOf("2026-01-01"));
    expect(renderToStaticMarkup(<TargetHistory targets={[]} />)).toBe("");
  });
});
