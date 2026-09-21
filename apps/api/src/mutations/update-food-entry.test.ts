import {
  createFoodEntry,
  updateFoodEntryQuantity,
  type FoodEntry,
} from "@cal-calc/domain";
import {
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  SemanticOperationIdempotencyConflictError,
  updateFoodEntryExactlyOnce,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveMutationIdentity,
  parseIdempotencyKey,
} from "./mutation-identity.js";
import {
  updateFoodEntryMutation,
  type UpdateFoodEntryCommand,
} from "./update-food-entry.js";

vi.mock("@cal-calc/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cal-calc/persistence")>()),
  updateFoodEntryExactlyOnce: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const entryId = "20000000-0000-4000-8000-000000000001";
const retry = parseIdempotencyKey("quantity-correction");
const command: UpdateFoodEntryCommand = {
  entryId: ` ${entryId} `,
  expectedRevision: 1,
  quantity: { amount: "0250.00", unit: "GRAM" },
  overrideAction: { type: "PRESERVE" },
};
const current = createFoodEntry({
  id: entryId,
  foodDayId: "30000000-0000-4000-8000-000000000001",
  rawUserDescription: "200 g chicken and rice",
  displayName: "Chicken and rice",
  quantity: { amount: "200", unit: "GRAM" },
  nutritionBasis: {
    amount: "100",
    unit: "GRAM",
    nutrition: { calories: "249.13", protein: "14.91" },
  },
  evidenceClass: "EXACT",
  status: "CONFIRMED_CONSUMED",
});
const runner: PostgresTransactionRunner = {
  async runInTransaction() {
    throw new Error("Mock workflow must not execute a transaction.");
  },
};
const workflow = vi.mocked(updateFoodEntryExactlyOnce);
const timestamp = "2026-09-14T00:00:00Z";

beforeEach(() => {
  workflow.mockReset();
  workflow.mockImplementation(async (_runner, input) => applyCreated(input));
});

function applyCreated(
  input: Parameters<typeof updateFoodEntryExactlyOnce>[1],
  canonical: FoodEntry = current,
) {
  // The mock starts after a CREATED claim and loads the canonical owned entry.
  input.validateCurrent?.(canonical);
  if (canonical.revision !== input.expectedRevision) {
    throw new FoodEntryRevisionConflictError(
      input.entryId,
      input.expectedRevision,
      canonical.revision,
    );
  }
  const entry = input.transform(canonical);
  return {
    disposition: "APPLIED",
    entry: {
      entry,
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
      result: {
        kind: "FOOD_ENTRY_UPDATED",
        entryId: input.entryId,
        appliedRevision: entry.revision,
      },
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    },
    appliedRevision: entry.revision,
  } as const;
}

function run(value = command, key = retry) {
  return updateFoodEntryMutation(
    { transactionRunner: runner },
    { trustedUserId: userId, idempotencyKey: key, command: value },
  );
}

describe("updateFoodEntryMutation", () => {
  it("hardcodes UPDATE_FOOD_ENTRY, forwards trusted identity, and applies the domain quantity correction", async () => {
    const result = await run();
    const sent = workflow.mock.calls[0]![1];
    expect(workflow.mock.calls[0]![0]).toBe(runner);
    expect(sent.userId).toBe(userId);
    expect(sent.entryId).toBe(entryId);
    expect(sent.expectedRevision).toBe(1);
    expect(sent.validateCurrent).toBeUndefined();
    expect(sent).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "UPDATE_FOOD_ENTRY",
        idempotencyKey: retry,
        semanticPayload: {
          entryId,
          expectedRevision: 1,
          quantity: { amount: "250", unit: "GRAM" },
          overrideAction: { type: "PRESERVE" },
        },
      }),
    );
    const expected = updateFoodEntryQuantity(current, {
      expectedRevision: 1,
      quantity: { amount: "250", unit: "GRAM" },
      overrideAction: { type: "PRESERVE" },
    });
    if (!expected.ok) throw new Error("Unexpected fixture conflict.");
    expect(result).toEqual({
      disposition: "APPLIED",
      entry: expected.value,
      appliedRevision: 2,
    });
    expect(result.entry).toMatchObject({
      id: entryId,
      revision: 2,
      quantity: { amount: "250", unit: "GRAM" },
      derivedNutrition: { calories: "622.825", protein: "37.275" },
      workingNutrition: { calories: "622.825", protein: "37.275" },
    });
    expect(Object.keys(result).sort()).toEqual([
      "appliedRevision",
      "disposition",
      "entry",
    ]);
    expect(sent.operationId).toMatch(
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
    );
  });

  it("normalizes equivalent quantity and replacement-override decimals before fingerprinting", async () => {
    const replace = {
      ...command,
      overrideAction: {
        type: "REPLACE" as const,
        override: { calories: "620.000", protein: "037.500" },
      },
    };
    await run(replace);
    await run({
      ...replace,
      quantity: { amount: "250", unit: "GRAM" },
      overrideAction: {
        type: "REPLACE",
        override: { calories: "620", protein: "37.5" },
      },
    });
    const a = workflow.mock.calls[0]![1];
    const b = workflow.mock.calls[1]![1];
    expect(b.operationKey).toBe(a.operationKey);
    expect(b.requestFingerprint).toBe(a.requestFingerprint);
    expect(b.operationId).not.toBe(a.operationId);
    expect(b.transform(current)).toMatchObject({
      workingNutritionOverride: { calories: "620", protein: "37.5" },
      workingNutrition: { calories: "620", protein: "37.5" },
    });
  });

  it("binds agent-scoped update identity to the trusted FoodDay and checks the canonical entry", async () => {
    const scopedInput = {
      trustedUserId: userId,
      idempotencyKey: retry,
      operationScope: "FOOD_DAY_TURN_TOOL" as const,
      trustedFoodDayId: current.foodDayId,
      command,
    };
    const applied = await updateFoodEntryMutation(
      { transactionRunner: runner },
      scopedInput,
    );
    const first = workflow.mock.calls[0]![1];
    expect(applied.entry.revision).toBe(2);
    expect(first.validateCurrent).toEqual(expect.any(Function));
    expect(first.operationKey).toMatch(/^calcalc:v1:FOOD_DAY_TURN_TOOL:/);
    expect(first).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "UPDATE_FOOD_ENTRY",
        idempotencyKey: retry,
        operationScope: "FOOD_DAY_TURN_TOOL",
        semanticPayload: {
          entryId,
          expectedRevision: 1,
          quantity: { amount: "250", unit: "GRAM" },
          overrideAction: { type: "PRESERVE" },
          trustedFoodDayId: current.foodDayId,
        },
      }),
    );
    await updateFoodEntryMutation({ transactionRunner: runner }, scopedInput);
    const retrySent = workflow.mock.calls[1]![1];
    expect(retrySent.operationKey).toBe(first.operationKey);
    expect(retrySent.requestFingerprint).toBe(first.requestFingerprint);

    const captureOnlyFailure = new Error("Stop after identity derivation.");
    workflow.mockRejectedValueOnce(captureOnlyFailure);
    await expect(
      updateFoodEntryMutation(
        { transactionRunner: runner },
        { ...scopedInput, trustedFoodDayId: "another-food-day" },
      ),
    ).rejects.toBe(captureOnlyFailure);
    const changedDay = workflow.mock.calls[2]![1];
    expect(changedDay.operationKey).toBe(first.operationKey);
    expect(changedDay.requestFingerprint).not.toBe(first.requestFingerprint);
  });

  it("accepts equivalent UUID casing in trusted FoodDay scope without rewriting fingerprint input", async () => {
    const canonicalDayId = "abcdefab-1234-4000-8000-abcdefabcdef";
    workflow.mockImplementationOnce(async (_runner, input) =>
      applyCreated(input, { ...current, foodDayId: canonicalDayId }),
    );
    const trustedFoodDayId = canonicalDayId.toUpperCase();
    const applied = await updateFoodEntryMutation(
      { transactionRunner: runner },
      {
        trustedUserId: userId,
        idempotencyKey: retry,
        operationScope: "FOOD_DAY_TURN_TOOL",
        trustedFoodDayId,
        command,
      },
    );
    expect(applied.entry.foodDayId).toBe(canonicalDayId);
    expect(workflow.mock.calls[0]![1]).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "UPDATE_FOOD_ENTRY",
        idempotencyKey: retry,
        operationScope: "FOOD_DAY_TURN_TOOL",
        semanticPayload: {
          entryId,
          expectedRevision: 1,
          quantity: { amount: "250", unit: "GRAM" },
          overrideAction: { type: "PRESERVE" },
          trustedFoodDayId,
        },
      }),
    );
  });

  it.each([
    ["current", 1],
    ["stale", 2],
  ] as const)(
    "rejects a cross-FoodDay entry with %s expected revision before revision validation",
    async (_label, revision) => {
      workflow.mockImplementationOnce(async (_runner, input) =>
        applyCreated(input, { ...current, revision }),
      );
      const attempt = updateFoodEntryMutation(
        { transactionRunner: runner },
        {
          trustedUserId: userId,
          idempotencyKey: retry,
          operationScope: "FOOD_DAY_TURN_TOOL",
          trustedFoodDayId: "another-food-day",
          command,
        },
      );
      await expect(attempt).rejects.toBeInstanceOf(FoodEntryNotFoundError);
      await expect(attempt).rejects.toMatchObject({ entryId });
    },
  );

  it("preserves unscoped stale-revision conflicts without a precondition", async () => {
    workflow.mockImplementationOnce(async (_runner, input) =>
      applyCreated(input, { ...current, revision: 2 }),
    );
    await expect(run()).rejects.toMatchObject({
      name: "FoodEntryRevisionConflictError",
      entryId,
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(workflow.mock.calls[0]![1].validateCurrent).toBeUndefined();
  });

  it("rejects an agent-scoped update without a trusted FoodDay before workflow execution", async () => {
    await expect(
      updateFoodEntryMutation(
        { transactionRunner: runner },
        {
          trustedUserId: userId,
          idempotencyKey: retry,
          operationScope: "FOOD_DAY_TURN_TOOL",
          command,
        },
      ),
    ).rejects.toThrow("Invalid trusted FoodDay scope.");
    expect(workflow).not.toHaveBeenCalled();
  });

  it.each([
    ["expectedRevision", { expectedRevision: 2 }],
    ["quantity", { quantity: { amount: "275", unit: "GRAM" } }],
    ["override action", { overrideAction: { type: "CLEAR" } }],
  ] as const)(
    "keeps the retry operation key but changes the fingerprint for changed %s",
    async (_label, patch) => {
      await run();
      const first = workflow.mock.calls[0]![1];
      const failure = new SemanticOperationIdempotencyConflictError(
        first.operationKey,
        first.requestFingerprint,
        "changed",
      );
      workflow.mockRejectedValueOnce(failure);
      await expect(
        run({ ...command, ...patch } as UpdateFoodEntryCommand),
      ).rejects.toBe(failure);
      const changed = workflow.mock.calls[1]![1];
      expect(changed.operationKey).toBe(first.operationKey);
      expect(changed.requestFingerprint).not.toBe(first.requestFingerprint);
    },
  );

  it("delegates normalized replay and returns the authoritative workflow entry", async () => {
    await run();
    const first = workflow.mock.calls[0]![1];
    const authoritative = updateFoodEntryQuantity(current, {
      expectedRevision: 1,
      quantity: { amount: "300", unit: "GRAM" },
      overrideAction: { type: "PRESERVE" },
    });
    if (!authoritative.ok) throw new Error("Unexpected fixture conflict.");
    workflow.mockResolvedValueOnce({
      disposition: "REPLAYED",
      entry: {
        entry: { ...authoritative.value, revision: 3 },
        userId,
        reportedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      operation: {
        id: first.operationId,
        userId,
        operationKey: first.operationKey,
        requestFingerprint: first.requestFingerprint,
        status: "SUCCEEDED",
        result: { kind: "FOOD_ENTRY_UPDATED", entryId, appliedRevision: 2 },
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
      },
      appliedRevision: 2,
    });
    const replay = await run({
      ...command,
      entryId,
      quantity: { amount: "250.0", unit: "GRAM" },
    });
    const second = workflow.mock.calls[1]![1];
    expect(second.operationKey).toBe(first.operationKey);
    expect(second.requestFingerprint).toBe(first.requestFingerprint);
    expect(second.operationId).not.toBe(first.operationId);
    expect(replay).toEqual({
      disposition: "REPLAYED",
      entry: { ...authoritative.value, revision: 3 },
      appliedRevision: 2,
    });
  });

  it("uses a different retry key as new intent with the same fingerprint", async () => {
    await run();
    await run(command, parseIdempotencyKey("new-correction-intent"));
    const a = workflow.mock.calls[0]![1];
    const b = workflow.mock.calls[1]![1];
    expect(b.operationKey).not.toBe(a.operationKey);
    expect(b.requestFingerprint).toBe(a.requestFingerprint);
    expect(b.operationId).not.toBe(a.operationId);
  });

  it("propagates stale revision errors unchanged", async () => {
    const failure = new FoodEntryRevisionConflictError(entryId, 1, 2);
    workflow.mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
  });

  it.each([
    "action",
    "operationScope",
    "trustedFoodDayId",
    "operationKey",
    "requestFingerprint",
    "operationId",
    "userId",
    "ownerId",
    "entry",
    "currentEntry",
    "revision",
    "resultingRevision",
  ])("rejects caller command field %s", async (field) => {
    await expect(run({ ...command, [field]: "caller-value" })).rejects.toThrow(
      "Invalid FoodEntry update command.",
    );
    expect(workflow).not.toHaveBeenCalled();
  });

  it("ignores top-level internal identity and current-state overrides", async () => {
    await updateFoodEntryMutation(
      { transactionRunner: runner },
      {
        trustedUserId: userId,
        idempotencyKey: retry,
        command,
        ...{
          userId: "wrong-user",
          action: "OTHER",
          operationId: "caller-operation",
          operationKey: "caller-key",
          requestFingerprint: "caller-fingerprint",
          currentEntry: { ...current, revision: 99 },
          resultingRevision: 99,
        },
      },
    );
    const sent = workflow.mock.calls[0]![1];
    expect(sent.userId).toBe(userId);
    expect(sent.entryId).toBe(entryId);
    expect(sent.operationId).not.toBe("caller-operation");
    expect(sent.operationKey).toMatch(/^calcalc:v1:UPDATE_FOOD_ENTRY:/);
    expect(sent.requestFingerprint).not.toBe("caller-fingerprint");
  });

  it.each([
    { ...command, entryId: " " },
    { ...command, expectedRevision: 0 },
    { ...command, expectedRevision: 1.5 },
    { ...command, quantity: { amount: 250, unit: "GRAM" } },
    { ...command, quantity: { amount: "0", unit: "GRAM" } },
    { ...command, quantity: { ...command.quantity, secret: "value" } },
    { ...command, overrideAction: { type: "OTHER" } },
    { ...command, overrideAction: { type: "CLEAR", override: {} } },
    { ...command, overrideAction: { type: "REPLACE", override: {} } },
    {
      ...command,
      overrideAction: {
        type: "REPLACE",
        override: { calories: 620 },
      },
    },
  ])(
    "rejects invalid correction input before workflow execution (%#)",
    async (value) => {
      await expect(run(value as UpdateFoodEntryCommand)).rejects.toThrow();
      expect(workflow).not.toHaveBeenCalled();
    },
  );
});
