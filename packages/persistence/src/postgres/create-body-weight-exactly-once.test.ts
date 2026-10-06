import { createBodyWeightEntry } from "@cal-calc/domain";
import { describe, expect, it } from "vitest";

import {
  createBodyWeightExactlyOnce,
  CreateBodyWeightIntegrityError,
} from "./create-body-weight-exactly-once.js";
import type { PostgresExecutor } from "./food-entry-repository.js";
import { SemanticOperationIdempotencyConflictError } from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";

const userId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000001";
const entryId = "30000000-0000-4000-8000-000000000001";
const timestamp = "2026-10-05T12:00:00Z";
const input = {
  userId,
  operationId,
  operationKey: "calcalc:v1:LOG_BODY_WEIGHT:test",
  requestFingerprint: "fingerprint-a",
  entry: createBodyWeightEntry({
    id: entryId,
    localDate: "2026-10-05",
    sourceValue: "180.25",
    sourceUnit: "LB",
  }),
};
const resultJson = { kind: "BODY_WEIGHT_ENTRY_CREATED", entryId };

function operationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: operationId,
    user_id: userId,
    operation_key: input.operationKey,
    request_fingerprint: input.requestFingerprint,
    status: "PENDING",
    result: null,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
    ...overrides,
  };
}
function weightRow() {
  return {
    id: entryId,
    user_id: userId,
    local_date: input.entry.localDate,
    source_value: input.entry.sourceValue,
    source_unit: input.entry.sourceUnit,
    weight_kg: input.entry.weightKg,
    created_at: timestamp,
  };
}

class ScriptedRunner implements PostgresTransactionRunner, PostgresExecutor {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  commits = 0;
  rollbacks = 0;
  constructor(
    private readonly responses: readonly (readonly unknown[] | Error)[],
  ) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    const response = this.responses[this.calls.length - 1] ?? [];
    if (response instanceof Error) throw response;
    return { rows: [...response] };
  }
  async runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ) {
    try {
      const result = await work(this);
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }
}

describe("createBodyWeightExactlyOnce", () => {
  it("claims, inserts, and succeeds in one transaction", async () => {
    const runner = new ScriptedRunner([
      [operationRow()],
      [weightRow()],
      [
        operationRow({
          status: "SUCCEEDED",
          result: resultJson,
          completed_at: timestamp,
        }),
      ],
    ]);
    const result = await createBodyWeightExactlyOnce(runner, input);
    expect(result.disposition).toBe("CREATED");
    expect(result.weightEntry).toEqual({
      entry: input.entry,
      userId,
      createdAt: timestamp,
    });
    expect(runner).toMatchObject({ commits: 1, rollbacks: 0 });
    expect(
      runner.calls.map((call) =>
        call.sql.trim().split(/\s+/).slice(0, 3).join(" "),
      ),
    ).toEqual([
      "insert into public.semantic_operations",
      "insert into public.body_weight_entries",
      "update public.semantic_operations set",
    ]);
    expect(runner.calls[2]?.values).toEqual([
      userId,
      input.operationKey,
      resultJson,
    ]);
    expect(runner.calls[2]?.sql).toContain("completed_at = clock_timestamp()");
  });

  it("replays the owned original row without inserting again", async () => {
    const runner = new ScriptedRunner([
      [],
      [
        operationRow({
          status: "SUCCEEDED",
          result: resultJson,
          completed_at: timestamp,
        }),
      ],
      [weightRow()],
    ]);
    const result = await createBodyWeightExactlyOnce(runner, {
      ...input,
      operationId: "different-candidate",
      entry: { ...input.entry, id: "different-candidate" },
    });
    expect(result.disposition).toBe("REPLAYED");
    expect(result.weightEntry.entry.id).toBe(entryId);
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[2]?.sql).toContain("where id = $1 and user_id = $2");
    expect(runner.calls[2]?.values).toEqual([entryId, userId]);
    expect(runner).toMatchObject({ commits: 1, rollbacks: 0 });
  });

  it("rolls back a fingerprint conflict before inserting a weight row", async () => {
    const runner = new ScriptedRunner([
      [],
      [
        operationRow({
          status: "SUCCEEDED",
          request_fingerprint: "different",
          result: resultJson,
          completed_at: timestamp,
        }),
      ],
    ]);
    await expect(
      createBodyWeightExactlyOnce(runner, input),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
    expect(runner.calls).toHaveLength(2);
  });

  it("rejects a missing replay row and rolls back", async () => {
    const runner = new ScriptedRunner([
      [],
      [
        operationRow({
          status: "SUCCEEDED",
          result: resultJson,
          completed_at: timestamp,
        }),
      ],
      [],
    ]);
    await expect(
      createBodyWeightExactlyOnce(runner, input),
    ).rejects.toBeInstanceOf(CreateBodyWeightIntegrityError);
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
  });
});
