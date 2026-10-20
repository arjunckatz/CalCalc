import { describe, expect, it } from "vitest";

import {
  AccountTurnStepIntegrityError,
  validateAccountTurnStepResult,
} from "./account-turn-step-result.js";

const foodDayId = "30000000-0000-4000-8000-000000000001";
const entryId = "40000000-0000-4000-8000-000000000001";
const slot = {
  index: 0,
  action: "UPDATE_FOOD_QUANTITY" as const,
  command: {
    entryId,
    expectedRevision: 3,
    quantity: { amount: "2", unit: "SERVING" },
    overrideAction: { type: "PRESERVE" },
  },
};

describe("durable account step result validation", () => {
  it("binds an applied revision to its immutable entry command", () => {
    const valid = {
      schema: "account-turn-step-result-v1",
      action: slot.action,
      outcome: { entryId, appliedRevision: 4 },
    };
    expect(validateAccountTurnStepResult(valid, slot, foodDayId)).toEqual(
      valid,
    );
    for (const corrupt of [
      { ...valid, outcome: { entryId, appliedRevision: 5 } },
      { ...valid, outcome: { entryId: foodDayId, appliedRevision: 4 } },
      { ...valid, action: "LOG_FOOD" },
      { ...valid, providerCallId: "untrusted" },
    ])
      expect(() =>
        validateAccountTurnStepResult(corrupt, slot, foodDayId),
      ).toThrow(AccountTurnStepIntegrityError);
  });
});
