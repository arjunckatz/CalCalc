import { createFoodEntry, type FoodEntry } from "@cal-calc/domain";
import { describe, expect, it } from "vitest";

import { toFoodEntryRow } from "../mapping.js";
import type { JsonObject, SemanticOperationRow } from "../types.js";
import {
  createFoodEntryExactlyOnce,
  CreateFoodEntryIntegrityError,
  type CreateFoodEntryExactlyOnceInput,
} from "./create-food-entry-exactly-once.js";
import type { PostgresExecutor } from "./food-entry-repository.js";
import { SemanticOperationIdempotencyConflictError } from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";

const userId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const operationKey = "log-evening-meal";
const fingerprint = "fingerprint-a";
const foodDayId = "30000000-0000-4000-8000-000000000001";
const entryId = "40000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-04T00:00:00.000Z";

interface QueryCall {
  readonly queryText: string;
  readonly values: readonly unknown[];
}

class ScriptedExecutor implements PostgresExecutor {
  readonly calls: QueryCall[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: readonly (readonly unknown[])[]) {}

  async query(queryText: string, values: unknown[] = []) {
    this.calls.push({ queryText, values });
    const rows = this.responses[this.responseIndex] ?? [];
    this.responseIndex += 1;
    return { rows: [...rows] };
  }
}

class ScriptedTransactionRunner implements PostgresTransactionRunner {
  readonly executor: ScriptedExecutor;
  attempts = 0;
  commits = 0;
  rollbacks = 0;

  constructor(responses: readonly (readonly unknown[])[]) {
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

describe("createFoodEntryExactlyOnce", () => {
  it("claims, creates, and completes a new operation on one executor", async () => {
    const entry = testEntry();
    const resultJson = { kind: "FOOD_ENTRY_CREATED", entryId };
    const runner = new ScriptedTransactionRunner([
      [operationRow()],
      [foodEntryRow(entry, operationId)],
      [
        operationRow({
          status: "SUCCEEDED",
          result: resultJson,
          completedAt: timestamp,
        }),
      ],
    ]);

    const result = await createFoodEntryExactlyOnce(runner, workflowInput());

    expect(result.disposition).toBe("CREATED");
    expect(result.entry.entry).toEqual(entry);
    expect(result.entry.lastOperationId).toBe(operationId);
    expect(result.operation).toMatchObject({
      id: operationId,
      status: "SUCCEEDED",
      result: resultJson,
    });
    expect(runner).toMatchObject({ attempts: 1, commits: 1, rollbacks: 0 });
    expect(normalizeSql(runner.executor.calls[0]?.queryText)).toContain(
      "insert into public.semantic_operations",
    );
    expect(normalizeSql(runner.executor.calls[1]?.queryText)).toContain(
      "insert into public.food_entries",
    );
    expect(normalizeSql(runner.executor.calls[2]?.queryText)).toContain(
      "update public.semantic_operations",
    );
    expect(runner.executor.calls[1]?.values[23]).toBe(operationId);
    expect(runner.executor.calls[2]?.values[2]).toEqual(resultJson);
    const completionTimestamp = runner.executor.calls[2]?.values[3];
    expect(typeof completionTimestamp).toBe("string");
    expect(new Date(completionTimestamp as string).toISOString()).toBe(
      completionTimestamp,
    );
  });

  it("replays a succeeded operation without creating or completing again", async () => {
    const entry = testEntry();
    const succeeded = operationRow({
      status: "SUCCEEDED",
      result: { kind: "FOOD_ENTRY_CREATED", entryId },
      completedAt: timestamp,
    });
    const runner = new ScriptedTransactionRunner([
      [],
      [succeeded],
      [foodEntryRow(entry, operationId)],
    ]);

    const result = await createFoodEntryExactlyOnce(runner, workflowInput());

    expect(result.disposition).toBe("REPLAYED");
    expect(result.entry.entry.id).toBe(entryId);
    expect(result.operation.status).toBe("SUCCEEDED");
    expect(runner.executor.calls).toHaveLength(3);
    expect(normalizeSql(runner.executor.calls[2]?.queryText)).toContain(
      "where id = $1 and user_id = $2",
    );
    expect(runner.executor.calls[2]?.values).toEqual([entryId, userId]);
    expect(
      runner.executor.calls.some((call) =>
        normalizeSql(call.queryText).includes(
          "insert into public.food_entries",
        ),
      ),
    ).toBe(false);
    expect(
      runner.executor.calls.some((call) =>
        normalizeSql(call.queryText).includes(
          "update public.semantic_operations",
        ),
      ),
    ).toBe(false);
  });

  it("propagates a fingerprint conflict without mutating a FoodEntry", async () => {
    const runner = new ScriptedTransactionRunner([[], [operationRow()]]);

    await expect(
      createFoodEntryExactlyOnce(
        runner,
        workflowInput({ requestFingerprint: "fingerprint-b" }),
      ),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);

    expect(runner.executor.calls).toHaveLength(2);
    expect(runner).toMatchObject({ attempts: 1, commits: 0, rollbacks: 1 });
  });

  it("rejects an existing PENDING operation without a FoodEntry mutation", async () => {
    const runner = new ScriptedTransactionRunner([[], [operationRow()]]);

    await expect(
      createFoodEntryExactlyOnce(runner, workflowInput()),
    ).rejects.toMatchObject({
      name: "SemanticOperationStateConflictError",
      operationKey,
      actualStatus: "PENDING",
    });
    expect(runner.executor.calls).toHaveLength(2);
  });

  it("rejects an existing FAILED operation without a FoodEntry mutation", async () => {
    const runner = new ScriptedTransactionRunner([
      [],
      [
        operationRow({
          status: "FAILED",
          error: { code: "PREVIOUS_FAILURE" },
          completedAt: timestamp,
        }),
      ],
    ]);

    await expect(
      createFoodEntryExactlyOnce(runner, workflowInput()),
    ).rejects.toMatchObject({
      name: "SemanticOperationStateConflictError",
      operationKey,
      actualStatus: "FAILED",
    });
    expect(runner.executor.calls).toHaveLength(2);
  });

  it("rejects a malformed succeeded result without mutating a FoodEntry", async () => {
    const runner = new ScriptedTransactionRunner([
      [],
      [
        operationRow({
          status: "SUCCEEDED",
          result: { kind: "OTHER_WORKFLOW", entryId },
          completedAt: timestamp,
        }),
      ],
    ]);

    await expect(
      createFoodEntryExactlyOnce(runner, workflowInput()),
    ).rejects.toMatchObject({
      name: "CreateFoodEntryIntegrityError",
      operationKey,
      reason: "MALFORMED_OPERATION_RESULT",
    } satisfies Partial<CreateFoodEntryIntegrityError>);
    expect(runner.executor.calls).toHaveLength(2);
  });

  it("rejects a missing owned replay entry without a cross-account lookup", async () => {
    const runner = new ScriptedTransactionRunner([
      [],
      [
        operationRow({
          status: "SUCCEEDED",
          result: { kind: "FOOD_ENTRY_CREATED", entryId },
          completedAt: timestamp,
        }),
      ],
      [],
    ]);

    await expect(
      createFoodEntryExactlyOnce(runner, workflowInput()),
    ).rejects.toMatchObject({
      name: "CreateFoodEntryIntegrityError",
      operationKey,
      reason: "REFERENCED_ENTRY_NOT_FOUND",
    } satisfies Partial<CreateFoodEntryIntegrityError>);
    expect(runner.executor.calls).toHaveLength(3);
    expect(runner.executor.calls[2]?.values).toEqual([entryId, userId]);
  });
});

function workflowInput(
  overrides: Partial<CreateFoodEntryExactlyOnceInput> = {},
): CreateFoodEntryExactlyOnceInput {
  return {
    userId,
    operationId,
    operationKey,
    requestFingerprint: fingerprint,
    entry: testEntry(),
    ...overrides,
  };
}

function testEntry(): FoodEntry {
  return createFoodEntry({
    id: entryId,
    foodDayId,
    rawUserDescription: "275 g label food",
    displayName: "Label food",
    quantity: { amount: "275", unit: "GRAM" },
    nutritionBasis: {
      amount: "100",
      unit: "GRAM",
      nutrition: { calories: "249.13", protein: "14.91" },
    },
    evidenceClass: "EXACT",
    status: "CONFIRMED_CONSUMED",
  });
}

function foodEntryRow(entry: FoodEntry, lastOperationId: string) {
  return toFoodEntryRow(entry, {
    userId,
    reportedAt: timestamp,
    lastOperationId,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function operationRow(
  overrides: Partial<{
    status: "PENDING" | "SUCCEEDED" | "FAILED";
    result: JsonObject;
    error: JsonObject;
    completedAt: string;
  }> = {},
): SemanticOperationRow {
  return {
    id: operationId,
    user_id: userId,
    operation_key: operationKey,
    request_fingerprint: fingerprint,
    status: overrides.status ?? "PENDING",
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: overrides.completedAt ?? null,
  };
}

function normalizeSql(queryText: string | undefined): string {
  return queryText?.replaceAll(/\s+/g, " ").trim() ?? "";
}
