import {
  createFoodEntryExactlyOnce,
  SemanticOperationIdempotencyConflictError,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFoodEntryMutation,
  type CreateFoodEntryCommand,
} from "./create-food-entry.js";
import {
  deriveMutationIdentity,
  parseIdempotencyKey,
} from "./mutation-identity.js";

vi.mock("@cal-calc/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cal-calc/persistence")>()),
  createFoodEntryExactlyOnce: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const retry = parseIdempotencyKey("entry-retry");
const command: CreateFoodEntryCommand = {
  foodDayId: "20000000-0000-4000-8000-000000000001",
  rawUserDescription: " Had lunch ",
  displayName: " Lunch ",
  quantity: { amount: "1.00", unit: "SERVING" },
  nutritionBasis: {
    amount: "01.0",
    unit: "SERVING",
    nutrition: {
      calories: "685.107500",
      protein: "41.00250",
      carbs: "249.130",
      fat: "0.100",
    },
  },
  evidenceClass: "SOURCED",
};
const runner: PostgresTransactionRunner = {
  async runInTransaction() {
    throw new Error("Mock workflow must not execute DB work.");
  },
};
const workflow = vi.mocked(createFoodEntryExactlyOnce);
const timestamp = "2026-09-11T00:00:00Z";

beforeEach(() => {
  workflow.mockReset();
  workflow.mockImplementation(async (_runner, input) => ({
    disposition: "CREATED",
    entry: {
      entry: input.entry,
      userId: input.userId,
      lastOperationId: input.operationId,
      reportedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    operation: {
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
      status: "SUCCEEDED",
      result: { kind: "FOOD_ENTRY_CREATED", entryId: input.entry.id },
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    },
  }));
});

function run(value = command, key = retry) {
  return createFoodEntryMutation(
    { transactionRunner: runner },
    {
      trustedUserId: userId,
      idempotencyKey: key,
      command: value,
    },
  );
}

describe("createFoodEntryMutation", () => {
  it("uses the trusted owner, fixed action/status, normalized meaning and canonical workflow result", async () => {
    const result = await run();
    const sent = workflow.mock.calls[0]![1];
    expect(workflow.mock.calls[0]![0]).toBe(runner);
    expect(sent.userId).toBe(userId);
    expect(sent).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "CREATE_FOOD_ENTRY",
        idempotencyKey: retry,
        semanticPayload: {
          foodDayId: command.foodDayId,
          rawUserDescription: "Had lunch",
          displayName: "Lunch",
          quantity: { amount: "1", unit: "SERVING" },
          nutritionBasis: {
            amount: "1",
            unit: "SERVING",
            nutrition: {
              calories: "685.1075",
              protein: "41.0025",
              carbs: "249.13",
              fat: "0.1",
            },
          },
          evidenceClass: "SOURCED",
          status: "CONFIRMED_CONSUMED",
        },
      }),
    );
    expect(sent.entry.revision).toBe(1);
    expect(sent.entry.workingNutrition).toEqual({
      calories: "685.1075",
      protein: "41.0025",
      carbs: "249.13",
      fat: "0.1",
    });
    expect(sent.entry.derivedNutrition).toEqual(sent.entry.workingNutrition);
    expect(sent.entry.workingNutrition).not.toHaveProperty("fibre");
    expect(result).toEqual({ disposition: "CREATED", entry: sent.entry });
    expect(result.entry).toBe(
      (await workflow.mock.results[0]!.value).entry.entry,
    );
    expect(Object.keys(result).sort()).toEqual(["disposition", "entry"]);
    for (const id of [sent.operationId, sent.entry.id])
      expect(id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    expect(sent.operationId).not.toBe(sent.entry.id);
    expect(sent).not.toHaveProperty("completedAt");
    expect(sent).not.toHaveProperty("consumedAt");
  });

  it("keeps normalized retry identity independent of generated IDs and returns the workflow replay", async () => {
    const first = await run();
    const stored = await workflow.mock.results[0]!.value;
    workflow.mockResolvedValueOnce({ ...stored, disposition: "REPLAYED" });
    const replay = await run({
      ...command,
      rawUserDescription: "Had lunch",
      displayName: "Lunch",
      quantity: { amount: "1", unit: "SERVING" },
      nutritionBasis: {
        amount: "1",
        unit: "SERVING",
        nutrition: {
          calories: "685.1075",
          protein: "41.0025",
          carbs: "249.13",
          fat: "0.1",
        },
      },
    });
    const a = workflow.mock.calls[0]![1];
    const b = workflow.mock.calls[1]![1];
    expect(b.operationKey).toBe(a.operationKey);
    expect(b.requestFingerprint).toBe(a.requestFingerprint);
    expect(b.operationId).not.toBe(a.operationId);
    expect(b.entry.id).not.toBe(a.entry.id);
    expect(replay).toEqual({ disposition: "REPLAYED", entry: first.entry });
  });

  it("passes changed semantics as the same operation key with a different fingerprint and propagates conflict", async () => {
    await run();
    const a = workflow.mock.calls[0]![1];
    const failure = new SemanticOperationIdempotencyConflictError(
      a.operationKey,
      a.requestFingerprint,
      "changed",
    );
    workflow.mockRejectedValueOnce(failure);
    await expect(
      run({ ...command, quantity: { amount: "2", unit: "SERVING" } }),
    ).rejects.toBe(failure);
    const b = workflow.mock.calls[1]![1];
    expect(b.operationKey).toBe(a.operationKey);
    expect(b.requestFingerprint).not.toBe(a.requestFingerprint);
  });

  it("uses a different retry key as new intent without changing semantic meaning", async () => {
    await run();
    await run(command, parseIdempotencyKey("another-intent"));
    const a = workflow.mock.calls[0]![1];
    const b = workflow.mock.calls[1]![1];
    expect(b.operationKey).not.toBe(a.operationKey);
    expect(b.requestFingerprint).toBe(a.requestFingerprint);
    expect(b.entry.id).not.toBe(a.entry.id);
  });

  it.each([
    "action",
    "operationKey",
    "requestFingerprint",
    "operationId",
    "id",
    "revision",
    "userId",
    "ownerId",
    "status",
    "workingNutrition",
    "createdAt",
  ])("rejects caller command field %s before persistence", async (field) => {
    await expect(run({ ...command, [field]: "caller-value" })).rejects.toThrow(
      "Invalid FoodEntry creation command.",
    );
    expect(workflow).not.toHaveBeenCalled();
  });

  it("does not forward top-level identity overrides", async () => {
    await createFoodEntryMutation(
      { transactionRunner: runner },
      {
        trustedUserId: userId,
        idempotencyKey: retry,
        command,
        ...{
          userId: "wrong-user",
          ownerId: "wrong-user",
          action: "OTHER",
          operationKey: "caller-key",
          requestFingerprint: "caller-fp",
          operationId: "caller-id",
          id: "caller-id",
          revision: 99,
        },
      },
    );
    const sent = workflow.mock.calls[0]![1];
    expect(sent.userId).toBe(userId);
    expect(sent.operationKey).toMatch(/^calcalc:v1:CREATE_FOOD_ENTRY:/);
    expect(sent.requestFingerprint).not.toBe("caller-fp");
    expect(sent.operationId).not.toBe("caller-id");
    expect(sent.entry.id).not.toBe("caller-id");
    expect(sent.entry.revision).toBe(1);
  });

  it.each([
    { ...command, quantity: { amount: 1, unit: "SERVING" } },
    { ...command, quantity: { amount: "0", unit: "SERVING" } },
    { ...command, quantity: { amount: "1", unit: "GRAM" } },
    { ...command, quantity: { ...command.quantity, userId: "wrong" } },
    {
      ...command,
      nutritionBasis: {
        ...command.nutritionBasis,
        nutrition: { calories: 685.1075 },
      },
    },
    { ...command, evidenceClass: "INVENTED" },
    { ...command, displayName: " " },
  ])("rejects invalid domain inputs before persistence (%#)", async (value) => {
    await expect(run(value as CreateFoodEntryCommand)).rejects.toThrow();
    expect(workflow).not.toHaveBeenCalled();
  });
});
