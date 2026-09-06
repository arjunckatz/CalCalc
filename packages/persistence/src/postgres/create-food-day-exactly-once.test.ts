import { createFoodDay } from "@cal-calc/domain";
import { describe, expect, it, vi } from "vitest";

import { toFoodDayRow } from "../mapping.js";
import type { SemanticOperationRow } from "../types.js";
import {
  createFoodDayExactlyOnce,
  CreateFoodDayIntegrityError,
  type CreateFoodDayExactlyOnceInput,
} from "./create-food-day-exactly-once.js";
import type { PostgresExecutor } from "./food-entry-repository.js";
import { SemanticOperationIdempotencyConflictError } from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";

const userId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const foodDayId = "30000000-0000-4000-8000-000000000001";
const operationKey = "start-logical-day";
const fingerprint = "fingerprint-a";
const timestamp = "2026-09-06T00:00:00.000Z";
const resultJson = { kind: "FOOD_DAY_CREATED", foodDayId };

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
    return {
      rows: [...(typeof response === "function" ? response() : response)],
    };
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

describe("createFoodDayExactlyOnce", () => {
  it("claims, creates once, and completes on one executor with post-create application time", async () => {
    const input = workflowInput();
    const completedAt = "2026-09-06T00:00:01.000Z";
    const runner = new ScriptedTransactionRunner([
      [operationRow()],
      () => {
        vi.setSystemTime(completedAt);
        return [foodDayRow(input)];
      },
      [succeededRow(resultJson, completedAt)],
    ]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(timestamp);
    try {
      const result = await createFoodDayExactlyOnce(runner, input);

      expect(result.disposition).toBe("CREATED");
      expect(result.foodDay.foodDay).toEqual(input.foodDay);
      expect(result.foodDay).toMatchObject({
        userId,
        completeness: input.completeness,
        localDate: input.localDate,
        timezone: input.timezone,
      });
      expect(result.operation).toMatchObject({
        id: operationId,
        status: "SUCCEEDED",
        result: resultJson,
        completedAt,
      });
      expect(runner).toMatchObject({ attempts: 1, commits: 1, rollbacks: 0 });
      expect(runner.executor.calls).toHaveLength(3);
      const [claim, creation, completion] = runner.executor.calls;
      expect(normalizeSql(claim?.queryText)).toMatch(
        /^insert into public.semantic_operations /,
      );
      expect(claim?.values).toEqual([
        operationId,
        userId,
        operationKey,
        fingerprint,
      ]);
      expect(normalizeSql(creation?.queryText)).toMatch(
        /^insert into public.food_days /,
      );
      expect(creation?.values).toEqual([
        foodDayId,
        userId,
        "OPEN",
        "PARTIAL",
        "2100.125",
        "120.005",
        "2400.75",
        "goal-version-7",
        "2026-09-05",
        "Asia/Calcutta",
      ]);
      expect(normalizeSql(completion?.queryText)).toMatch(
        /^update public.semantic_operations /,
      );
      expect(completion?.values).toEqual([
        userId,
        operationKey,
        resultJson,
        completedAt,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays the current canonical FoodDay without creating or completing again", async () => {
    const current = foodDayRow(workflowInput());
    const runner = new ScriptedTransactionRunner([
      [],
      [succeededRow()],
      [{ ...current, status: "CLOSED", closed_at: timestamp }],
    ]);

    const result = await createFoodDayExactlyOnce(runner, workflowInput());

    expect(result.disposition).toBe("REPLAYED");
    expect(result.foodDay.foodDay).toEqual({
      ...workflowInput().foodDay,
      status: "CLOSED",
    });
    expect(result.operation.result).toEqual(resultJson);
    expectReplayReads(runner.executor);
    expect(runner).toMatchObject({ attempts: 1, commits: 1, rollbacks: 0 });
  });

  it.each([
    { label: "null", result: null },
    { label: "array", result: [] },
    { label: "wrong kind", result: { ...resultJson, kind: "OTHER" } },
    { label: "missing kind", result: { foodDayId } },
    { label: "missing ID", result: { kind: "FOOD_DAY_CREATED" } },
    { label: "blank ID", result: { ...resultJson, foodDayId: "  " } },
    { label: "non-string ID", result: { ...resultJson, foodDayId: 7 } },
  ])("rejects a malformed succeeded result: $label", async ({ result }) => {
    const runner = new ScriptedTransactionRunner([[], [succeededRow(result)]]);

    const attempt = createFoodDayExactlyOnce(runner, workflowInput());
    await expect(attempt).rejects.toBeInstanceOf(CreateFoodDayIntegrityError);
    await expect(attempt).rejects.toMatchObject({
      operationKey,
      reason: "MALFORMED_OPERATION_RESULT",
    });
    expect(runner.executor.calls).toHaveLength(2);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });

  it("rejects a missing owned replay day without an unscoped fallback", async () => {
    const runner = new ScriptedTransactionRunner([[], [succeededRow()], []]);

    await expect(
      createFoodDayExactlyOnce(runner, workflowInput()),
    ).rejects.toMatchObject({
      name: "CreateFoodDayIntegrityError",
      operationKey,
      reason: "REFERENCED_FOOD_DAY_NOT_FOUND",
    });
    expectReplayReads(runner.executor);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });

  it.each(["PENDING", "FAILED"] as const)(
    "rejects an existing %s operation without creating",
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
        createFoodDayExactlyOnce(runner, workflowInput()),
      ).rejects.toMatchObject({
        name: "SemanticOperationStateConflictError",
        operationKey,
        actualStatus: status,
      });
      expect(runner.executor.calls).toHaveLength(2);
      expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
    },
  );

  it("propagates fingerprint conflict before FoodDay creation", async () => {
    const runner = new ScriptedTransactionRunner([[], [succeededRow()]]);

    await expect(
      createFoodDayExactlyOnce(
        runner,
        workflowInput({ requestFingerprint: "fingerprint-b" }),
      ),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
    expect(runner.executor.calls).toHaveLength(2);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });

  it("propagates create failure so the runner rolls back the new claim", async () => {
    const failure = new Error("FoodDay insert failed.");
    const runner = new ScriptedTransactionRunner([[operationRow()], failure]);

    await expect(
      createFoodDayExactlyOnce(runner, workflowInput()),
    ).rejects.toBe(failure);
    expect(runner.executor.calls).toHaveLength(2);
    expect(runner).toMatchObject({ attempts: 1, commits: 0, rollbacks: 1 });
  });

  it("propagates completion failure so the runner rolls back creation and claim", async () => {
    const failure = new Error("Completion failed.");
    const runner = new ScriptedTransactionRunner([
      [operationRow()],
      [foodDayRow(workflowInput())],
      failure,
    ]);

    await expect(
      createFoodDayExactlyOnce(runner, workflowInput()),
    ).rejects.toBe(failure);
    expect(runner.executor.calls).toHaveLength(3);
    expect(runner).toMatchObject({ attempts: 1, commits: 0, rollbacks: 1 });
  });
});

function workflowInput(
  overrides: Partial<CreateFoodDayExactlyOnceInput> = {},
): CreateFoodDayExactlyOnceInput {
  return {
    userId,
    operationId,
    operationKey,
    requestFingerprint: fingerprint,
    foodDay: createFoodDay({
      id: foodDayId,
      status: "OPEN",
      calorieTarget: "2100.125",
      proteinTarget: "120.005",
      maintenanceSnapshot: "2400.75",
      goalVersionId: "goal-version-7",
    }),
    completeness: "PARTIAL",
    localDate: "2026-09-05",
    timezone: "Asia/Calcutta",
    ...overrides,
  };
}

function foodDayRow(input: CreateFoodDayExactlyOnceInput) {
  return toFoodDayRow(input.foodDay, {
    ...input,
    openedAt: timestamp,
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

function succeededRow(result: unknown = resultJson, completedAt = timestamp) {
  return {
    ...operationRow({ status: "SUCCEEDED", completed_at: completedAt }),
    result,
  };
}

function expectReplayReads(executor: ScriptedExecutor): void {
  expect(executor.calls).toHaveLength(3);
  for (const call of executor.calls.slice(1))
    expect(normalizeSql(call.queryText)).toMatch(/^select /);
  expect(normalizeSql(executor.calls[2]?.queryText)).toContain(
    "where id = $1 and user_id = $2",
  );
  expect(executor.calls[2]?.values).toEqual([foodDayId, userId]);
}

function normalizeSql(queryText: string | undefined): string {
  return queryText?.replaceAll(/\s+/g, " ").trim() ?? "";
}
