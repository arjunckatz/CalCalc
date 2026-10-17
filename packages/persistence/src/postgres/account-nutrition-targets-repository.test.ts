import { describe, expect, it } from "vitest";

import type { PostgresExecutor } from "./food-entry-repository.js";
import {
  AccountNutritionTargetsVersionConflictError,
  PostgresAccountNutritionTargetsRepository,
} from "./account-nutrition-targets-repository.js";

const userId = "10000000-0000-4000-8000-000000000001";
const timestamp = "2026-10-17T00:00:00.000Z";
const row = {
  user_id: userId,
  calorie_target: "685.1075",
  protein_target: "41.0025",
  version: 0,
  created_at: timestamp,
  updated_at: timestamp,
};

class Executor implements PostgresExecutor {
  readonly calls: { sql: string; values: unknown[] }[] = [];
  constructor(private readonly responses: readonly (readonly unknown[])[]) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: [...(this.responses[this.calls.length - 1] ?? [])] };
  }
}

describe("PostgresAccountNutritionTargetsRepository", () => {
  it("can lock an exact owner target snapshot until the enclosing transaction ends", async () => {
    const executor = new Executor([[row]]);
    await new PostgresAccountNutritionTargetsRepository(
      executor,
    ).findByUserForShare(userId);
    expect(executor.calls[0]?.sql).toContain("where user_id = $1 for share");
    expect(executor.calls[0]?.values).toEqual([userId]);
  });

  it("represents absence explicitly with an owner-scoped read", async () => {
    const executor = new Executor([[]]);
    expect(
      await new PostgresAccountNutritionTargetsRepository(executor).findByUser(
        userId,
      ),
    ).toBeNull();
    expect(executor.calls[0]?.sql).toContain("where user_id = $1");
    expect(executor.calls[0]?.values).toEqual([userId]);
  });

  it("hydrates exact numeric strings, never JavaScript numbers", async () => {
    const executor = new Executor([[row]]);
    expect(
      await new PostgresAccountNutritionTargetsRepository(executor).findByUser(
        userId,
      ),
    ).toEqual({
      userId,
      calorieTarget: "685.1075",
      proteinTarget: "41.0025",
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(executor.calls[0]?.sql).toContain("calorie_target::text");
    const invalid = new Executor([[{ ...row, calorie_target: 685.1075 }]]);
    await expect(
      new PostgresAccountNutritionTargetsRepository(invalid).findByUser(userId),
    ).rejects.toThrow(TypeError);
  });

  it("inserts only both normalized targets and returns DB-owned timestamps", async () => {
    const executor = new Executor([[row]]);
    const result = await new PostgresAccountNutritionTargetsRepository(
      executor,
    ).setWithExpectedVersion({
      userId,
      expectedVersion: null,
      calorieTarget: "0685.107500",
      proteinTarget: "41.002500",
    });
    expect(result).toMatchObject({
      calorieTarget: "685.1075",
      proteinTarget: "41.0025",
      version: 0,
    });
    expect(executor.calls[0]?.sql).toContain(
      "on conflict (user_id) do nothing",
    );
    expect(executor.calls[0]?.values).toEqual([userId, "685.1075", "41.0025"]);
    expect(executor.calls[0]?.sql).toMatch(
      /\(user_id, calorie_target, protein_target\)\s+values/,
    );
  });

  it("CAS-updates by owner and version, or returns a typed conflict", async () => {
    const executor = new Executor([[{ ...row, version: 1 }], []]);
    const repository = new PostgresAccountNutritionTargetsRepository(executor);
    const input = {
      userId,
      expectedVersion: 0,
      calorieTarget: "685.1075",
      proteinTarget: "41.0025",
    };
    expect((await repository.setWithExpectedVersion(input)).version).toBe(1);
    await expect(
      repository.setWithExpectedVersion(input),
    ).rejects.toBeInstanceOf(AccountNutritionTargetsVersionConflictError);
    expect(executor.calls[0]?.sql).toContain(
      "where user_id = $1 and version = $2",
    );
    expect(executor.calls[0]?.values).toEqual([
      userId,
      0,
      "685.1075",
      "41.0025",
    ]);
  });

  it("losing initial insert conflicts even for identical values", async () => {
    const executor = new Executor([[]]);
    await expect(
      new PostgresAccountNutritionTargetsRepository(
        executor,
      ).setWithExpectedVersion({
        userId,
        expectedVersion: null,
        calorieTarget: "0",
        proteinTarget: "0",
      }),
    ).rejects.toBeInstanceOf(AccountNutritionTargetsVersionConflictError);
  });
});
