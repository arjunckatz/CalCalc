import { describe, expect, it } from "vitest";

import { createFoodDay, createFoodEntry, summarizeFoodDay } from "../index.js";

const day = createFoodDay({
  id: "summary-day",
  status: "OPEN",
  calorieTarget: "2100",
  proteinTarget: "120",
  maintenanceSnapshot: "2400",
  goalVersionId: "goal-v2",
});

function consumed(calories: string, protein?: string) {
  return createFoodEntry({
    id: `entry-${calories}`,
    foodDayId: day.id,
    rawUserDescription: "confirmed food",
    displayName: "Confirmed food",
    quantity: { amount: "1", unit: "SERVING" },
    nutritionBasis: {
      amount: "1",
      unit: "SERVING",
      nutrition: {
        calories,
        ...(protein === undefined ? {} : { protein }),
      },
    },
    evidenceClass: "EXACT",
    status: "CONFIRMED_CONSUMED",
  });
}

describe("food day summaries", () => {
  it("keeps unknown protein unknown-aware instead of treating it as zero-quality data", () => {
    const summary = summarizeFoodDay(day, [
      consumed("300", "20"),
      consumed("400"),
    ]);
    expect(summary.confirmedCalories).toBe("700");
    expect(summary.confirmedProtein).toBe("20");
    expect(summary.hasUnknownProtein).toBe(true);
    expect(summary.calorieTarget).toBe("2100");
    expect(summary.proteinTarget).toBe("120");
  });

  it("does not clamp remaining calories above the target", () => {
    const summary = summarizeFoodDay(day, [consumed("2367", "10")]);
    expect(summary.remainingCalories).toBe("-267");
  });

  it("uses each food day's immutable target snapshot", () => {
    const yesterday = createFoodDay({
      id: "yesterday",
      status: "CLOSED",
      calorieTarget: "2400",
      proteinTarget: "120",
    });
    const today = createFoodDay({
      id: "today",
      status: "OPEN",
      calorieTarget: "2100",
      proteinTarget: "120",
    });

    expect(summarizeFoodDay(yesterday, []).calorieTarget).toBe("2400");
    expect(summarizeFoodDay(today, []).calorieTarget).toBe("2100");
  });
});
