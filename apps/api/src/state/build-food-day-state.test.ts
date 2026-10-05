import {
  changeFoodEntryStatus,
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
    "preserves %s completeness without changing target arithmetic",
    (completeness) => {
      const state = build(
        [entry("entry-1", "CONFIRMED_CONSUMED", "400", "20")],
        completeness,
      );
      expect(state.foodDay.completeness).toBe(completeness);
      expect(state.targetProgress).toEqual({
        calories: { remainingToTarget: "2000", overTargetBy: "0" },
        protein: { remainingToTarget: "100", overTargetBy: "0" },
      });
    },
  );

  it.each([
    {
      calories: "2000",
      protein: "100",
      expectedCalories: { remainingToTarget: "400", overTargetBy: "0" },
      expectedProtein: { remainingToTarget: "20", overTargetBy: "0" },
    },
    {
      calories: "2400",
      protein: "120",
      expectedCalories: { remainingToTarget: "0", overTargetBy: "0" },
      expectedProtein: { remainingToTarget: "0", overTargetBy: "0" },
    },
    {
      calories: "2400.125",
      protein: "120.25",
      expectedCalories: { remainingToTarget: "0", overTargetBy: "0.125" },
      expectedProtein: { remainingToTarget: "0", overTargetBy: "0.25" },
    },
  ])(
    "projects exact confirmed target progress for $calories calories and $protein protein",
    ({ calories, protein, expectedCalories, expectedProtein }) => {
      expect(
        build([entry("entry-1", "CONFIRMED_CONSUMED", calories, protein)])
          .targetProgress,
      ).toEqual({ calories: expectedCalories, protein: expectedProtein });
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
    const state = build([
      entry("entry-1", "CONFIRMED_CONSUMED", "685.1075", "41.0025"),
      entry("entry-2", "CONFIRMED_CONSUMED", "0.1", "0.1"),
    ]);
    expect(state.totals.confirmed).toEqual({
      calories: "685.2075",
      protein: "41.1025",
      hasUnknownProtein: false,
    });
    expect(state.targetProgress).toEqual({
      calories: { remainingToTarget: "1714.7925", overTargetBy: "0" },
      protein: { remainingToTarget: "78.8975", overTargetBy: "0" },
    });
  });

  it("keeps confirmed protein unknown instead of representing partial protein as total", () => {
    const state = build([
      entry("entry-1", "CONFIRMED_CONSUMED", "400", "20"),
      entry("entry-2", "CONFIRMED_CONSUMED", "300"),
    ]);
    expect(state.totals.confirmed).toEqual({
      calories: "700",
      protein: null,
      hasUnknownProtein: true,
    });
    expect(state.targetProgress).toEqual({
      calories: { remainingToTarget: "1700", overTargetBy: "0" },
      protein: { remainingToTarget: null, overTargetBy: null },
    });
  });

  it("new non-confirmed entries do not contaminate confirmed totals or unknown protein", () => {
    const state = build([
      entry("entry-1", "CONFIRMED_CONSUMED", "400", "20"),
      entry("entry-2", "PLANNED", "300"),
      entry("entry-3", "CONSIDERED", "250"),
      entry("entry-4", "DISCARDED", "200"),
    ]);
    expect(
      state.entries.map(({ status, revision }) => ({ status, revision })),
    ).toEqual([
      { status: "CONFIRMED_CONSUMED", revision: 1 },
      { status: "PLANNED", revision: 1 },
      { status: "CONSIDERED", revision: 1 },
      { status: "DISCARDED", revision: 1 },
    ]);
    expect(state.totals.confirmed).toEqual({
      calories: "400",
      protein: "20",
      hasUnknownProtein: false,
    });
    expect(state.targetProgress).toEqual({
      calories: { remainingToTarget: "2000", overTargetBy: "0" },
      protein: { remainingToTarget: "100", overTargetBy: "0" },
    });
    expect(
      build([entry("entry-1", "CONFIRMED_CONSUMED", "400")]).totals.confirmed,
    ).toEqual({
      calories: "400",
      protein: null,
      hasUnknownProtein: true,
    });
  });

  it("recomputes confirmed totals after a status leaves and re-enters consumption", () => {
    const original = entry("entry-1", "CONFIRMED_CONSUMED", "400");
    expect(build([original]).totals.confirmed).toEqual({
      calories: "400",
      protein: null,
      hasUnknownProtein: true,
    });
    const planned = changeFoodEntryStatus(original, {
      expectedRevision: 1,
      status: "PLANNED",
    });
    if (!planned.ok) throw new Error("Unexpected fixture conflict.");
    expect(build([planned.value]).totals.confirmed).toEqual({
      calories: "0",
      protein: "0",
      hasUnknownProtein: false,
    });
    const confirmed = changeFoodEntryStatus(planned.value, {
      expectedRevision: 2,
      status: "CONFIRMED_CONSUMED",
    });
    if (!confirmed.ok) throw new Error("Unexpected fixture conflict.");
    expect(build([confirmed.value]).totals.confirmed).toEqual({
      calories: "400",
      protein: null,
      hasUnknownProtein: true,
    });
    expect(confirmed.value.revision).toBe(3);
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
