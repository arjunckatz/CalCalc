import {
  changeFoodEntryStatus,
  createFoodEntry,
  type FoodEntry,
  type MutationResult,
} from "@cal-calc/domain";
import { describe, expect, it } from "vitest";

import { toFoodEntryRow } from "../mapping.js";
import {
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  PostgresFoodEntryRepository,
  type PostgresExecutor,
} from "./food-entry-repository.js";

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const foodDayId = "20000000-0000-4000-8000-000000000001";
const entryId = "30000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-02T00:00:00.000Z";

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

describe("PostgresFoodEntryRepository", () => {
  it("creates with canonical serialized values and hydrates the returned row", async () => {
    const entry = testEntry();
    const executor = new ScriptedExecutor([[rowFor(entry)]]);
    const repository = new PostgresFoodEntryRepository(executor);

    const created = await repository.create({ userId, entry });

    expect(created.entry).toEqual(entry);
    expect(created.entry.derivedNutrition).toEqual({
      calories: "685.1075",
      protein: "41.0025",
    });
    expect(executor.calls).toHaveLength(1);
    expect(normalizeSql(executor.calls[0]?.queryText)).toContain(
      "insert into public.food_entries",
    );
    expect(executor.calls[0]?.values[0]).toBe(entryId);
    expect(executor.calls[0]?.values[1]).toBe(userId);
    expect(executor.calls[0]?.values[7]).toBe("275");
    expect(executor.calls[0]?.values[11]).toEqual({
      calories: "249.13",
      protein: "14.91",
    });
    expect(executor.calls[0]?.values[21]).toBeNull();
    expect(executor.calls[0]?.values[22]).toBeNull();
  });

  it("creates with paired consumed-time metadata", async () => {
    const entry = testEntry();
    const consumedAt = "2026-09-02T14:30:00.000Z";
    const executor = new ScriptedExecutor([
      [rowFor(entry, { consumedAt, consumedTimePrecision: "APPROXIMATE" })],
    ]);
    const repository = new PostgresFoodEntryRepository(executor);

    const created = await repository.create({
      userId,
      entry,
      consumedAt,
      consumedTimePrecision: "APPROXIMATE",
    });

    expect(created.consumedAt).toBe(consumedAt);
    expect(created.consumedTimePrecision).toBe("APPROXIMATE");
    expect(executor.calls[0]?.values[21]).toBe(consumedAt);
    expect(executor.calls[0]?.values[22]).toBe("APPROXIMATE");
  });

  it("rejects unpaired consumed-time metadata before executing SQL", async () => {
    const executor = new ScriptedExecutor([]);
    const repository = new PostgresFoodEntryRepository(executor);

    await expect(
      repository.create({
        userId,
        entry: testEntry(),
        consumedAt: timestamp,
      }),
    ).rejects.toThrow(
      "consumedAt and consumedTimePrecision must be provided together.",
    );
    await expect(
      repository.create({
        userId,
        entry: testEntry(),
        consumedTimePrecision: "EXACT",
      }),
    ).rejects.toThrow(
      "consumedAt and consumedTimePrecision must be provided together.",
    );
    expect(executor.calls).toHaveLength(0);
  });

  it("finds only by entry ID and user ID and returns null for no visible row", async () => {
    const entry = testEntry();
    const executor = new ScriptedExecutor([[rowFor(entry)], []]);
    const repository = new PostgresFoodEntryRepository(executor);

    const found = await repository.findById(userId, entryId);
    const hidden = await repository.findById(otherUserId, entryId);

    expect(found?.entry).toEqual(entry);
    expect(hidden).toBeNull();
    for (const call of executor.calls) {
      expect(normalizeSql(call.queryText)).toContain(
        "where id = $1 and user_id = $2",
      );
    }
    expect(executor.calls[1]?.values).toEqual([entryId, otherUserId]);
  });

  it("updates through an ownership and expected-revision predicate", async () => {
    const updatedEntry = successful(
      changeFoodEntryStatus(testEntry(), {
        expectedRevision: 1,
        status: "PLANNED",
      }),
    );
    const executor = new ScriptedExecutor([[rowFor(updatedEntry)]]);
    const repository = new PostgresFoodEntryRepository(executor);

    const updated = await repository.update({
      userId,
      expectedRevision: 1,
      entry: updatedEntry,
    });

    expect(updated.entry).toEqual(updatedEntry);
    const call = executor.calls[0];
    expect(normalizeSql(call?.queryText)).toContain(
      "where id = $1 and user_id = $2 and revision = $22",
    );
    expect(call?.values[1]).toBe(userId);
    expect(call?.values[19]).toBe(2);
    expect(call?.values[21]).toBe(1);
  });

  it("reports a same-user stale revision without an ID-only fallback query", async () => {
    const executor = new ScriptedExecutor([[], [{ revision: 3 }]]);
    const repository = new PostgresFoodEntryRepository(executor);

    await expect(
      repository.update({
        userId,
        expectedRevision: 1,
        entry: testEntry(),
      }),
    ).rejects.toMatchObject({
      name: "FoodEntryRevisionConflictError",
      entryId,
      expectedRevision: 1,
      actualRevision: 3,
    } satisfies Partial<FoodEntryRevisionConflictError>);

    expect(executor.calls).toHaveLength(2);
    expect(normalizeSql(executor.calls[1]?.queryText)).toContain(
      "where id = $1 and user_id = $2",
    );
    expect(executor.calls[1]?.values).toEqual([entryId, userId]);
  });

  it("reports no same-user row as not found", async () => {
    const executor = new ScriptedExecutor([[], []]);
    const repository = new PostgresFoodEntryRepository(executor);

    await expect(
      repository.update({
        userId: otherUserId,
        expectedRevision: 1,
        entry: testEntry(),
      }),
    ).rejects.toBeInstanceOf(FoodEntryNotFoundError);

    expect(executor.calls[1]?.values).toEqual([entryId, otherUserId]);
  });
});

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

function rowFor(
  entry: FoodEntry,
  consumedTime: {
    readonly consumedAt: string;
    readonly consumedTimePrecision: "EXACT" | "APPROXIMATE";
  } | null = null,
) {
  return toFoodEntryRow(entry, {
    userId,
    reportedAt: timestamp,
    ...(consumedTime ?? {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function successful<Value>(result: MutationResult<Value>): Value {
  if (!result.ok) throw new Error(`Unexpected conflict: ${result.error.type}`);
  return result.value;
}

function normalizeSql(queryText: string | undefined): string {
  return queryText?.replaceAll(/\s+/g, " ").trim() ?? "";
}
