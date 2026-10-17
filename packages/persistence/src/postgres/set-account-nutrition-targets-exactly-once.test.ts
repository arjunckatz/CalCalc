import { describe, expect, it } from "vitest";

import type { PostgresExecutor } from "./food-entry-repository.js";
import { AccountNutritionTargetsVersionConflictError } from "./account-nutrition-targets-repository.js";
import { SemanticOperationIdempotencyConflictError } from "./semantic-operation-repository.js";
import {
  setAccountNutritionTargetsExactlyOnce,
  SetAccountNutritionTargetsIntegrityError,
} from "./set-account-nutrition-targets-exactly-once.js";
import type { PostgresTransactionRunner } from "./transaction.js";

const userId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const timestamp = "2026-10-17T00:00:00.000Z";
const input = {
  userId,
  operationId,
  operationKey: "account-targets-key",
  requestFingerprint: "fingerprint-a",
  expectedVersion: null,
  calorieTarget: "685.1075",
  proteinTarget: "41.0025",
};
const targetRow = {
  user_id: userId,
  calorie_target: "685.1075",
  protein_target: "41.0025",
  version: 0,
  created_at: timestamp,
  updated_at: timestamp,
};
const operationResult = {
  kind: "ACCOUNT_NUTRITION_TARGETS_SET",
  calorieTarget: "685.1075",
  proteinTarget: "41.0025",
  version: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};
function operationRow(
  status: "PENDING" | "SUCCEEDED",
  result: unknown = null,
  fingerprint = input.requestFingerprint,
) {
  return {
    id: operationId,
    user_id: userId,
    operation_key: input.operationKey,
    request_fingerprint: fingerprint,
    status,
    result,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: status === "SUCCEEDED" ? timestamp : null,
  };
}

class Runner implements PostgresTransactionRunner, PostgresExecutor {
  readonly calls: { sql: string; values: unknown[] }[] = [];
  commits = 0;
  rollbacks = 0;
  constructor(private readonly responses: readonly (readonly unknown[])[]) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: [...(this.responses[this.calls.length - 1] ?? [])] };
  }
  async runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ): Promise<Value> {
    try {
      const result = await work(this);
      this.commits++;
      return result;
    } catch (error) {
      this.rollbacks++;
      throw error;
    }
  }
}

describe("setAccountNutritionTargetsExactlyOnce", () => {
  it("claims, writes one atomic row, and stores the exact completed snapshot", async () => {
    const runner = new Runner([
      [operationRow("PENDING")],
      [targetRow],
      [operationRow("SUCCEEDED", operationResult)],
    ]);
    const result = await setAccountNutritionTargetsExactlyOnce(runner, input);
    expect(result).toMatchObject({
      disposition: "APPLIED",
      targets: {
        userId,
        calorieTarget: "685.1075",
        proteinTarget: "41.0025",
        version: 0,
      },
    });
    expect(runner).toMatchObject({ commits: 1, rollbacks: 0 });
    expect(runner.calls.map((call) => call.sql.trim().split(/\s+/)[0])).toEqual(
      ["insert", "insert", "update"],
    );
    expect(runner.calls[2]?.values[2]).toEqual(operationResult);
  });

  it("replays the original durable snapshot without reading or rewriting current targets", async () => {
    const runner = new Runner([
      [],
      [operationRow("SUCCEEDED", operationResult)],
    ]);
    const result = await setAccountNutritionTargetsExactlyOnce(runner, input);
    expect(result).toMatchObject({
      disposition: "REPLAYED",
      targets: { version: 0, calorieTarget: "685.1075" },
    });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.sql).toContain("from public.semantic_operations");
    expect(runner).toMatchObject({ commits: 1, rollbacks: 0 });
  });

  it("rejects changed payload on the same key before touching targets", async () => {
    const runner = new Runner([
      [],
      [operationRow("SUCCEEDED", operationResult, "different")],
    ]);
    await expect(
      setAccountNutritionTargetsExactlyOnce(runner, input),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
    expect(runner.calls).toHaveLength(2);
    expect(runner.rollbacks).toBe(1);
  });

  it("rolls back a new claim on losing first-create CAS", async () => {
    const runner = new Runner([[operationRow("PENDING")], []]);
    await expect(
      setAccountNutritionTargetsExactlyOnce(runner, input),
    ).rejects.toBeInstanceOf(AccountNutritionTargetsVersionConflictError);
    expect(runner.calls).toHaveLength(2);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });

  it("rejects an inconsistent persisted successful result", async () => {
    const runner = new Runner([
      [],
      [operationRow("SUCCEEDED", { ...operationResult, calorieTarget: "bad" })],
    ]);
    await expect(
      setAccountNutritionTargetsExactlyOnce(runner, input),
    ).rejects.toBeInstanceOf(SetAccountNutritionTargetsIntegrityError);
    expect(runner.calls).toHaveLength(2);
  });
});
