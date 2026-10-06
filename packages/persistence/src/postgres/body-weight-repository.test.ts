import { createBodyWeightEntry } from "@cal-calc/domain";
import { describe, expect, it } from "vitest";

import { PostgresBodyWeightRepository } from "./body-weight-repository.js";
import type { PostgresExecutor } from "./food-entry-repository.js";

const userId = "10000000-0000-4000-8000-000000000001";
const entryId = "20000000-0000-4000-8000-000000000001";
const createdAt = "2026-10-05T12:00:00Z";
const entry = createBodyWeightEntry({
  id: entryId,
  localDate: "2026-10-04",
  sourceValue: "180.25",
  sourceUnit: "LB",
});

class ScriptedExecutor implements PostgresExecutor {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  constructor(private readonly responses: readonly (readonly unknown[])[]) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: [...(this.responses[this.calls.length - 1] ?? [])] };
  }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: entry.id,
    user_id: userId,
    local_date: entry.localDate,
    source_value: entry.sourceValue,
    source_unit: entry.sourceUnit,
    weight_kg: entry.weightKg,
    created_at: createdAt,
    ...overrides,
  };
}

describe("PostgresBodyWeightRepository", () => {
  it("inserts exact source and kg decimal strings and returns the owned observation", async () => {
    const executor = new ScriptedExecutor([[row()]]);
    const result = await new PostgresBodyWeightRepository(executor).create({
      userId,
      entry,
    });
    expect(result).toEqual({ entry, userId, createdAt });
    expect(executor.calls[0]?.values).toEqual([
      entry.id,
      userId,
      entry.localDate,
      "180.25",
      "LB",
      "81.7600246925",
    ]);
    expect(executor.calls[0]?.sql).toContain(
      "insert into public.body_weight_entries",
    );
    expect(executor.calls[0]?.sql).toContain("source_value::text");
    expect(executor.calls[0]?.sql).toContain("weight_kg::text");
  });

  it("finds only by entry ID and owner ID", async () => {
    const executor = new ScriptedExecutor([[row()]]);
    expect(
      await new PostgresBodyWeightRepository(executor).findById(
        userId,
        entryId,
      ),
    ).toEqual({ entry, userId, createdAt });
    expect(executor.calls[0]?.values).toEqual([entryId, userId]);
    expect(executor.calls[0]?.sql).toContain("where id = $1 and user_id = $2");
  });

  it("returns null for a missing owned row", async () => {
    const executor = new ScriptedExecutor([[]]);
    expect(
      await new PostgresBodyWeightRepository(executor).findById(
        userId,
        entryId,
      ),
    ).toBeNull();
  });

  it.each([
    { weight_kg: "81.76" },
    { source_value: "0" },
    { source_unit: "STONE" },
    { local_date: "2026-02-30" },
  ])("rejects invalid stored weight data %#", async (invalid) => {
    const executor = new ScriptedExecutor([[row(invalid)]]);
    await expect(
      new PostgresBodyWeightRepository(executor).findById(userId, entryId),
    ).rejects.toThrow();
  });
});
