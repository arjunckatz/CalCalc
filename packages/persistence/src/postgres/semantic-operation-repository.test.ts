import { describe, expect, it } from "vitest";

import type { SemanticOperationRow } from "../types.js";
import type { PostgresExecutor } from "./food-entry-repository.js";
import {
  PostgresSemanticOperationRepository,
  SemanticOperationIdempotencyConflictError,
  SemanticOperationNotFoundError,
  SemanticOperationStateConflictError,
} from "./semantic-operation-repository.js";

const operationId = "30000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const operationKey = "log-evening-meal";
const fingerprint = "fingerprint-a";
const timestamp = "2026-09-03T00:00:00.000Z";

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

describe("PostgresSemanticOperationRepository", () => {
  it("atomically claims a new PENDING operation", async () => {
    const row = operationRow();
    const executor = new ScriptedExecutor([[row]]);
    const repository = new PostgresSemanticOperationRepository(executor);

    const claim = await repository.claim(claimInput());

    expect(claim).toEqual({
      disposition: "CREATED",
      operation: persistedOperation(row),
    });
    const call = executor.calls[0];
    expect(normalizeSql(call?.queryText)).toContain(
      "on conflict (user_id, operation_key) do nothing",
    );
    expect(call?.values).toEqual([
      operationId,
      userId,
      operationKey,
      fingerprint,
    ]);
  });

  it("returns an existing operation for the same fingerprint", async () => {
    const row = operationRow({
      status: "SUCCEEDED",
      result: { entryId: "1" },
      completedAt: timestamp,
    });
    const executor = new ScriptedExecutor([[], [row]]);
    const repository = new PostgresSemanticOperationRepository(executor);

    const claim = await repository.claim(claimInput());

    expect(claim.disposition).toBe("EXISTING");
    expect(claim.operation).toEqual(persistedOperation(row));
    expect(normalizeSql(executor.calls[1]?.queryText)).toContain(
      "where user_id = $1 and operation_key = $2",
    );
    expect(executor.calls[1]?.values).toEqual([userId, operationKey]);
  });

  it("rejects reuse of a key with a different fingerprint", async () => {
    const executor = new ScriptedExecutor([[], [operationRow()]]);
    const repository = new PostgresSemanticOperationRepository(executor);

    await expect(
      repository.claim(claimInput({ requestFingerprint: "fingerprint-b" })),
    ).rejects.toMatchObject({
      name: "SemanticOperationIdempotencyConflictError",
      operationKey,
      existingFingerprint: fingerprint,
      suppliedFingerprint: "fingerprint-b",
    } satisfies Partial<SemanticOperationIdempotencyConflictError>);
  });

  it("finds by user and operation key and hides missing or wrong-user state", async () => {
    const row = operationRow();
    const executor = new ScriptedExecutor([[row], []]);
    const repository = new PostgresSemanticOperationRepository(executor);

    expect(await repository.findByKey(userId, operationKey)).toEqual(
      persistedOperation(row),
    );
    expect(await repository.findByKey(otherUserId, operationKey)).toBeNull();
    for (const call of executor.calls) {
      expect(normalizeSql(call.queryText)).toContain(
        "where user_id = $1 and operation_key = $2",
      );
    }
    expect(executor.calls[1]?.values).toEqual([otherUserId, operationKey]);
  });

  it("marks an owned PENDING operation SUCCEEDED", async () => {
    const row = operationRow({
      status: "SUCCEEDED",
      result: { entryId: "entry-1" },
      completedAt: timestamp,
    });
    const executor = new ScriptedExecutor([[row]]);
    const repository = new PostgresSemanticOperationRepository(executor);

    const completed = await repository.markSucceeded({
      userId,
      operationKey,
      result: { entryId: "entry-1" },
      completedAt: timestamp,
    });

    expect(completed).toEqual(persistedOperation(row));
    expect(normalizeSql(executor.calls[0]?.queryText)).toContain(
      "where user_id = $1 and operation_key = $2 and status = 'PENDING'",
    );
    expect(executor.calls[0]?.values).toEqual([
      userId,
      operationKey,
      { entryId: "entry-1" },
      timestamp,
    ]);
  });

  it("marks an owned PENDING operation FAILED", async () => {
    const row = operationRow({
      status: "FAILED",
      error: { code: "ESTIMATE_FAILED" },
      completedAt: timestamp,
    });
    const executor = new ScriptedExecutor([[row]]);
    const repository = new PostgresSemanticOperationRepository(executor);

    const completed = await repository.markFailed({
      userId,
      operationKey,
      error: { code: "ESTIMATE_FAILED" },
      completedAt: timestamp,
    });

    expect(completed).toEqual(persistedOperation(row));
    expect(normalizeSql(executor.calls[0]?.queryText)).toContain(
      "where user_id = $1 and operation_key = $2 and status = 'PENDING'",
    );
  });

  it("reports terminal completion attempts as state conflicts", async () => {
    const terminal = operationRow({
      status: "SUCCEEDED",
      result: { entryId: "entry-1" },
      completedAt: timestamp,
    });
    const executor = new ScriptedExecutor([[], [terminal]]);
    const repository = new PostgresSemanticOperationRepository(executor);

    await expect(
      repository.markFailed({
        userId,
        operationKey,
        error: { code: "LATE_FAILURE" },
        completedAt: timestamp,
      }),
    ).rejects.toMatchObject({
      name: "SemanticOperationStateConflictError",
      operationKey,
      actualStatus: "SUCCEEDED",
    } satisfies Partial<SemanticOperationStateConflictError>);
  });

  it("reports an absent owned operation as not found after completion misses", async () => {
    const executor = new ScriptedExecutor([[], []]);
    const repository = new PostgresSemanticOperationRepository(executor);

    await expect(
      repository.markSucceeded({
        userId: otherUserId,
        operationKey,
        result: {},
        completedAt: timestamp,
      }),
    ).rejects.toBeInstanceOf(SemanticOperationNotFoundError);
    expect(executor.calls[1]?.values).toEqual([otherUserId, operationKey]);
  });
});

function claimInput(
  overrides: Partial<{
    id: string;
    userId: string;
    operationKey: string;
    requestFingerprint: string;
  }> = {},
) {
  return {
    id: overrides.id ?? operationId,
    userId: overrides.userId ?? userId,
    operationKey: overrides.operationKey ?? operationKey,
    requestFingerprint: overrides.requestFingerprint ?? fingerprint,
  };
}

function operationRow(
  overrides: Partial<{
    status: "PENDING" | "SUCCEEDED" | "FAILED";
    result: SemanticOperationRow["result"];
    error: SemanticOperationRow["error"];
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

function persistedOperation(row: SemanticOperationRow) {
  return {
    id: row.id,
    userId: row.user_id,
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function normalizeSql(queryText: string | undefined): string {
  return queryText?.replaceAll(/\s+/g, " ").trim() ?? "";
}
