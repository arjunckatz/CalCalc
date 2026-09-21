import {
  createFoodEntry,
  DomainValidationError,
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
  removeFoodEntryMutation,
  type RemoveFoodEntryCommand,
} from "./remove-food-entry.js";

vi.mock("@cal-calc/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cal-calc/persistence")>()),
  updateFoodEntryExactlyOnce: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const entryId = "20000000-0000-4000-8000-000000000001";
const key = parseIdempotencyKey("remove-entry");
const command: RemoveFoodEntryCommand = {
  entryId: ` ${entryId} `,
  expectedRevision: 1,
};
const current = createFoodEntry({
  id: entryId,
  foodDayId: "30000000-0000-4000-8000-000000000001",
  rawUserDescription: "Lunch",
  displayName: "Lunch",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "685.1075" },
  },
  evidenceClass: "SOURCED",
  status: "CONFIRMED_CONSUMED",
});
const runner: PostgresTransactionRunner = {
  async runInTransaction() {
    throw new Error("Mock workflow must not execute a transaction.");
  },
};
const workflow = vi.mocked(updateFoodEntryExactlyOnce);
const timestamp = "2026-09-16T00:00:00Z";

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
  return result(input, entry, "APPLIED");
}

function result(
  input: Parameters<typeof updateFoodEntryExactlyOnce>[1],
  entry: FoodEntry,
  disposition: "APPLIED" | "REPLAYED",
) {
  return {
    disposition,
    entry: {
      entry,
      userId: input.userId,
      reportedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    operation: {
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
      status: "SUCCEEDED" as const,
      result: { kind: "FOOD_ENTRY_UPDATED", entryId, appliedRevision: 2 },
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    },
    appliedRevision: 2,
  };
}

function run(value = command, retry = key) {
  return removeFoodEntryMutation(
    { transactionRunner: runner },
    { trustedUserId: userId, idempotencyKey: retry, command: value },
  );
}

describe("removeFoodEntryMutation", () => {
  it("hardcodes REMOVE_FOOD_ENTRY, forwards trusted identity and canonical intent", async () => {
    const removed = await run();
    const sent = workflow.mock.calls[0]![1];
    expect(workflow.mock.calls[0]![0]).toBe(runner);
    expect(sent.userId).toBe(userId);
    expect(sent.entryId).toBe(entryId);
    expect(sent.expectedRevision).toBe(1);
    expect(sent.validateCurrent).toBeUndefined();
    expect(sent).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "REMOVE_FOOD_ENTRY",
        idempotencyKey: key,
        semanticPayload: { entryId, expectedRevision: 1 },
      }),
    );
    expect(sent.operationId).toMatch(
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
    );
    expect(removed.disposition).toBe("APPLIED");
    expect(removed.appliedRevision).toBe(2);
    expect(removed.entry.id).toBe(entryId);
    expect(removed.entry.revision).toBe(2);
    expect(removed.entry.deletedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(removed.entry.deletedAt!))).toBe(false);
    expect(Object.keys(removed).sort()).toEqual([
      "appliedRevision",
      "disposition",
      "entry",
    ]);
  });

  it("uses the workflow-provided canonical entry and generates deletion time only inside the transform", async () => {
    let provided: FoodEntry | undefined;
    workflow.mockImplementationOnce(async (_runner, input) => {
      const canonical = { ...current, displayName: "Authoritative lunch" };
      const applied = applyCreated(input, canonical);
      provided = applied.entry.entry;
      return applied;
    });
    const removed = await run();
    expect(provided).toEqual(removed.entry);
    expect(removed.entry.displayName).toBe("Authoritative lunch");
    expect(current.deletedAt).toBeUndefined();
  });

  it("binds agent-scoped removal identity to the trusted FoodDay and checks the canonical entry", async () => {
    const scopedInput = {
      trustedUserId: userId,
      idempotencyKey: key,
      operationScope: "FOOD_DAY_TURN_TOOL" as const,
      trustedFoodDayId: current.foodDayId,
      command,
    };
    const removed = await removeFoodEntryMutation(
      { transactionRunner: runner },
      scopedInput,
    );
    const first = workflow.mock.calls[0]![1];
    expect(removed.entry.deletedAt).toEqual(expect.any(String));
    expect(first.validateCurrent).toEqual(expect.any(Function));
    expect(first.operationKey).toMatch(/^calcalc:v1:FOOD_DAY_TURN_TOOL:/);
    expect(first).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "REMOVE_FOOD_ENTRY",
        idempotencyKey: key,
        operationScope: "FOOD_DAY_TURN_TOOL",
        semanticPayload: {
          entryId,
          expectedRevision: 1,
          trustedFoodDayId: current.foodDayId,
        },
      }),
    );
    await removeFoodEntryMutation({ transactionRunner: runner }, scopedInput);
    const retrySent = workflow.mock.calls[1]![1];
    expect(retrySent.operationKey).toBe(first.operationKey);
    expect(retrySent.requestFingerprint).toBe(first.requestFingerprint);

    const captureOnlyFailure = new Error("Stop after identity derivation.");
    workflow.mockRejectedValueOnce(captureOnlyFailure);
    await expect(
      removeFoodEntryMutation(
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
    const removed = await removeFoodEntryMutation(
      { transactionRunner: runner },
      {
        trustedUserId: userId,
        idempotencyKey: key,
        operationScope: "FOOD_DAY_TURN_TOOL",
        trustedFoodDayId,
        command,
      },
    );
    expect(removed.entry.foodDayId).toBe(canonicalDayId);
    expect(workflow.mock.calls[0]![1]).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "REMOVE_FOOD_ENTRY",
        idempotencyKey: key,
        operationScope: "FOOD_DAY_TURN_TOOL",
        semanticPayload: { entryId, expectedRevision: 1, trustedFoodDayId },
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
      const attempt = removeFoodEntryMutation(
        { transactionRunner: runner },
        {
          trustedUserId: userId,
          idempotencyKey: key,
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

  it("rejects an agent-scoped removal without a trusted FoodDay before workflow execution", async () => {
    await expect(
      removeFoodEntryMutation(
        { transactionRunner: runner },
        {
          trustedUserId: userId,
          idempotencyKey: key,
          operationScope: "FOOD_DAY_TURN_TOOL",
          command,
        },
      ),
    ).rejects.toThrow("Invalid trusted FoodDay scope.");
    expect(workflow).not.toHaveBeenCalled();
  });

  it("keeps the timestamp and generated operation ID out of retry identity", async () => {
    await run();
    await run({ entryId, expectedRevision: 1 });
    const first = workflow.mock.calls[0]![1];
    const second = workflow.mock.calls[1]![1];
    expect(second.operationKey).toBe(first.operationKey);
    expect(second.requestFingerprint).toBe(first.requestFingerprint);
    expect(second.operationId).not.toBe(first.operationId);
  });

  it("delegates same-key replay without invoking a deletion transform", async () => {
    await run();
    const first = workflow.mock.calls[0]![1];
    const authoritative = { ...current, revision: 3, deletedAt: timestamp };
    workflow.mockImplementationOnce(async (_runner, input) =>
      result(input, authoritative, "REPLAYED"),
    );
    const replay = await run({ entryId, expectedRevision: 1 });
    const second = workflow.mock.calls[1]![1];
    expect(second.operationKey).toBe(first.operationKey);
    expect(second.requestFingerprint).toBe(first.requestFingerprint);
    expect(replay).toEqual({
      disposition: "REPLAYED",
      entry: authoritative,
      appliedRevision: 2,
    });
  });

  it("changes fingerprint for a changed expected revision and propagates conflict", async () => {
    await run();
    const first = workflow.mock.calls[0]![1];
    const conflict = new SemanticOperationIdempotencyConflictError(
      first.operationKey,
      first.requestFingerprint,
      "changed",
    );
    workflow.mockRejectedValueOnce(conflict);
    await expect(run({ entryId, expectedRevision: 2 })).rejects.toBe(conflict);
    const second = workflow.mock.calls[1]![1];
    expect(second.operationKey).toBe(first.operationKey);
    expect(second.requestFingerprint).not.toBe(first.requestFingerprint);
  });

  it("uses a different retry key as new explicit intent", async () => {
    await run();
    await run(command, parseIdempotencyKey("another-removal-intent"));
    const first = workflow.mock.calls[0]![1];
    const second = workflow.mock.calls[1]![1];
    expect(second.operationKey).not.toBe(first.operationKey);
    expect(second.requestFingerprint).toBe(first.requestFingerprint);
  });

  it("propagates stale revision errors unchanged", async () => {
    const stale = new FoodEntryRevisionConflictError(entryId, 1, 2);
    workflow.mockRejectedValueOnce(stale);
    await expect(run()).rejects.toBe(stale);
  });

  it("preserves the domain's already-deleted validation behavior", async () => {
    workflow.mockImplementationOnce(async (_runner, input) => {
      applyCreated(input, { ...current, deletedAt: timestamp });
      throw new Error("Unreachable after domain validation.");
    });
    await expect(run()).rejects.toThrow(DomainValidationError);
  });

  it.each([
    "deletedAt",
    "currentEntry",
    "entry",
    "resultingRevision",
    "revision",
    "action",
    "operationScope",
    "trustedFoodDayId",
    "operationKey",
    "requestFingerprint",
    "operationId",
    "userId",
  ])(
    "rejects caller command field %s before workflow execution",
    async (field) => {
      await expect(
        run({ ...command, [field]: "caller-value" }),
      ).rejects.toThrow("Invalid FoodEntry removal command.");
      expect(workflow).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...command, entryId: " " },
    { ...command, expectedRevision: 0 },
    { ...command, expectedRevision: 1.5 },
    { ...command, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    "rejects an invalid command before workflow execution (%#)",
    async (value) => {
      await expect(run(value)).rejects.toThrow(DomainValidationError);
      expect(workflow).not.toHaveBeenCalled();
    },
  );
});
