import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildEdgeIndex,
  foldForSearch,
  rankTechniques,
  resolveEdge,
  searchTechniques,
  type TechniqueSummary,
} from "../api";

/**
 * Searching the technique library, from the desktop side.
 *
 * `apps/web` and `apps/mobile` carry independent copies of this search — the
 * apps share no package, and mobile needs its copy to work offline. The copies
 * had exactly one test suite between them, on the phone, so a web-only
 * regression was invisible: the Library and the curriculum builder both search
 * through this file and nothing exercised it.
 *
 * These are the mobile suite's cases, ported. Keep the two in step — a case
 * added there and not here leaves the same hole this file was written to close.
 *
 * The failure they exist for: an athlete came out of a beginners' closed-guard
 * passing class and could not enter a single step of it, because search
 * required the typed string to be a contiguous substring of ONE field.
 * "arm bar" returned nothing while "armbar" returned 21; "break the guard"
 * returned nothing while "guard break" returned 5. The library held every
 * technique he was looking for.
 */

/** The real shipped catalog, so this tests the data that actually exists
 *  rather than a fixture that agrees with the code. */
function realCatalog(): TechniqueSummary[] {
  const path = join(
    __dirname,
    "../../../../../backend/internal/modules/technique/techniques.json",
  );
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >[];
  return raw.map((t) => ({
    ...(t as unknown as TechniqueSummary),
    aliases: (t.aliases as string[]) ?? [],
    position_detail: (t.position_detail as string) ?? "",
    typical_belt: (t.typical_belt as string) ?? "",
    ibjjf_ruleset_id: (t.ibjjf_ruleset_id as string) ?? "",
  }));
}

const catalog = realCatalog();

describe("foldForSearch", () => {
  it("strips diacritics so typed ASCII matches stored accents", () => {
    expect(foldForSearch("São Paulo Pass")).toBe("sao paulo pass");
    expect(foldForSearch("são")).toBe(foldForSearch("sao"));
  });

  it("folds every dash, and the hyphen, to a space", () => {
    // The catalog stores the en dash, the keyboard offers the hyphen, and
    // nobody reaches for either when searching. All three must land on one
    // string or the fold buys nothing.
    expect(foldForSearch("North–South Pass")).toBe("north south pass");
    expect(foldForSearch("North-South Pass")).toBe("north south pass");
    expect(foldForSearch("a—b")).toBe("a b");
  });
});

describe("the spoken forms of a technique", () => {
  it("has the catalog to search in the first place", () => {
    // If the path is wrong every assertion below passes vacuously against an
    // empty array. Asserted, not assumed.
    expect(catalog.length).toBeGreaterThan(400);
  });

  it.each([
    ["arm bar", "armbar-closed-guard", "one word stored, two typed"],
    ["knee cut", "knee-cut-pass", "hyphenated in the catalog"],
    [
      "break the guard",
      "closed-guard-standing-break",
      "a joiner the name does not contain",
    ],
    ["guard break", "closed-guard-standing-break", "words in the other order"],
    ["pass the guard", "knee-cut-pass", "spoken form of a whole category"],
    ["kimura side control", "kimura-side-control", "name plus position"],
    ["sao paulo", "sao-paulo-pass", "the original defect, still covered"],
  ])("%p finds %p (%s)", (query, id) => {
    expect(searchTechniques(catalog, query).map((t) => t.id)).toContain(id);
  });

  it("ANDs the terms rather than ORing them", () => {
    // The cheap way to make the above pass is to match ANY term, turning every
    // search into a firehose. Adding a word has to narrow.
    const knee = searchTechniques(catalog, "knee");
    const kneeBelly = searchTechniques(catalog, "knee belly");
    expect(knee.length).toBeGreaterThan(kneeBelly.length);
  });

  it("a term that matches nothing rejects the row outright", () => {
    expect(searchTechniques(catalog, "armbar zzzznotathing")).toHaveLength(0);
  });

  it("an empty query returns everything", () => {
    expect(searchTechniques(catalog, "   ")).toHaveLength(catalog.length);
    // A lone dash folds to "", which is not a search.
    expect(searchTechniques(catalog, "-")).toHaveLength(catalog.length);
  });

  it("does not match a single term straddling two fields", () => {
    const t = catalog.find((x) => x.aliases.length > 0);
    expect(t).toBeDefined();
    const glued = `${foldForSearch(t!.name)}${foldForSearch(t!.aliases[0])}`;
    expect(searchTechniques(catalog, glued).map((x) => x.id)).not.toContain(
      t!.id,
    );
  });

  it("does match separate terms living in different fields", () => {
    // "armbar guard" — name word plus position word. No single field holds
    // both contiguously, which is why the old search could not find it.
    expect(searchTechniques(catalog, "armbar guard").map((t) => t.id)).toContain(
      "armbar-closed-guard",
    );
  });
});

describe("rankTechniques", () => {
  it("puts an exact name match first", () => {
    expect(rankTechniques(catalog, "Knee-Cut Pass")[0].id).toBe(
      "knee-cut-pass",
    );
  });

  it("ranks every name match above every match found in another field", () => {
    const ranked = rankTechniques(catalog, "armbar");
    const isName = ranked.map((t) => foldForSearch(t.name).includes("armbar"));
    const firstNonName = isName.indexOf(false);
    // ASSERTED, not guarded. `if (firstNonName !== -1)` is one catalog edit
    // away from asserting nothing and passing.
    expect(firstNonName).not.toBe(-1);
    expect(isName.lastIndexOf(true)).toBeLessThan(firstNonName);
  });

  it("reaches techniques through category and function alone", () => {
    // The W_META rung had no behavioural cover, and `function` is the field
    // this app did not search at all until review caught it: "advance"
    // returned 131 on the phone and 0 here. Pinned with a query no other
    // field can satisfy.
    const reverse = searchTechniques(catalog, "reverse");
    const viaFunctionOnly = reverse.filter(
      (t) =>
        !foldForSearch(t.name).includes("reverse") &&
        !foldForSearch(t.position).includes("reverse") &&
        !t.aliases.some((a) => foldForSearch(a).includes("reverse")),
    );
    expect(viaFunctionOnly.length).toBeGreaterThan(20);
    expect(viaFunctionOnly.every((t) => t.function === "reverse")).toBe(true);

    const viaCategory = searchTechniques(catalog, "submission").filter(
      (t) => !foldForSearch(t.name).includes("submission"),
    );
    expect(viaCategory.length).toBeGreaterThan(20);
  });

  it("returns the same set as searchTechniques, only reordered", () => {
    // Two definitions of "matches" would drift, and the drift would show as a
    // technique findable in the Library but not in the curriculum builder.
    for (const q of ["armbar", "knee cut", "break the guard"]) {
      const a = searchTechniques(catalog, q)
        .map((t) => t.id)
        .sort();
      const b = rankTechniques(catalog, q)
        .map((t) => t.id)
        .sort();
      expect(b).toEqual(a);
    }
  });

  it("searchTechniques preserves the caller's order and rankTechniques does not", () => {
    // LOAD-BEARING. The Library merges search output against the exercise
    // catalog with a linear merge of two NAME-SORTED runs. Ranking inside
    // searchTechniques would corrupt that interleave into a jumble — no type
    // error, no other failing test. This is the only thing pinning it.
    const byName = [...catalog].sort((a, b) => a.name.localeCompare(b.name));
    const filtered = searchTechniques(byName, "guard").map((t) => t.name);
    expect(filtered).toEqual(
      [...filtered].sort((a, b) => a.localeCompare(b)),
    );
    expect(rankTechniques(byName, "guard").map((t) => t.name)).not.toEqual(
      filtered,
    );
  });
});

/**
 * Resolving a cross-reference to a link.
 *
 * The web copy of the resolver, tested here for the same reason the search is:
 * the two apps carry independent copies, and until this file existed a
 * web-only divergence was invisible. Mirrors
 * apps/mobile/lib/__tests__/techniqueGraph.test.ts — a case added there and
 * not here reopens exactly that hole.
 */
describe("buildEdgeIndex / resolveEdge", () => {
  const index = buildEdgeIndex(catalog);

  it("resolves a plain name and an alias", () => {
    expect(resolveEdge(index, "Knee-Cut Pass")?.id).toBe("knee-cut-pass");
    const withAlias = catalog.find((t) => (t.aliases ?? []).length > 0)!;
    expect(resolveEdge(index, withAlias.aliases[0])?.id).toBe(withAlias.id);
  });

  it("resolves across the dash the keyboard produces", () => {
    const dashed = catalog.find((t) => t.name.includes("–"))!;
    expect(resolveEdge(index, dashed.name.replace(/–/g, "-"))?.id).toBe(
      dashed.id,
    );
  });

  it("returns null for prose, which is most of what counters hold", () => {
    // Not a data gap: "Sprawl" and "Hand fight" are reactions, not techniques.
    expect(resolveEdge(index, "Stabilize top position")).toBeNull();
    expect(resolveEdge(index, "Hand fight")).toBeNull();
  });

  it("refuses a self-reference", () => {
    const t = catalog.find((x) => x.id === "knee-cut-pass")!;
    expect(resolveEdge(index, t.name, t.id)).toBeNull();
    expect(resolveEdge(index, t.name, "other")?.id).toBe("knee-cut-pass");
  });

  it("resolves each linked field often enough to justify linking it", () => {
    // The measurement the decision rests on, asserted against the real catalog
    // so a content change that guts it fails rather than quietly making the
    // links pointless. Only `setup_from` had a floor before review; the field
    // doing the most argumentative work — next_moves — had none.
    const rate = (field: "setup_from" | "common_next_moves") => {
      let tot = 0;
      let hit = 0;
      for (const t of catalog) {
        for (const raw of (t as unknown as Record<string, string[]>)[field] ?? []) {
          tot++;
          if (resolveEdge(index, raw, t.id)) hit++;
        }
      }
      return hit / tot;
    };
    // Measured 84% and 31%. Floored below that so ordinary content churn does
    // not fail the build, but high enough that a collapse is visible — and if
    // next_moves ever falls toward the counters' 10%, linking it here stops
    // being defensible, exactly as it already is on the phone.
    expect(rate("setup_from")).toBeGreaterThan(0.7);
    expect(rate("common_next_moves")).toBeGreaterThan(0.22);
  });

  it("prefers a real name over another entry's alias", () => {
    // Fixture, not the catalog — the shipped library has no such collision, so
    // searching it for one asserts nothing. (That version passed with the
    // precedence inverted.)
    const a = { ...catalog[0], id: "real", name: "Contested Name", aliases: [] };
    const b = { ...catalog[1], id: "impostor", name: "Other", aliases: ["Contested Name"] };
    expect(resolveEdge(buildEdgeIndex([a, b]), "Contested Name")?.id).toBe("real");
    expect(resolveEdge(buildEdgeIndex([b, a]), "Contested Name")?.id).toBe("real");
  });
});
