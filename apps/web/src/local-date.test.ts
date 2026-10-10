import { describe, expect, it } from "@jest/globals";
import { browserLocalDate } from "./local-date";

describe("browserLocalDate", () => {
  it("formats browser-local calendar components, not the UTC ISO date", () => {
    const date = {
      getFullYear: () => 2026,
      getMonth: () => 0,
      getDate: () => 1,
      toISOString: () => "2025-12-31T20:00:00.000Z",
    } as Date;
    expect(browserLocalDate(date)).toBe("2026-01-01");
  });

  it("zero-pads local month and day", () => {
    expect(browserLocalDate(new Date(2026, 9, 3, 12))).toBe("2026-10-03");
  });
});
