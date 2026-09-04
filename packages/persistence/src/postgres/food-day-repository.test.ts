import { createFoodDay, type FoodDay } from "@cal-calc/domain";
import { describe, expect, it } from "vitest";

import { toFoodDayRow } from "../mapping.js";
import type { FoodDayCompleteness } from "../types.js";
import {
  FoodDayNotFoundError,
  PostgresFoodDayRepository,
} from "./food-day-repository.js";
import type { PostgresExecutor } from "./food-entry-repository.js";

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const firstDayId = "20000000-0000-4000-8000-000000000001";
const secondDayId = "20000000-0000-4000-8000-000000000002";
const localDate = "2026-09-04";
const openedAt = "2026-09-04T00:00:00.000Z";
const laterOpenedAt = "2026-09-04T01:00:00.000Z";

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

describe("PostgresFoodDayRepository", () => {
  it("creates through explicit columns and preserves exact target strings", async () => {
    const foodDay = testFoodDay(firstDayId);
    const executor = new ScriptedExecutor([
      [foodDayRow(foodDay, { completeness: "PARTIAL" })],
    ]);
    const repository = new PostgresFoodDayRepository(executor);

    const created = await repository.create({
      userId,
      foodDay,
      completeness: "PARTIAL",
      localDate,
      timezone: "Asia/Calcutta",
    });

    expect(created.foodDay).toEqual(foodDay);
    expect(created.foodDay.calorieTarget).toBe("2100.125");
    expect(created.foodDay.proteinTarget).toBe("120.005");
    expect(created.foodDay.maintenanceSnapshot).toBe("2400.75");
    expect(typeof created.foodDay.calorieTarget).toBe("string");
    expect(created.completeness).toBe("PARTIAL");
    const call = executor.calls[0];
    expect(normalizeSql(call?.queryText)).toContain(
      "insert into public.food_days ( id, user_id, status, completeness, calorie_target, protein_target, maintenance_snapshot, goal_version_id, local_date, timezone ) values",
    );
    expect(call?.values).toEqual([
      firstDayId,
      userId,
      "PROVISIONAL",
      "PARTIAL",
      "2100.125",
      "120.005",
      "2400.75",
      "goal-version-7",
      localDate,
      "Asia/Calcutta",
    ]);
  });

  it("rejects numeric targets transported as JavaScript numbers", async () => {
    const foodDay = testFoodDay(firstDayId);
    const executor = new ScriptedExecutor([
      [
        {
          ...foodDayRow(foodDay),
          calorie_target: 2100.125,
        },
      ],
    ]);
    const repository = new PostgresFoodDayRepository(executor);

    await expect(
      repository.create({
        userId,
        foodDay,
        completeness: "UNKNOWN",
      }),
    ).rejects.toThrow("PostgreSQL returned an invalid FoodDay row.");
  });

  it("finds by ID and user and returns null for no visible row", async () => {
    const foodDay = testFoodDay(firstDayId);
    const executor = new ScriptedExecutor([[foodDayRow(foodDay)], []]);
    const repository = new PostgresFoodDayRepository(executor);

    expect(await repository.findById(userId, firstDayId)).toMatchObject({
      foodDay,
      userId,
    });
    expect(await repository.findById(otherUserId, firstDayId)).toBeNull();
    for (const call of executor.calls) {
      expect(normalizeSql(call.queryText)).toContain(
        "where id = $1 and user_id = $2",
      );
    }
    expect(executor.calls[1]?.values).toEqual([firstDayId, otherUserId]);
  });

  it("returns every same-date day in deterministic opened-time and ID order", async () => {
    const first = testFoodDay(firstDayId);
    const second = testFoodDay(secondDayId);
    const executor = new ScriptedExecutor([
      [foodDayRow(first), foodDayRow(second, { openedAt: laterOpenedAt })],
    ]);
    const repository = new PostgresFoodDayRepository(executor);

    const found = await repository.findByLocalDate(userId, localDate);

    expect(found.map(({ foodDay }) => foodDay.id)).toEqual([
      firstDayId,
      secondDayId,
    ]);
    expect(normalizeSql(executor.calls[0]?.queryText)).toContain(
      "where user_id = $1 and local_date = $2::date order by opened_at asc, id asc",
    );
    expect(executor.calls[0]?.values).toEqual([userId, localDate]);
  });

  it("updates the complete canonical state without inventing revisioning", async () => {
    const foodDay = createFoodDay({
      id: firstDayId,
      status: "CLOSED",
      calorieTarget: "2050.125",
      proteinTarget: "125.005",
      maintenanceSnapshot: "2400.75",
      goalVersionId: "goal-version-8",
    });
    const closedAt = "2026-09-04T02:00:00.000Z";
    const executor = new ScriptedExecutor([
      [
        foodDayRow(foodDay, {
          completeness: "USER_DECLARED_COMPLETE",
          closedAt,
        }),
      ],
    ]);
    const repository = new PostgresFoodDayRepository(executor);

    const updated = await repository.update({
      userId,
      foodDay,
      completeness: "USER_DECLARED_COMPLETE",
      localDate,
      timezone: "Asia/Calcutta",
      closedAt,
    });

    expect(updated.foodDay).toEqual(foodDay);
    expect(updated.closedAt).toBe(closedAt);
    expect(normalizeSql(executor.calls[0]?.queryText)).toContain(
      "where id = $1 and user_id = $2",
    );
    expect(executor.calls[0]?.values).toEqual([
      firstDayId,
      userId,
      "CLOSED",
      "USER_DECLARED_COMPLETE",
      "2050.125",
      "125.005",
      "2400.75",
      "goal-version-8",
      localDate,
      "Asia/Calcutta",
      closedAt,
    ]);
  });

  it("reports an ownership-scoped update miss as not found", async () => {
    const executor = new ScriptedExecutor([[]]);
    const repository = new PostgresFoodDayRepository(executor);

    await expect(
      repository.update({
        userId: otherUserId,
        foodDay: testFoodDay(firstDayId),
        completeness: "UNKNOWN",
      }),
    ).rejects.toBeInstanceOf(FoodDayNotFoundError);

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.values[1]).toBe(otherUserId);
  });
});

function testFoodDay(id: string): FoodDay {
  return createFoodDay({
    id,
    status: "PROVISIONAL",
    calorieTarget: "2100.125",
    proteinTarget: "120.005",
    maintenanceSnapshot: "2400.75",
    goalVersionId: "goal-version-7",
  });
}

function foodDayRow(
  foodDay: FoodDay,
  overrides: Partial<{
    completeness: FoodDayCompleteness;
    openedAt: string;
    closedAt: string;
  }> = {},
) {
  return toFoodDayRow(foodDay, {
    userId,
    completeness: overrides.completeness ?? "UNKNOWN",
    localDate,
    timezone: "Asia/Calcutta",
    openedAt: overrides.openedAt ?? openedAt,
    ...(overrides.closedAt === undefined
      ? {}
      : { closedAt: overrides.closedAt }),
    createdAt: openedAt,
    updatedAt: openedAt,
  });
}

function normalizeSql(queryText: string | undefined): string {
  return queryText?.replaceAll(/\s+/g, " ").trim() ?? "";
}
