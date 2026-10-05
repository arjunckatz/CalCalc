import { describe, expect, it } from "vitest";

import { decisionInstructions, finalizationInstructions } from "./prompts.js";

describe("FoodDay target-progress instructions", () => {
  it.each([
    ["decision", decisionInstructions],
    ["finalization", finalizationInstructions],
  ])("applies the same canonical progress policy during %s", (_, text) => {
    expect(text).toContain("STATE.targetProgress");
    expect(text).toContain("stateBeforeMutations.targetProgress");
    expect(text).toMatch(
      /Do not recalculate progress from targets, totals, entries, or planned food/,
    );
    expect(text).toMatch(/successful completeness tool result if present/);
    expect(text).toMatch(/UNKNOWN or PARTIAL.*logged or confirmed so far/);
    expect(text).toMatch(/USER_DECLARED_COMPLETE.*whole-day target comparison/);
    expect(text).toMatch(/both "0" means exactly at target/);
    expect(text).toMatch(/protein progress values are null.*unknown/);
    expect(text).toMatch(
      /not a calorie deficit, surplus, or maintenance balance/,
    );
    expect(text).toMatch(/Progress alone never establishes completeness/);
    expect(text).toMatch(
      /Answer progress-only questions directly without tools/,
    );
    expect(text).toMatch(/After a food mutation.*pre-mutation intake/);
    expect(text).toMatch(/do not present it as current/);
  });
});
