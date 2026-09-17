import {
  createFoodDay,
  createFoodEntry,
  type FoodEntry,
} from "@cal-calc/domain";
import type { FoodDayCompleteness } from "@cal-calc/persistence";
import { describe, expect, it } from "vitest";

import { buildFoodDayState } from "./build-food-day-state.js";

const foodDay = createFoodDay({
  id: "20000000-0000-4000-8000-000000000001",
  status: "OPEN",
  calorieTarget: "2400.0",
  proteinTarget: "120.00",
  maintenanceSnapshot: "2650",
  goalVersionId: "goal-v3",
});

function entry(
  id: string,
  status: FoodEntry["status"],
  calories: string,
  protein?: string,
): FoodEntry {
  return createFoodEntry({
    id,
    foodDayId: foodDay.id,
    rawUserDescription: `${status} raw description`,
    displayName: `${status} food`,
    quantity: { amount: "1.5", unit: "SERVING" },
    nutritionBasis: {
      amount: "1.5",
      unit: "SERVING",
      nutrition: {
        calories,
        ...(protein === undefined ? {} : { protein }),
      },
    },
    evidenceClass: id.endsWith("1") ? "SOURCED" : "EXACT",
    status,
  });
}

function build(
  entries: readonly FoodEntry[],
  completeness: FoodDayCompleteness = "PARTIAL",
) {
  return buildFoodDayState({
    foodDay,
    entries,
    completeness,
    localDate: "2026-09-17",
  });
}

describe("buildFoodDayState", () => {
  it("is deterministic and safely JSON serializable", () => {
    const entries = [entry("entry-1", "CONFIRMED_CONSUMED", "400", "20")];
    const first = build(entries);
    const second = build(entries);
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("preserves canonical FoodDay facts, completeness, and normalized targets", () => {
    expect(build([]).foodDay).toEqual({
      id: foodDay.id,
      localDate: "2026-09-17",
      status: "OPEN",
      completeness: "PARTIAL",
      targets: { calories: "2400", protein: "120" },
    });
  });

  it.each(["UNKNOWN", "PARTIAL", "USER_DECLARED_COMPLETE"] as const)(
    "preserves %s completeness without inference",
    (completeness) => {
      expect(build([], completeness).foodDay.completeness).toBe(completeness);
    },
  );

  it("preserves canonical entry order and selected factual fields", () => {
    const considered = entry("entry-2", "CONSIDERED", "300", "10");
    const confirmed = entry("entry-1", "CONFIRMED_CONSUMED", "400", "20");
    const state = build([considered, confirmed]);
    expect(state.entries.map(({ id }) => id)).toEqual(["entry-2", "entry-1"]);
    expect(state.entries[0]).toEqual({
      id: "entry-2",
      displayName: "CONSIDERED food",
      rawUserDescription: "CONSIDERED raw description",
      quantity: { amount: "1.5", unit: "SERVING" },
      status: "CONSIDERED",
      workingNutrition: { calories: "300", protein: "10" },
      evidenceClass: "EXACT",
      revision: 1,
    });
  });

  it("counts confirmed consumed nutrition using canonical working values", () => {
    expect(
      build([entry("entry-1", "CONFIRMED_CONSUMED", "400", "20")]).totals,
    ).toEqual({
      confirmed: {
        calories: "400",
        protein: "20",
        hasUnknownProtein: false,
      },
    });
  });

  it.each(["PLANNED", "CONSIDERED", "DISCARDED"] as const)(
    "does not count %s nutrition toward confirmed totals",
    (status) => {
      expect(
        build([entry(`entry-${status}`, status, "900", "90")]).totals.confirmed,
      ).toEqual({
        calories: "0",
        protein: "0",
        hasUnknownProtein: false,
      });
    },
  );

  it("aggregates multiple confirmed entries with exact decimal arithmetic", () => {
    const totals = build([
      entry("entry-1", "CONFIRMED_CONSUMED", "685.1075", "41.0025"),
      entry("entry-2", "CONFIRMED_CONSUMED", "0.1", "0.1"),
    ]).totals.confirmed;
    expect(totals).toEqual({
      calories: "685.2075",
      protein: "41.1025",
      hasUnknownProtein: false,
    });
  });

  it("keeps confirmed protein unknown instead of representing partial protein as total", () => {
    const totals = build([
      entry("entry-1", "CONFIRMED_CONSUMED", "400", "20"),
      entry("entry-2", "CONFIRMED_CONSUMED", "300"),
    ]).totals.confirmed;
    expect(totals).toEqual({
      calories: "700",
      protein: null,
      hasUnknownProtein: true,
    });
  });

  it("does not expose advisory, projected, scenario, or remaining-total fields", () => {
    const state = build([entry("entry-1", "PLANNED", "400", "20")]);
    expect(state).not.toHaveProperty("projected");
    expect(state).not.toHaveProperty("scenario");
    expect(state).not.toHaveProperty("remainingCalories");
    expect(state.totals).not.toHaveProperty("projected");
    expect(state.foodDay).not.toHaveProperty("maintenanceSnapshot");
  });
});
