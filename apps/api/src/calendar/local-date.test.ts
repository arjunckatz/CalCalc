import { describe, expect, it } from "vitest";

import { isCanonicalLocalDate, previousCalendarDate } from "./local-date.js";

describe("canonical local calendar dates", () => {
  it.each([
    "2026-10-06",
    "2024-02-29",
    "2000-02-29",
    "0001-01-01",
    "9999-12-31",
  ])("accepts %s", (date) => expect(isCanonicalLocalDate(date)).toBe(true));

  it.each([
    "2026-2-05",
    "2026-02-5",
    "2026-02-30",
    "2026-02-29",
    "2026-04-31",
    "1900-02-29",
    "2100-02-29",
    "2026-13-01",
    "2026-00-01",
    "2026-10-06 ",
    "2026-10-06T00:00:00Z",
    "0000-01-01",
    "0000-12-31",
    "10000-01-01",
    null,
  ])("rejects %j without normalization", (date) => {
    expect(isCanonicalLocalDate(date)).toBe(false);
  });

  it.each([
    ["2026-10-06", "2026-10-05"],
    ["2026-03-01", "2026-02-28"],
    ["2024-03-01", "2024-02-29"],
    ["2026-01-01", "2025-12-31"],
    ["2000-03-01", "2000-02-29"],
    ["1900-03-01", "1900-02-28"],
    ["2100-03-01", "2100-02-28"],
  ])("resolves the prior Gregorian date for %s", (current, expected) => {
    expect(previousCalendarDate(current)).toBe(expected);
  });

  it("does not invent a year zero", () => {
    expect(previousCalendarDate("0001-01-01")).toBeNull();
  });
});
