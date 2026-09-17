import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import { describe, expect, it, vi } from "vitest";

import * as inspection from "../queries/list-food-entries-for-food-day.js";
import { getFoodDayState } from "./get-food-day-state.js";

vi.mock(
  "../queries/list-food-entries-for-food-day.js",
  async (importOriginal) => ({
    ...(await importOriginal<typeof inspection>()),
    listFoodEntriesForFoodDay: vi.fn(),
  }),
);

const query = vi.mocked(inspection.listFoodEntriesForFoodDay);
const foodDay = createFoodDay({
  id: "20000000-0000-4000-8000-000000000001",
  status: "OPEN",
  calorieTarget: "2400",
  proteinTarget: "120",
});
const foodEntry = createFoodEntry({
  id: "30000000-0000-4000-8000-000000000001",
  foodDayId: foodDay.id,
  rawUserDescription: "Lunch",
  displayName: "Lunch",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "400", protein: "20" },
  },
  evidenceClass: "EXACT",
  status: "CONFIRMED_CONSUMED",
});

describe("getFoodDayState", () => {
  it("delegates trusted inspection input and builds deterministic state", async () => {
    const dependencies = {
      foodDays: { findById: vi.fn() },
      foodEntries: { listActiveByFoodDay: vi.fn() },
    };
    const input = {
      trustedUserId: "10000000-0000-4000-8000-000000000001",
      foodDayId: foodDay.id,
    };
    query.mockResolvedValueOnce({
      foodDay,
      entries: [foodEntry],
      completeness: "USER_DECLARED_COMPLETE",
      localDate: "2026-09-17",
    });

    const state = await getFoodDayState(dependencies, input);

    expect(query).toHaveBeenCalledExactlyOnceWith(dependencies, input);
    expect(state.foodDay.completeness).toBe("USER_DECLARED_COMPLETE");
    expect(state.totals.confirmed).toEqual({
      calories: "400",
      protein: "20",
      hasUnknownProtein: false,
    });
  });
});
