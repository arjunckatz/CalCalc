import { createFoodDay, DomainValidationError } from "@cal-calc/domain";
import {
  SemanticOperationIdempotencyConflictError,
  setFoodDayCompletenessExactlyOnce,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveMutationIdentity,
  parseIdempotencyKey,
} from "./mutation-identity.js";
import {
  setFoodDayCompletenessMutation,
  type SetFoodDayCompletenessCommand,
} from "./set-food-day-completeness.js";

vi.mock("@cal-calc/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cal-calc/persistence")>()),
  setFoodDayCompletenessExactlyOnce: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const foodDayId = "20000000-0000-4000-8000-000000000001";
const otherFoodDayId = "20000000-0000-4000-8000-000000000002";
const timestamp = "2026-10-01T00:00:00.000Z";
const key = parseIdempotencyKey("set-completeness");
const command: SetFoodDayCompletenessCommand = {
  expectedCompleteness: "UNKNOWN",
  targetCompleteness: "PARTIAL",
};
const runner: PostgresTransactionRunner = {
  async runInTransaction() {
    throw new Error("Mock workflow must not execute a transaction.");
  },
};
const workflow = vi.mocked(setFoodDayCompletenessExactlyOnce);

beforeEach(() => {
  workflow.mockReset();
  workflow.mockImplementation(async (_runner, input) => ({
    disposition: "APPLIED",
    foodDay: {
      foodDay: createFoodDay({
        id: input.foodDayId,
        status: "OPEN",
        calorieTarget: "2100",
        proteinTarget: "120",
      }),
      userId: input.userId,
      completeness: input.targetCompleteness,
      createdAt: timestamp,
      updatedAt: timestamp,
      openedAt: timestamp,
    },
    operation: {
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
      status: "SUCCEEDED",
      result: {
        kind: "FOOD_DAY_COMPLETENESS_SET",
        foodDayId: input.foodDayId,
        completeness: input.targetCompleteness,
      },
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    },
  }));
});

function run(
  value: SetFoodDayCompletenessCommand = command,
  overrides: Partial<Parameters<typeof setFoodDayCompletenessMutation>[1]> = {},
) {
  return setFoodDayCompletenessMutation(
    { transactionRunner: runner },
    {
      trustedUserId: userId,
      trustedFoodDayId: foodDayId,
      idempotencyKey: key,
      command: value,
      ...overrides,
    },
  );
}

describe("setFoodDayCompletenessMutation", () => {
  it.each([
    ["UNKNOWN", "PARTIAL"],
    ["PARTIAL", "USER_DECLARED_COMPLETE"],
    ["USER_DECLARED_COMPLETE", "PARTIAL"],
  ] as const)(
    "accepts canonical transition %s to %s",
    async (expected, target) => {
      const result = await run({
        expectedCompleteness: expected,
        targetCompleteness: target,
      });
      expect(result).toEqual({
        disposition: "APPLIED",
        foodDayId,
        completeness: target,
      });
      expect(workflow.mock.calls.at(-1)?.[1]).toMatchObject({
        userId,
        foodDayId,
        expectedCompleteness: expected,
        targetCompleteness: target,
      });
    },
  );

  it("hardcodes the action, binds trusted user/day and both command values, and hides operation internals", async () => {
    const result = await run();
    const sent = workflow.mock.calls[0]![1];
    expect(workflow.mock.calls[0]?.[0]).toBe(runner);
    expect(sent).toMatchObject({
      userId,
      foodDayId,
      ...command,
      ...deriveMutationIdentity({
        trustedUserId: userId,
        action: "SET_FOOD_DAY_COMPLETENESS",
        idempotencyKey: key,
        semanticPayload: { foodDayId, ...command },
      }),
    });
    expect(sent.operationId).toMatch(
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
    );
    expect(result).toEqual({
      disposition: "APPLIED",
      foodDayId,
      completeness: "PARTIAL",
    });
    expect(result).not.toHaveProperty("operation");
    expect(result).not.toHaveProperty("userId");
  });

  it("derives replay-equivalent meaning independently of candidate operation IDs", async () => {
    await run();
    workflow.mockImplementationOnce(async (_runner, input) => ({
      ...(await workflow.getMockImplementation()!(_runner, input)),
      disposition: "REPLAYED",
    }));
    const replay = await run();
    const first = workflow.mock.calls[0]![1];
    const second = workflow.mock.calls[1]![1];
    expect(second.operationKey).toBe(first.operationKey);
    expect(second.requestFingerprint).toBe(first.requestFingerprint);
    expect(second.operationId).not.toBe(first.operationId);
    expect(replay).toEqual({
      disposition: "REPLAYED",
      foodDayId,
      completeness: "PARTIAL",
    });
  });

  it.each(["targetCompleteness", "expectedCompleteness"] as const)(
    "changes only fingerprint when %s changes under the same retry key",
    async (field) => {
      await run();
      const first = workflow.mock.calls[0]![1];
      const conflict = new SemanticOperationIdempotencyConflictError(
        first.operationKey,
        first.requestFingerprint,
        "changed",
      );
      workflow.mockRejectedValueOnce(conflict);
      const changed = {
        ...command,
        [field]: "USER_DECLARED_COMPLETE",
      };
      await expect(run(changed)).rejects.toBe(conflict);
      const second = workflow.mock.calls[1]![1];
      expect(second.operationKey).toBe(first.operationKey);
      expect(second.requestFingerprint).not.toBe(first.requestFingerprint);
    },
  );

  it("binds user and FoodDay scope, normalizing UUID letter case only", async () => {
    await run();
    await run(command, { trustedUserId: otherUserId });
    await run(command, { trustedFoodDayId: otherFoodDayId });
    const [first, second, third] = workflow.mock.calls.map((call) => call[1]);
    expect(second?.operationKey).not.toBe(first?.operationKey);
    expect(second?.requestFingerprint).not.toBe(first?.requestFingerprint);
    expect(third?.operationKey).toBe(first?.operationKey);
    expect(third?.requestFingerprint).not.toBe(first?.requestFingerprint);
    await run(command, { trustedFoodDayId: foodDayId.toUpperCase() });
    expect(workflow.mock.calls[3]?.[1].requestFingerprint).toBe(
      first?.requestFingerprint,
    );
  });

  it("forwards a fresh same-value command for workflow validation", async () => {
    await run({
      expectedCompleteness: "PARTIAL",
      targetCompleteness: "PARTIAL",
    });
    expect(workflow).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    {},
    { expectedCompleteness: "UNKNOWN" },
    { ...command, targetCompleteness: "CONSIDERED" },
    { ...command, expectedCompleteness: "partial" },
    { ...command, status: "CLOSED" },
    { ...command, userId: otherUserId },
    { ...command, operationKey: "caller-key" },
    { ...command, revision: 4 },
    Object.defineProperty({ ...command }, "hidden", { value: true }),
  ])(
    "rejects invalid or internal command fields before workflow (%#)",
    async (raw) => {
      await expect(
        run(raw as SetFoodDayCompletenessCommand),
      ).rejects.toBeInstanceOf(DomainValidationError);
      expect(workflow).not.toHaveBeenCalled();
    },
  );

  it.each(["", "not-a-uuid", otherUserId + " "])(
    "rejects invalid trusted FoodDay scope before workflow (%s)",
    async (trustedFoodDayId) => {
      await expect(run(command, { trustedFoodDayId })).rejects.toBeInstanceOf(
        DomainValidationError,
      );
      expect(workflow).not.toHaveBeenCalled();
    },
  );
});
