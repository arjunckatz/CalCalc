import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import { FoodDayNotFoundError } from "@cal-calc/persistence";
import { describe, expect, it, vi } from "vitest";

import {
  InvalidFoodDayIdError,
  listFoodEntriesForFoodDay,
} from "./list-food-entries-for-food-day.js";

const trustedUserId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const foodDayId = "20000000-0000-4000-8000-000000000001";
const foodDay = createFoodDay({
  id: foodDayId,
  status: "OPEN",
  calorieTarget: "2400",
  proteinTarget: "120",
});
const persistedDay = {
  foodDay,
  userId: trustedUserId,
  completeness: "UNKNOWN" as const,
  openedAt: "2026-09-17T00:00:00.000Z",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
};
const first = createFoodEntry({
  id: "30000000-0000-4000-8000-000000000001",
  foodDayId,
  rawUserDescription: "Lunch",
  displayName: "Lunch",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "249.13", protein: "14.91" },
  },
  evidenceClass: "EXACT",
  status: "CONFIRMED_CONSUMED",
});
const second = { ...first, id: "30000000-0000-4000-8000-000000000002" };

function setup() {
  const foodDays = { findById: vi.fn().mockResolvedValue(persistedDay) };
  const foodEntries = {
    listActiveByFoodDay: vi.fn().mockResolvedValue([first, second]),
  };
  return { foodDays, foodEntries };
}

describe("listFoodEntriesForFoodDay", () => {
  it("loads the owned FoodDay first, then lists entries with the same trusted scope", async () => {
    const dependencies = setup();
    const calls: string[] = [];
    dependencies.foodDays.findById.mockImplementation(async () => {
      calls.push("day");
      return persistedDay;
    });
    dependencies.foodEntries.listActiveByFoodDay.mockImplementation(
      async () => {
        calls.push("entries");
        return [first, second];
      },
    );

    const result = await listFoodEntriesForFoodDay(dependencies, {
      trustedUserId,
      foodDayId,
    });

    expect(calls).toEqual(["day", "entries"]);
    expect(dependencies.foodDays.findById).toHaveBeenCalledExactlyOnceWith(
      trustedUserId,
      foodDayId,
    );
    expect(
      dependencies.foodEntries.listActiveByFoodDay,
    ).toHaveBeenCalledExactlyOnceWith(trustedUserId, foodDayId);
    expect(result).toEqual({ foodDay, entries: [first, second] });
    expect(result.foodDay).toBe(foodDay);
    expect(result.entries[0]).toBe(first);
  });

  it("returns an empty canonical entry collection for an owned empty day", async () => {
    const dependencies = setup();
    dependencies.foodEntries.listActiveByFoodDay.mockResolvedValue([]);

    expect(
      await listFoodEntriesForFoodDay(dependencies, {
        trustedUserId,
        foodDayId,
      }),
    ).toEqual({ foodDay, entries: [] });
  });

  it("preserves the repository's canonical order without mapping or filtering", async () => {
    const dependencies = setup();
    const repositoryEntries = [second, first];
    dependencies.foodEntries.listActiveByFoodDay.mockResolvedValue(
      repositoryEntries,
    );

    const result = await listFoodEntriesForFoodDay(dependencies, {
      trustedUserId,
      foodDayId,
    });
    expect(result.entries).toEqual([second, first]);
    expect(result.entries).toBe(repositoryEntries);
  });

  it("does not list entries when the trusted FoodDay lookup finds no row", async () => {
    const dependencies = setup();
    dependencies.foodDays.findById.mockResolvedValue(null);

    await expect(
      listFoodEntriesForFoodDay(dependencies, { trustedUserId, foodDayId }),
    ).rejects.toBeInstanceOf(FoodDayNotFoundError);
    expect(dependencies.foodEntries.listActiveByFoodDay).not.toHaveBeenCalled();
  });

  it("treats a cross-user FoodDay exactly like a missing FoodDay", async () => {
    const dependencies = setup();
    dependencies.foodDays.findById.mockResolvedValue(null);

    await expect(
      listFoodEntriesForFoodDay(dependencies, {
        trustedUserId: otherUserId,
        foodDayId,
      }),
    ).rejects.toMatchObject({ name: "FoodDayNotFoundError", foodDayId });
    expect(dependencies.foodDays.findById).toHaveBeenCalledWith(
      otherUserId,
      foodDayId,
    );
    expect(dependencies.foodEntries.listActiveByFoodDay).not.toHaveBeenCalled();
  });

  it("rejects invalid FoodDay IDs before any read", async () => {
    const dependencies = setup();
    for (const invalid of [
      "not-a-uuid",
      "",
      "20000000-0000-4000-8000-000000000001 ",
    ]) {
      await expect(
        listFoodEntriesForFoodDay(dependencies, {
          trustedUserId,
          foodDayId: invalid,
        }),
      ).rejects.toBeInstanceOf(InvalidFoodDayIdError);
    }
    expect(dependencies.foodDays.findById).not.toHaveBeenCalled();
    expect(dependencies.foodEntries.listActiveByFoodDay).not.toHaveBeenCalled();
  });
});
