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

function historyRow(
  historyBucket: 0 | 1,
  overrides: Record<string, unknown> = {},
) {
  return { ...row(overrides), history_bucket: historyBucket };
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

  it("returns an empty history for a user with no observations", async () => {
    const executor = new ScriptedExecutor([[]]);
    const history = await new PostgresBodyWeightRepository(
      executor,
    ).readHistory(userId, 30);
    expect(history).toEqual({
      recentObservations: [],
      latestMeasurementDate: null,
      latestDateObservations: [],
    });
    expect(executor.calls[0]?.values).toEqual([userId, 30]);
    expect(
      executor.calls[0]?.sql.match(/where b\.user_id = \$1/g),
    ).toHaveLength(3);
  });

  it("hydrates the one owned observation in both subsets without changing exact decimals", async () => {
    const executor = new ScriptedExecutor([[historyRow(0), historyRow(1)]]);
    const history = await new PostgresBodyWeightRepository(
      executor,
    ).readHistory(userId, 30);
    const observation = { entry, userId, createdAt };
    expect(history).toEqual({
      recentObservations: [observation],
      latestMeasurementDate: "2026-10-04",
      latestDateObservations: [observation],
    });
    expect(typeof history.recentObservations[0]?.entry.weightKg).toBe("string");
    expect(history.recentObservations[0]?.entry.weightKg).toBe("81.7600246925");
  });

  it("retains repository ordering and all observations on the latest local date, not the newest ingestion date", async () => {
    const newestDateFirst = historyRow(0, {
      id: "latest-a",
      local_date: "2026-10-06",
      source_value: "80.2",
      source_unit: "KG",
      weight_kg: "80.2",
      created_at: "2026-10-06T10:00:00Z",
    });
    const newestDateSecond = historyRow(0, {
      id: "latest-b",
      local_date: "2026-10-06",
      source_value: "81",
      source_unit: "KG",
      weight_kg: "81",
      created_at: "2026-10-06T09:00:00Z",
    });
    const laterBackfill = historyRow(0, {
      id: "older-measurement",
      local_date: "2026-10-01",
      source_value: "79.8",
      source_unit: "KG",
      weight_kg: "79.8",
      created_at: "2026-10-07T10:00:00Z",
    });
    const executor = new ScriptedExecutor([
      [
        newestDateFirst,
        newestDateSecond,
        laterBackfill,
        { ...newestDateFirst, history_bucket: 1 },
        { ...newestDateSecond, history_bucket: 1 },
      ],
    ]);
    const history = await new PostgresBodyWeightRepository(
      executor,
    ).readHistory(userId, 30);
    expect(history.recentObservations.map(({ entry }) => entry.id)).toEqual([
      "latest-a",
      "latest-b",
      "older-measurement",
    ]);
    expect(history.latestMeasurementDate).toBe("2026-10-06");
    expect(history.latestDateObservations.map(({ entry }) => entry.id)).toEqual(
      ["latest-a", "latest-b"],
    );
    expect(executor.calls[0]?.sql).toContain(
      "order by b.local_date desc, b.created_at desc, b.id desc",
    );
    expect(executor.calls[0]?.sql).toContain("limit $2");
  });

  it("does not truncate the latest-date set at the recent-history limit", async () => {
    const latest = Array.from({ length: 31 }, (_, index) =>
      historyRow(1, {
        id: `latest-${index}`,
        local_date: "2026-10-05",
      }),
    );
    const recent = latest.slice(0, 30).map((value) => ({
      ...value,
      history_bucket: 0,
    }));
    const executor = new ScriptedExecutor([[...recent, ...latest]]);
    const history = await new PostgresBodyWeightRepository(
      executor,
    ).readHistory(userId, 30);
    expect(history.recentObservations).toHaveLength(30);
    expect(history.latestDateObservations).toHaveLength(31);
    expect(history.latestMeasurementDate).toBe("2026-10-05");
    expect(executor.calls[0]?.sql).toContain("join latest_date d");
  });

  it.each([0, 31, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid recent limit %s before querying",
    async (limit) => {
      const executor = new ScriptedExecutor([]);
      await expect(
        new PostgresBodyWeightRepository(executor).readHistory(userId, limit),
      ).rejects.toBeInstanceOf(RangeError);
      expect(executor.calls).toEqual([]);
    },
  );

  it("rejects a wrong-owner or invalid converted row during history hydration", async () => {
    for (const invalid of [{ user_id: "other-user" }, { weight_kg: "81.76" }]) {
      const executor = new ScriptedExecutor([[historyRow(0, invalid)]]);
      await expect(
        new PostgresBodyWeightRepository(executor).readHistory(userId, 30),
      ).rejects.toThrow();
    }
  });
});
