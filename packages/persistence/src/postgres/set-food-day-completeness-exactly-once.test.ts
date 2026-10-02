import { createFoodDay, DomainValidationError } from "@cal-calc/domain";
import { describe, expect, it } from "vitest";

import { toFoodDayRow } from "../mapping.js";
import type { FoodDayCompleteness, SemanticOperationRow } from "../types.js";
import {
  FoodDayCompletenessConflictError,
  FoodDayNotFoundError,
} from "./food-day-repository.js";
import type { PostgresExecutor } from "./food-entry-repository.js";
import {
  SemanticOperationIdempotencyConflictError,
  SemanticOperationStateConflictError,
} from "./semantic-operation-repository.js";
import {
  setFoodDayCompletenessExactlyOnce,
  SetFoodDayCompletenessIntegrityError,
  type SetFoodDayCompletenessExactlyOnceInput,
} from "./set-food-day-completeness-exactly-once.js";
import type { PostgresTransactionRunner } from "./transaction.js";

const userId = "10000000-0000-4000-8000-000000000001";
const foodDayId = "20000000-0000-4000-8000-000000000001";
const operationId = "30000000-0000-4000-8000-000000000001";
const operationKey = "calcalc:v1:SET_FOOD_DAY_COMPLETENESS:test";
const fingerprint = "fingerprint-a";
const timestamp = "2026-10-01T00:00:00.000Z";
const appliedResult = {
  kind: "FOOD_DAY_COMPLETENESS_SET",
  foodDayId,
  completeness: "PARTIAL",
};
const foodDay = createFoodDay({
  id: foodDayId,
  status: "OPEN",
  calorieTarget: "2100.125",
  proteinTarget: "120.005",
});

type QueryResponse = readonly unknown[] | Error;

class ScriptedExecutor implements PostgresExecutor {
  readonly calls: {
    readonly sql: string;
    readonly values: readonly unknown[];
  }[] = [];
  private next = 0;

  constructor(private readonly responses: readonly QueryResponse[]) {}

  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql: sql.replaceAll(/\s+/g, " ").trim(), values });
    const response = this.responses[this.next++] ?? [];
    if (response instanceof Error) throw response;
    return { rows: [...response] };
  }
}

class ScriptedRunner implements PostgresTransactionRunner {
  readonly executor: ScriptedExecutor;
  commits = 0;
  rollbacks = 0;

  constructor(responses: readonly QueryResponse[]) {
    this.executor = new ScriptedExecutor(responses);
  }

  async runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ): Promise<Value> {
    try {
      const result = await work(this.executor);
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }
}

function input(
  overrides: Partial<SetFoodDayCompletenessExactlyOnceInput> = {},
): SetFoodDayCompletenessExactlyOnceInput {
  return {
    userId,
    foodDayId,
    expectedCompleteness: "UNKNOWN",
    targetCompleteness: "PARTIAL",
    operationId,
    operationKey,
    requestFingerprint: fingerprint,
    ...overrides,
  };
}

function dayRow(completeness: FoodDayCompleteness) {
  return toFoodDayRow(foodDay, {
    userId,
    completeness,
    localDate: "2026-10-01",
    timezone: "UTC",
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

function succeededRow() {
  return operationRow({
    status: "SUCCEEDED",
    result: appliedResult,
    completed_at: timestamp,
  });
}

describe("setFoodDayCompletenessExactlyOnce", () => {
  it("claims, compare-and-sets, and succeeds on one transaction executor", async () => {
    const runner = new ScriptedRunner([
      [operationRow()],
      [dayRow("PARTIAL")],
      [succeededRow()],
    ]);

    const result = await setFoodDayCompletenessExactlyOnce(runner, input());

    expect(result).toMatchObject({
      disposition: "APPLIED",
      foodDay: { foodDay, completeness: "PARTIAL" },
      operation: { status: "SUCCEEDED", result: appliedResult },
    });
    expect(runner).toMatchObject({ commits: 1, rollbacks: 0 });
    expect(runner.executor.calls.map(({ sql }) => sql)).toEqual([
      expect.stringMatching(/^insert into public.semantic_operations /),
      expect.stringMatching(/^update public.food_days set completeness = /),
      expect.stringMatching(/^update public.semantic_operations /),
    ]);
    expect(runner.executor.calls[1]?.values).toEqual([
      foodDayId,
      userId,
      "UNKNOWN",
      "PARTIAL",
    ]);
    expect(runner.executor.calls[2]?.values).toMatchObject([
      userId,
      operationKey,
      appliedResult,
      expect.any(String),
    ]);
  });

  it("replays before stale/no-op validation without writing the day again", async () => {
    const runner = new ScriptedRunner([
      [],
      [succeededRow()],
      [dayRow("PARTIAL")],
    ]);
    const result = await setFoodDayCompletenessExactlyOnce(runner, input());

    expect(result).toMatchObject({
      disposition: "REPLAYED",
      foodDay: { completeness: "PARTIAL" },
    });
    expect(runner.executor.calls.map(({ sql }) => sql)).toEqual([
      expect.stringMatching(/^insert into public.semantic_operations /),
      expect.stringMatching(/^select /),
      expect.stringMatching(/^select /),
    ]);
    expect(runner.executor.calls[2]?.values).toEqual([foodDayId, userId]);
    expect(runner).toMatchObject({ commits: 1, rollbacks: 0 });
  });

  it("rolls back a fresh owned same-value command after claim", async () => {
    const runner = new ScriptedRunner([[operationRow()], [dayRow("UNKNOWN")]]);
    await expect(
      setFoodDayCompletenessExactlyOnce(
        runner,
        input({ targetCompleteness: "UNKNOWN" }),
      ),
    ).rejects.toBeInstanceOf(DomainValidationError);
    expect(runner.executor.calls).toHaveLength(2);
    expect(runner.executor.calls[1]?.sql).toMatch(/^select /);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });

  it("reports stale expected completeness before no-op when the owned value moved", async () => {
    const runner = new ScriptedRunner([[operationRow()], [dayRow("PARTIAL")]]);
    await expect(
      setFoodDayCompletenessExactlyOnce(
        runner,
        input({ targetCompleteness: "UNKNOWN" }),
      ),
    ).rejects.toBeInstanceOf(FoodDayCompletenessConflictError);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });

  it("rolls back a stale CAS and keeps the fallback lookup owner-scoped", async () => {
    const runner = new ScriptedRunner([
      [operationRow()],
      [],
      [dayRow("PARTIAL")],
    ]);
    await expect(
      setFoodDayCompletenessExactlyOnce(runner, input()),
    ).rejects.toBeInstanceOf(FoodDayCompletenessConflictError);
    expect(runner.executor.calls[2]?.sql).toContain(
      "where id = $1 and user_id = $2",
    );
    expect(runner.executor.calls[2]?.values).toEqual([foodDayId, userId]);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });

  it("returns not found for an unowned day without disclosing its value", async () => {
    const runner = new ScriptedRunner([[operationRow()], [], []]);
    await expect(
      setFoodDayCompletenessExactlyOnce(runner, input()),
    ).rejects.toBeInstanceOf(FoodDayNotFoundError);
    expect(runner.executor.calls[2]?.values).toEqual([foodDayId, userId]);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });

  it("rejects changed-fingerprint reuse before inspecting FoodDay state", async () => {
    const runner = new ScriptedRunner([[], [succeededRow()]]);
    await expect(
      setFoodDayCompletenessExactlyOnce(
        runner,
        input({ requestFingerprint: "changed" }),
      ),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
    expect(runner.executor.calls).toHaveLength(2);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });

  it("rejects non-succeeded or malformed existing outcomes without writes", async () => {
    for (const existing of [
      operationRow(),
      operationRow({ status: "SUCCEEDED", result: { kind: "OTHER" } }),
    ]) {
      const runner = new ScriptedRunner([[], [existing]]);
      await expect(
        setFoodDayCompletenessExactlyOnce(runner, input()),
      ).rejects.toBeInstanceOf(
        existing.status === "PENDING"
          ? SemanticOperationStateConflictError
          : SetFoodDayCompletenessIntegrityError,
      );
      expect(runner.executor.calls).toHaveLength(2);
      expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
    }
  });

  it("rolls back both CAS and claim when operation completion fails", async () => {
    const failure = new Error("Completion failed.");
    const runner = new ScriptedRunner([
      [operationRow()],
      [dayRow("PARTIAL")],
      failure,
    ]);
    await expect(
      setFoodDayCompletenessExactlyOnce(runner, input()),
    ).rejects.toBe(failure);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });
});
