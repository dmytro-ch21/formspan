import { describe, expect, it } from "vitest";

import { conceptsReadLine, readToggleCopy } from "@/lib/conceptRead";

describe("the concepts-read figure", () => {
  it("counts read concepts against concepts, pluralised", () => {
    expect(conceptsReadLine({ concept_items: 48, read_concepts: 22 })).toBe("22 of 48 concepts read");
    expect(conceptsReadLine({ concept_items: 1, read_concepts: 0 })).toBe("0 of 1 concept read");
  });

  it("is absent when there are no concepts, or the server predates N123", () => {
    expect(conceptsReadLine({ concept_items: 0, read_concepts: 0 })).toBeNull();
    expect(conceptsReadLine({})).toBeNull();
  });

  it("reads missing read counts as zero read, not as no concepts", () => {
    expect(conceptsReadLine({ concept_items: 3 })).toBe("0 of 3 concepts read");
  });
});

describe("the read toggle", () => {
  it("says what the state is, so clicking again reads as withdrawing it", () => {
    expect(readToggleCopy(false).label).toBe("Mark as read and understood");
    expect(readToggleCopy(true).label).toBe("Read and understood");
  });

  it("never presents reading as mastery", () => {
    expect(readToggleCopy(false).title).toMatch(/not evidence of mastery/);
    expect(readToggleCopy(true).label).not.toMatch(/master/i);
    expect(readToggleCopy(false).label).not.toMatch(/master/i);
  });
});
