import { describe, expect, it } from "vitest";

import { createAccountTurnPlanFromToolCalls } from "./account-turn-plan.js";

describe("account turn plan application boundary", () => {
  it("persists only normalized, ordered commands parsed by the existing tool boundary", () => {
    expect(
      createAccountTurnPlanFromToolCalls([
        { name: "GET_BODY_WEIGHT_HISTORY", arguments: {} },
        {
          name: "SET_FOOD_DAY_COMPLETENESS",
          arguments: { targetCompleteness: "PARTIAL" },
        },
      ]),
    ).toEqual({
      schema: "account-turn-plan-v1",
      slots: [
        { index: 0, action: "GET_BODY_WEIGHT_HISTORY", command: {} },
        {
          index: 1,
          action: "SET_FOOD_DAY_COMPLETENESS",
          command: { targetCompleteness: "PARTIAL" },
        },
      ],
    });
  });

  it("rejects unvalidated provider data before it reaches storage", () => {
    expect(() =>
      createAccountTurnPlanFromToolCalls([
        { name: "GET_BODY_WEIGHT_HISTORY", arguments: { userId: "other" } },
      ]),
    ).toThrow();
    expect(() => createAccountTurnPlanFromToolCalls([])).toThrow();
  });
});
