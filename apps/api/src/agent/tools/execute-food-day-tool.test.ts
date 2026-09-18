import { createFoodEntry, DomainValidationError } from "@cal-calc/domain";
import type { PostgresTransactionRunner } from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFoodEntryMutation } from "../../mutations/create-food-entry.js";
import { parseIdempotencyKey } from "../../mutations/mutation-identity.js";
import { removeFoodEntryMutation } from "../../mutations/remove-food-entry.js";
import { updateFoodEntryMutation } from "../../mutations/update-food-entry.js";
import { ToolValidationError } from "./food-day-tools.js";
import { executeFoodDayTool } from "./execute-food-day-tool.js";

vi.mock("../../mutations/create-food-entry.js", () => ({
  createFoodEntryMutation: vi.fn(),
}));
vi.mock("../../mutations/update-food-entry.js", () => ({
  updateFoodEntryMutation: vi.fn(),
}));
vi.mock("../../mutations/remove-food-entry.js", () => ({
  removeFoodEntryMutation: vi.fn(),
}));

const createMutation = vi.mocked(createFoodEntryMutation);
const updateMutation = vi.mocked(updateFoodEntryMutation);
const removeMutation = vi.mocked(removeFoodEntryMutation);
const trustedContext = {
  trustedUserId: "10000000-0000-4000-8000-000000000001",
  foodDayId: "20000000-0000-4000-8000-000000000001",
  idempotencyKey: parseIdempotencyKey("trusted-retry-key"),
};
const runner: PostgresTransactionRunner = {
  async runInTransaction() {
    throw new Error("The mocked mutation should own transaction execution.");
  },
};
const dependencies = { transactionRunner: runner };
const entry = createFoodEntry({
  id: "30000000-0000-4000-8000-000000000001",
  foodDayId: trustedContext.foodDayId,
  rawUserDescription: "Lunch",
  displayName: "Lunch",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "685.1075", protein: "41.0025" },
  },
  evidenceClass: "EXACT",
  status: "CONFIRMED_CONSUMED",
});
const logCall = {
  name: "LOG_FOOD",
  arguments: {
    rawUserDescription: " Lunch ",
    displayName: " Lunch ",
    quantity: { amount: "01.00", unit: "SERVING" },
    nutritionBasis: {
      amount: "1.0",
      unit: "SERVING",
      nutrition: { calories: "685.107500", protein: "41.00250" },
    },
    evidenceClass: "EXACT",
  },
};
const updateCall = {
  name: "UPDATE_FOOD_QUANTITY",
  arguments: {
    entryId: entry.id,
    expectedRevision: 1,
    quantity: { amount: "2.00", unit: "SERVING" },
    overrideAction: { type: "PRESERVE" },
  },
};
const removeCall = {
  name: "REMOVE_FOOD",
  arguments: { entryId: entry.id, expectedRevision: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeFoodDayTool", () => {
  it("validates LOG_FOOD and injects trusted user, day, retry identity, and operation scope", async () => {
    const authoritative = { disposition: "CREATED" as const, entry };
    createMutation.mockResolvedValueOnce(authoritative);

    const output = await executeFoodDayTool(
      dependencies,
      trustedContext,
      logCall,
    );

    expect(createMutation).toHaveBeenCalledExactlyOnceWith(dependencies, {
      trustedUserId: trustedContext.trustedUserId,
      idempotencyKey: trustedContext.idempotencyKey,
      operationScope: "FOOD_DAY_TURN_TOOL",
      command: {
        foodDayId: trustedContext.foodDayId,
        rawUserDescription: "Lunch",
        displayName: "Lunch",
        quantity: { amount: "1", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "685.1075", protein: "41.0025" },
        },
        evidenceClass: "EXACT",
      },
    });
    expect(output).toEqual({ name: "LOG_FOOD", result: authoritative });
    expect(output.result).toBe(authoritative);
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
    expect(updateMutation).not.toHaveBeenCalled();
    expect(removeMutation).not.toHaveBeenCalled();
  });

  it("delegates quantity correction with trusted day scope and validated override", async () => {
    const authoritative = {
      disposition: "APPLIED" as const,
      entry: { ...entry, revision: 2 },
      appliedRevision: 2,
    };
    updateMutation.mockResolvedValueOnce(authoritative);

    const output = await executeFoodDayTool(
      dependencies,
      trustedContext,
      updateCall,
    );

    expect(updateMutation).toHaveBeenCalledExactlyOnceWith(dependencies, {
      trustedUserId: trustedContext.trustedUserId,
      idempotencyKey: trustedContext.idempotencyKey,
      operationScope: "FOOD_DAY_TURN_TOOL",
      trustedFoodDayId: trustedContext.foodDayId,
      command: {
        entryId: entry.id,
        expectedRevision: 1,
        quantity: { amount: "2", unit: "SERVING" },
        overrideAction: { type: "PRESERVE" },
      },
    });
    expect(output).toEqual({
      name: "UPDATE_FOOD_QUANTITY",
      result: authoritative,
    });
    expect(output.result).toBe(authoritative);
    expect(createMutation).not.toHaveBeenCalled();
    expect(removeMutation).not.toHaveBeenCalled();
  });

  it("delegates removal with trusted day scope without generating deletedAt", async () => {
    const authoritative = {
      disposition: "REPLAYED" as const,
      entry: { ...entry, revision: 2, deletedAt: "2026-09-18T00:00:00Z" },
      appliedRevision: 2,
    };
    removeMutation.mockResolvedValueOnce(authoritative);

    const output = await executeFoodDayTool(
      dependencies,
      trustedContext,
      removeCall,
    );

    expect(removeMutation).toHaveBeenCalledExactlyOnceWith(dependencies, {
      trustedUserId: trustedContext.trustedUserId,
      idempotencyKey: trustedContext.idempotencyKey,
      operationScope: "FOOD_DAY_TURN_TOOL",
      trustedFoodDayId: trustedContext.foodDayId,
      command: { entryId: entry.id, expectedRevision: 1 },
    });
    expect(output).toEqual({ name: "REMOVE_FOOD", result: authoritative });
    expect(output.result).toBe(authoritative);
    expect(createMutation).not.toHaveBeenCalled();
    expect(updateMutation).not.toHaveBeenCalled();
  });

  it.each([
    {
      ...logCall,
      arguments: { ...logCall.arguments, foodDayId: "attacker-day" },
    },
    {
      ...removeCall,
      arguments: { ...removeCall.arguments, deletedAt: "2026-09-18" },
    },
    {
      ...updateCall,
      arguments: { ...updateCall.arguments, trustedUserId: "attacker" },
    },
    { ...removeCall, idempotencyKey: "attacker-retry" },
    { ...logCall, operationScope: "FOOD_DAY_TURN_TOOL" },
    {
      ...logCall,
      arguments: { ...logCall.arguments, operationScope: "FOOD_DAY_TURN_TOOL" },
    },
    {
      ...updateCall,
      arguments: {
        ...updateCall.arguments,
        operationScope: "FOOD_DAY_TURN_TOOL",
      },
    },
    {
      ...removeCall,
      arguments: {
        ...removeCall.arguments,
        operationScope: "FOOD_DAY_TURN_TOOL",
      },
    },
    { ...updateCall, trustedFoodDayId: trustedContext.foodDayId },
    {
      ...updateCall,
      arguments: {
        ...updateCall.arguments,
        trustedFoodDayId: trustedContext.foodDayId,
      },
    },
    {
      ...removeCall,
      arguments: {
        ...removeCall.arguments,
        trustedFoodDayId: trustedContext.foodDayId,
      },
    },
  ])(
    "rejects model-supplied trusted/internal fields before mutation",
    async (call) => {
      await expect(
        executeFoodDayTool(dependencies, trustedContext, call),
      ).rejects.toBeInstanceOf(ToolValidationError);
      expect(createMutation).not.toHaveBeenCalled();
      expect(updateMutation).not.toHaveBeenCalled();
      expect(removeMutation).not.toHaveBeenCalled();
    },
  );

  it("propagates an existing typed application error unchanged", async () => {
    const error = new DomainValidationError("Invalid canonical correction.");
    updateMutation.mockRejectedValueOnce(error);

    await expect(
      executeFoodDayTool(dependencies, trustedContext, updateCall),
    ).rejects.toBe(error);
  });
});
