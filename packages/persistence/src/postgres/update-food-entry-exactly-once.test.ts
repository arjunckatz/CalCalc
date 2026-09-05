import {
  createFoodEntry,
  updateFoodEntryQuantity,
  type FoodEntry,
} from "@cal-calc/domain";
import { describe, expect, it, vi } from "vitest";

import { toFoodEntryRow } from "../mapping.js";
import type { SemanticOperationRow } from "../types.js";
import {
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  type PostgresExecutor,
} from "./food-entry-repository.js";
import { SemanticOperationIdempotencyConflictError } from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";
import {
  updateFoodEntryExactlyOnce,
  type UpdateFoodEntryExactlyOnceInput,
} from "./update-food-entry-exactly-once.js";

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const operationId = "20000000-0000-4000-8000-000000000001";
const operationKey = "correct-evening-meal";
const fingerprint = "fingerprint-a";
const foodDayId = "30000000-0000-4000-8000-000000000001";
const entryId = "40000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-05T00:00:00.000Z";
const successfulResult = {
  kind: "FOOD_ENTRY_UPDATED",
  entryId,
  appliedRevision: 2,
};

interface QueryCall {
  readonly queryText: string;
  readonly values: readonly unknown[];
}

type QueryResponse = readonly unknown[] | Error | (() => readonly unknown[]);

class ScriptedExecutor implements PostgresExecutor {
  readonly calls: QueryCall[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: readonly QueryResponse[]) {}

  async query(queryText: string, values: unknown[] = []) {
    this.calls.push({ queryText, values });
    const response = this.responses[this.responseIndex] ?? [];
    this.responseIndex += 1;
    if (response instanceof Error) throw response;
    const rows = typeof response === "function" ? response() : response;
    return { rows: [...rows] };
  }
}

class ScriptedTransactionRunner implements PostgresTransactionRunner {
  readonly executor: ScriptedExecutor;
  attempts = 0;
  commits = 0;
  rollbacks = 0;

  constructor(responses: readonly QueryResponse[]) {
    this.executor = new ScriptedExecutor(responses);
  }

  async runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ): Promise<Value> {
    this.attempts += 1;
    try {
      const value = await work(this.executor);
      this.commits += 1;
      return value;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }
}

describe("updateFoodEntryExactlyOnce", () => {
  it("claims, updates once, and completes on one executor with a post-update timestamp", async () => {
    const entry = correctedEntry();
    const completedAt = "2026-09-05T00:00:01.000Z";
    const runner = new ScriptedTransactionRunner([
      [operationRow()],
      () => {
        vi.setSystemTime(completedAt);
        return [foodEntryRow(entry)];
      },
      [succeededRow(successfulResult, completedAt)],
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(timestamp);

    try {
      const result = await updateFoodEntryExactlyOnce(runner, workflowInput());

      expect(result.disposition).toBe("APPLIED");
      expect(result.entry.entry).toEqual(entry);
      expect(result.entry.lastOperationId).toBe(operationId);
      expect(result.appliedRevision).toBe(entry.revision);
      expect(result.operation).toMatchObject({
        id: operationId,
        status: "SUCCEEDED",
        result: successfulResult,
        completedAt,
      });
      expect(runner).toMatchObject({ attempts: 1, commits: 1, rollbacks: 0 });
      expect(runner.executor.calls).toHaveLength(3);
      const [claim, update, completion] = runner.executor.calls;
      expect(normalizeSql(claim?.queryText)).toContain(
        "insert into public.semantic_operations",
      );
      expect(claim?.values).toEqual([
        operationId,
        userId,
        operationKey,
        fingerprint,
      ]);
      expect(normalizeSql(update?.queryText)).toContain(
        "update public.food_entries",
      );
      expect(normalizeSql(update?.queryText)).toContain(
        "where id = $1 and user_id = $2 and revision = $22",
      );
      expect(update?.values[19]).toBe(2);
      expect(update?.values[21]).toBe(1);
      expect(update?.values[22]).toBe(operationId);
      expect(normalizeSql(completion?.queryText)).toContain(
        "update public.semantic_operations",
      );
      expect(completion?.values).toEqual([
        userId,
        operationKey,
        successfulResult,
        completedAt,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays a succeeded operation without updating or completing again", async () => {
    const entry = correctedEntry();
    const runner = new ScriptedTransactionRunner([
      [],
      [succeededRow()],
      [foodEntryRow(entry)],
    ]);

    const result = await updateFoodEntryExactlyOnce(runner, workflowInput());

    expect(result.disposition).toBe("REPLAYED");
    expect(result.entry.entry).toEqual(entry);
    expect(result.appliedRevision).toBe(2);
    expect(result.operation.result).toEqual(successfulResult);
    expectReplayReads(runner.executor);
    expect(runner).toMatchObject({ attempts: 1, commits: 1, rollbacks: 0 });
  });

  it("replays the current revision 3 while preserving the operation's applied revision 2", async () => {
    const current = changeQuantity(correctedEntry(), "300");
    const laterOperationId = "20000000-0000-4000-8000-000000000002";
    const runner = new ScriptedTransactionRunner([
      [],
      [succeededRow()],
      [foodEntryRow(current, laterOperationId)],
    ]);

    const result = await updateFoodEntryExactlyOnce(runner, workflowInput());

    expect(result.disposition).toBe("REPLAYED");
    expect(result.entry.entry).toEqual(current);
    expect(result.entry.entry.revision).toBe(3);
    expect(result.entry.lastOperationId).toBe(laterOperationId);
    expect(result.appliedRevision).toBe(2);
    expect(result.operation.result).toEqual(successfulResult);
    expectReplayReads(runner.executor);
  });

  it.each([
    { label: "null", result: null },
    { label: "array", result: [] },
    { label: "wrong kind", result: { ...successfulResult, kind: "OTHER" } },
    { label: "missing kind", result: { entryId, appliedRevision: 2 } },
    {
      label: "missing entry ID",
      result: { kind: "FOOD_ENTRY_UPDATED", appliedRevision: 2 },
    },
    { label: "blank entry ID", result: { ...successfulResult, entryId: "  " } },
    {
      label: "non-string entry ID",
      result: { ...successfulResult, entryId: 7 },
    },
    {
      label: "missing revision",
      result: { kind: "FOOD_ENTRY_UPDATED", entryId },
    },
    {
      label: "string revision",
      result: { ...successfulResult, appliedRevision: "2" },
    },
    {
      label: "fractional revision",
      result: { ...successfulResult, appliedRevision: 2.5 },
    },
    {
      label: "creation revision",
      result: { ...successfulResult, appliedRevision: 1 },
    },
    {
      label: "unsafe revision",
      result: {
        ...successfulResult,
        appliedRevision: Number.MAX_SAFE_INTEGER + 1,
      },
    },
  ])("rejects a malformed succeeded result: $label", async ({ result }) => {
    const runner = new ScriptedTransactionRunner([[], [succeededRow(result)]]);

    await expect(
      updateFoodEntryExactlyOnce(runner, workflowInput()),
    ).rejects.toMatchObject({
      name: "UpdateFoodEntryIntegrityError",
      operationKey,
      reason: "MALFORMED_OPERATION_RESULT",
    });
    expect(runner.executor.calls).toHaveLength(2);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });

  it("rejects a current revision below the operation's applied revision", async () => {
    const runner = new ScriptedTransactionRunner([
      [],
      [succeededRow({ ...successfulResult, appliedRevision: 3 })],
      [foodEntryRow(correctedEntry())],
    ]);

    await expect(
      updateFoodEntryExactlyOnce(runner, workflowInput()),
    ).rejects.toMatchObject({
      name: "UpdateFoodEntryIntegrityError",
      operationKey,
      reason: "CURRENT_REVISION_BELOW_APPLIED",
    });
    expectReplayReads(runner.executor);
  });

  it("rejects a missing owned replay entry without a cross-account lookup", async () => {
    const runner = new ScriptedTransactionRunner([[], [succeededRow()], []]);

    await expect(
      updateFoodEntryExactlyOnce(runner, workflowInput()),
    ).rejects.toMatchObject({
      name: "UpdateFoodEntryIntegrityError",
      operationKey,
      reason: "REFERENCED_ENTRY_NOT_FOUND",
    });
    expectReplayReads(runner.executor);
  });

  it.each(["PENDING", "FAILED"] as const)(
    "rejects an existing %s operation without a FoodEntry mutation",
    async (status) => {
      const runner = new ScriptedTransactionRunner([
        [],
        [
          operationRow({
            status,
            ...(status === "FAILED"
              ? { error: { code: "PREVIOUS_FAILURE" }, completed_at: timestamp }
              : {}),
          }),
        ],
      ]);

      await expect(
        updateFoodEntryExactlyOnce(runner, workflowInput()),
      ).rejects.toMatchObject({
        name: "SemanticOperationStateConflictError",
        operationKey,
        actualStatus: status,
      });
      expect(runner.executor.calls).toHaveLength(2);
      expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
    },
  );

  it("propagates a fingerprint conflict before any FoodEntry update", async () => {
    const runner = new ScriptedTransactionRunner([[], [succeededRow()]]);

    await expect(
      updateFoodEntryExactlyOnce(
        runner,
        workflowInput({ requestFingerprint: "fingerprint-b" }),
      ),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
    expect(runner.executor.calls).toHaveLength(2);
    expect(runner).toMatchObject({ attempts: 1, commits: 0, rollbacks: 1 });
  });

  it("propagates stale-revision conflict out of the transaction callback", async () => {
    const runner = new ScriptedTransactionRunner([
      [operationRow()],
      [],
      [{ revision: 3 }],
    ]);

    const result = updateFoodEntryExactlyOnce(runner, workflowInput());
    await expect(result).rejects.toBeInstanceOf(FoodEntryRevisionConflictError);
    await expect(result).rejects.toMatchObject({
      entryId,
      expectedRevision: 1,
      actualRevision: 3,
    });
    expect(runner.executor.calls).toHaveLength(3);
    expect(runner.executor.calls[2]?.values).toEqual([entryId, userId]);
    expect(normalizeSql(runner.executor.calls[2]?.queryText)).toBe(
      "select revision from public.food_entries where id = $1 and user_id = $2",
    );
    expect(runner).toMatchObject({ attempts: 1, commits: 0, rollbacks: 1 });
  });

  it.each([userId, otherUserId])(
    "propagates missing or invisible entry for user %s without an unscoped lookup",
    async (attemptUserId) => {
      const runner = new ScriptedTransactionRunner([
        [operationRow({ user_id: attemptUserId })],
        [],
        [],
      ]);

      await expect(
        updateFoodEntryExactlyOnce(
          runner,
          workflowInput({ userId: attemptUserId }),
        ),
      ).rejects.toBeInstanceOf(FoodEntryNotFoundError);
      expect(runner.executor.calls).toHaveLength(3);
      expect(runner.executor.calls[1]?.values[1]).toBe(attemptUserId);
      expect(runner.executor.calls[2]?.values).toEqual([
        entryId,
        attemptUserId,
      ]);
      expect(normalizeSql(runner.executor.calls[2]?.queryText)).toBe(
        "select revision from public.food_entries where id = $1 and user_id = $2",
      );
      expect(runner).toMatchObject({ attempts: 1, commits: 0, rollbacks: 1 });
    },
  );

  it("propagates completion failure so the runner rolls back the callback", async () => {
    const failure = new Error("Completion failed.");
    const runner = new ScriptedTransactionRunner([
      [operationRow()],
      [foodEntryRow(correctedEntry())],
      failure,
    ]);

    await expect(
      updateFoodEntryExactlyOnce(runner, workflowInput()),
    ).rejects.toBe(failure);
    expect(runner.executor.calls).toHaveLength(3);
    expect(runner).toMatchObject({ attempts: 1, commits: 0, rollbacks: 1 });
  });
});

function workflowInput(
  overrides: Partial<UpdateFoodEntryExactlyOnceInput> = {},
): UpdateFoodEntryExactlyOnceInput {
  return {
    userId,
    operationId,
    operationKey,
    requestFingerprint: fingerprint,
    expectedRevision: 1,
    entry: correctedEntry(),
    ...overrides,
  };
}

function correctedEntry(): FoodEntry {
  const original = createFoodEntry({
    id: entryId,
    foodDayId,
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
  return changeQuantity(original, "250");
}

function changeQuantity(entry: FoodEntry, amount: string): FoodEntry {
  const result = updateFoodEntryQuantity(entry, {
    expectedRevision: entry.revision,
    quantity: { amount, unit: "GRAM" },
    overrideAction: { type: "PRESERVE" },
  });
  if (!result.ok) throw new Error("Unexpected fixture revision conflict.");
  return result.value;
}

function foodEntryRow(entry: FoodEntry, lastOperationId = operationId) {
  return toFoodEntryRow(entry, {
    userId,
    reportedAt: timestamp,
    lastOperationId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function operationRow(
  overrides: Partial<SemanticOperationRow> = {},
): SemanticOperationRow {
  return {
    id: operationId,
    user_id: userId,
    operation_key: operationKey,
    request_fingerprint: fingerprint,
    status: "PENDING",
    result: null,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
    ...overrides,
  };
}

function succeededRow(
  result: unknown = successfulResult,
  completedAt = timestamp,
) {
  return {
    ...operationRow({ status: "SUCCEEDED", completed_at: completedAt }),
    result,
  };
}

function expectReplayReads(executor: ScriptedExecutor): void {
  expect(executor.calls).toHaveLength(3);
  for (const call of executor.calls.slice(1)) {
    expect(normalizeSql(call.queryText)).toMatch(/^select /);
  }
  expect(normalizeSql(executor.calls[2]?.queryText)).toContain(
    "where id = $1 and user_id = $2",
  );
  expect(executor.calls[2]?.values).toEqual([entryId, userId]);
}

function normalizeSql(queryText: string | undefined): string {
  return queryText?.replaceAll(/\s+/g, " ").trim() ?? "";
}
