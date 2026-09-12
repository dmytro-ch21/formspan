import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * N466 — that the curriculum page really wires "read and understood".
 *
 * A source read, like `sessions/__tests__/finishedGripWiring.test.ts`: web's
 * tests run in node with no DOM, so the page cannot render here. The copy and
 * the figure are pinned in `lib/__tests__/conceptRead.test.ts`; what only the
 * source can show is where they are used.
 */
const page = readFileSync(fileURLToPath(new URL("../[id]/page.tsx", import.meta.url)), "utf8");
const api = readFileSync(fileURLToPath(new URL("../../../../lib/api.ts", import.meta.url)), "utf8");

it("actually read the page and the client", () => {
  expect(page).toContain("export default function CurriculumDetailPage");
  expect(api).toContain("export type CurriculumItem");
});

describe("the toggle", () => {
  it("lives only in the concept branch of an item row", () => {
    const conceptBranch = page.indexOf('if (item.kind === "concept") {');
    const branchEnd = page.indexOf("\n  }\n", conceptBranch);
    const toggle = page.indexOf('role="checkbox"');
    expect(conceptBranch).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(conceptBranch);
    expect(toggle).toBeLessThan(branchEnd);
    // Exactly one: a technique row must never grow one.
    expect(page.split('role="checkbox"').length - 1).toBe(1);
  });

  it("unmarks an item already read, marks one that is not, and re-reads the curriculum", () => {
    const handler = page.slice(page.indexOf("const toggleRead = useCallback("), page.indexOf("const applyFocus = useCallback("));
    // The branch itself, not just that both calls appear: swapped, a click on
    // a read concept would mark it again and could never withdraw the claim.
    expect(handler).toContain("if (item.read_at) await unmarkCurriculumItemRead(getToken, c.id, item.id);");
    expect(handler).toContain("else await markCurriculumItemRead(getToken, c.id, item.id);");
    expect(handler).toContain("await load();");
  });

  it("each client helper sends its own method to the read subresource", () => {
    // Sliced per function. A regex from `markCurriculumItemRead` also matches
    // inside `unmarkCurriculumItemRead`, and lazily runs on to the next
    // `method: "PUT"` further down the file, so it passed with the wrong method.
    const body = (name: string) => {
      const start = api.indexOf(`export async function ${name}(`);
      expect(start).toBeGreaterThan(-1);
      return api.slice(start, api.indexOf("\n}\n", start));
    };
    const mark = body("markCurriculumItemRead");
    const unmark = body("unmarkCurriculumItemRead");
    for (const fn of [mark, unmark]) {
      expect(fn).toContain("/items/${itemID}/read`");
    }
    expect(mark).toContain('method: "PUT"');
    expect(mark).not.toContain('method: "DELETE"');
    expect(unmark).toContain('method: "DELETE"');
    expect(unmark).not.toContain('method: "PUT"');
  });
});

describe("the figure", () => {
  it("is its own element, not part of the mastered count", () => {
    expect(page).toContain("const conceptsRead = conceptsReadLine(c);");
    const figure = page.indexOf('data-testid="concepts-read"');
    const mastered = page.indexOf("mastered</span>");
    expect(figure).toBeGreaterThan(-1);
    expect(mastered).toBeGreaterThan(-1);
    // The mastered sentence's own paragraph must not contain the concept figure.
    const masteredParagraph = page.slice(page.lastIndexOf("<p", mastered), page.indexOf("</p>", mastered));
    expect(masteredParagraph).not.toContain("conceptsRead");
  });
});
