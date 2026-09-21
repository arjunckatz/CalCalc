import { describe, expect, it } from "vitest";

import { sameUuid } from "./same-uuid.js";

describe("sameUuid", () => {
  const id = "abcdefab-1234-4000-8000-abcdefabcdef";

  it("compares valid UUIDs case-insensitively", () => {
    expect(sameUuid(id, id.toUpperCase())).toBe(true);
    expect(sameUuid(id.toUpperCase(), id)).toBe(true);
    expect(sameUuid(id, id)).toBe(true);
  });

  it("does not equate different UUIDs", () => {
    expect(sameUuid(id, "abcdefab-1234-4000-8000-abcdefabcdee")).toBe(false);
  });

  it("does not normalize malformed or missing identifiers", () => {
    expect(sameUuid(id, ` ${id} `)).toBe(false);
    expect(sameUuid(id, id.replaceAll("-", ""))).toBe(false);
    expect(sameUuid(id, undefined)).toBe(false);
    expect(sameUuid("not-a-uuid", "NOT-A-UUID")).toBe(false);
    // Preserve strict equality for existing non-UUID domain/test identifiers.
    expect(sameUuid("day-a", "day-a")).toBe(true);
  });
});
