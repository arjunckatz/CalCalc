import { describe, expect, it } from "vitest";

import { deriveAccountTurnPlanStepKey } from "./account-turn-step-identity.js";

const userId = "10000000-0000-4000-8000-000000000001";
const turnId = "20000000-0000-4000-8000-000000000001";

describe("account turn plan-step identity", () => {
  it("is stable for a turn/ordinal and disjoint across owner, turn, and ordinal", () => {
    const first = deriveAccountTurnPlanStepKey(userId, turnId, 0);
    expect(first).toBe(deriveAccountTurnPlanStepKey(userId, turnId, 0));
    expect(first).toMatch(/^account-plan-step-v1-[0-9a-f]{64}$/);
    expect(first).not.toBe(deriveAccountTurnPlanStepKey(userId, turnId, 1));
    expect(first).not.toBe(
      deriveAccountTurnPlanStepKey(
        userId,
        "20000000-0000-4000-8000-000000000002",
        0,
      ),
    );
    expect(first).not.toBe(
      deriveAccountTurnPlanStepKey(
        "10000000-0000-4000-8000-000000000002",
        turnId,
        0,
      ),
    );
  });

  it("rejects invalid ordinals before deriving an operation identity", () => {
    expect(() => deriveAccountTurnPlanStepKey(userId, turnId, -1)).toThrow();
    expect(() => deriveAccountTurnPlanStepKey(userId, turnId, 8)).toThrow();
  });
});
