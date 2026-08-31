import { describe, expect, it } from "vitest";

import {
  applyWorkingNutritionOverride,
  changeFoodEntryStatus,
  clearWorkingNutritionOverride,
  createFoodDay,
  createFoodEntry,
  deleteFoodEntry,
  DomainValidationError,
  replaceFoodEntry,
  restoreFoodEntry,
  summarizeFoodDay,
  updateFoodEntryQuantity,
  type FoodEntry,
  type MutationResult,
} from "../index.js";

const foodDay = createFoodDay({
  id: "day-1",
  status: "OPEN",
  calorieTarget: "2100",
  proteinTarget: "120",
  goalVersionId: "goal-v1",
});

function successful<Value>(result: MutationResult<Value>): Value {
  if (!result.ok) throw new Error(`Unexpected conflict: ${result.error.type}`);
  return result.value;
}

function entry(
  overrides: Partial<{
    id: string;
    rawUserDescription: string;
    displayName: string;
    quantity: { amount: string; unit: "SERVING" };
    nutrition: { calories: string; protein?: string };
    evidenceClass: "EXACT" | "SOURCED" | "ESTIMATED";
    status: "CONFIRMED_CONSUMED" | "PLANNED" | "CONSIDERED" | "DISCARDED";
    estimateLow: { calories: string; protein?: string };
    estimateHigh: { calories: string; protein?: string };
  }> = {},
): FoodEntry {
  const nutrition = overrides.nutrition ?? { calories: "100", protein: "10" };
  return createFoodEntry({
    id: overrides.id ?? "entry-1",
    foodDayId: foodDay.id,
    rawUserDescription: overrides.rawUserDescription ?? "food",
    displayName: overrides.displayName ?? "Food",
    quantity: overrides.quantity ?? { amount: "1", unit: "SERVING" },
    nutritionBasis: {
      amount: "1",
      unit: "SERVING",
      nutrition,
    },
    evidenceClass: overrides.evidenceClass ?? "EXACT",
    ...(overrides.estimateLow === undefined
      ? {}
      : { estimateLow: overrides.estimateLow }),
    ...(overrides.estimateHigh === undefined
      ? {}
      : { estimateHigh: overrides.estimateHigh }),
    status: overrides.status ?? "CONFIRMED_CONSUMED",
  });
}

describe("food entry aggregate", () => {
  it("does not count planned food and keeps discard non-countable", () => {
    const planned = entry({
      rawUserDescription: "I might eat 250 g sausages.",
      displayName: "Sausages",
      status: "PLANNED",
    });
    expect(summarizeFoodDay(foodDay, [planned]).confirmedCalories).toBe("0");

    const discarded = successful(
      changeFoodEntryStatus(planned, {
        expectedRevision: planned.revision,
        status: "DISCARDED",
      }),
    );
    expect(discarded.revision).toBe(2);
    expect(summarizeFoodDay(foodDay, [discarded]).confirmedCalories).toBe("0");
  });

  it("replaces a correction in place without a duplicate ledger entry", () => {
    const roti = entry({
      id: "roti-1",
      displayName: "Restaurant roti",
      nutrition: { calories: "110" },
    });
    const replacement = successful(
      replaceFoodEntry(roti, {
        expectedRevision: roti.revision,
        rawUserDescription: "That roti was actually 1.5 laccha parathas.",
        displayName: "Laccha paratha",
        quantity: { amount: "1.5", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "200" },
        },
        evidenceClass: "SOURCED",
        status: "CONFIRMED_CONSUMED",
      }),
    );

    expect(replacement.id).toBe(roti.id);
    expect(replacement.revision).toBe(2);
    expect(summarizeFoodDay(foodDay, [replacement]).confirmedCalories).toBe(
      "300",
    );
  });

  it("supports a valid countable estimated entry with bounds", () => {
    const halfKalakand = entry({
      id: "kalakand-1",
      displayName: "Half kalakand",
      quantity: { amount: "0.5", unit: "SERVING" },
      nutrition: { calories: "200" },
      evidenceClass: "ESTIMATED",
      estimateLow: { calories: "80" },
      estimateHigh: { calories: "120" },
    });

    expect(halfKalakand.workingNutrition.calories).toBe("100");
    expect(summarizeFoodDay(foodDay, [halfKalakand]).confirmedCalories).toBe(
      "100",
    );
  });

  it("allows an explicit working override outside the source estimate range", () => {
    const estimate = entry({
      id: "estimated-override-1",
      quantity: { amount: "0.5", unit: "SERVING" },
      nutrition: { calories: "200" },
      evidenceClass: "ESTIMATED",
      estimateLow: { calories: "80" },
      estimateHigh: { calories: "120" },
    });
    const overridden = successful(
      applyWorkingNutritionOverride(estimate, {
        expectedRevision: estimate.revision,
        override: { calories: "1000" },
      }),
    );

    expect(overridden.derivedNutrition.calories).toBe("100");
    expect(overridden.estimateLow).toEqual({ calories: "80" });
    expect(overridden.estimateHigh).toEqual({ calories: "120" });
    expect(overridden.workingNutrition.calories).toBe("1000");
  });

  it("requires paired optional nutrient bounds in estimate ranges", () => {
    expect(() =>
      entry({
        id: "invalid-estimate-range-1",
        nutrition: { calories: "100", protein: "10" },
        evidenceClass: "ESTIMATED",
        estimateLow: { calories: "80", protein: "5" },
        estimateHigh: { calories: "120" },
      }),
    ).toThrow(DomainValidationError);
  });

  it("preserves derived nutrition while applying a working override", () => {
    const source = entry({
      nutrition: { calories: "620", protein: "41" },
    });
    const overridden = successful(
      applyWorkingNutritionOverride(source, {
        expectedRevision: source.revision,
        override: { calories: "500" },
      }),
    );

    expect(overridden.derivedNutrition).toEqual({
      calories: "620",
      protein: "41",
    });
    expect(overridden.workingNutrition).toEqual({
      calories: "500",
      protein: "41",
    });
    expect(overridden.workingNutritionOverride).toEqual({ calories: "500" });
    expect(summarizeFoodDay(foodDay, [overridden]).confirmedCalories).toBe(
      "500",
    );
  });

  it("requires explicit preserve, clear, or replace behavior for quantity changes", () => {
    const source = successful(
      applyWorkingNutritionOverride(entry(), {
        expectedRevision: 1,
        override: { calories: "500" },
      }),
    );
    const preserved = successful(
      updateFoodEntryQuantity(source, {
        expectedRevision: source.revision,
        quantity: { amount: "2", unit: "SERVING" },
        overrideAction: { type: "PRESERVE" },
      }),
    );
    expect(preserved.derivedNutrition).toEqual({
      calories: "200",
      protein: "20",
    });
    expect(preserved.workingNutrition).toEqual({
      calories: "500",
      protein: "20",
    });

    const cleared = successful(
      updateFoodEntryQuantity(source, {
        expectedRevision: source.revision,
        quantity: { amount: "2", unit: "SERVING" },
        overrideAction: { type: "CLEAR" },
      }),
    );
    expect(cleared.workingNutrition).toEqual({
      calories: "200",
      protein: "20",
    });
    expect(cleared.workingNutritionOverride).toBeUndefined();

    const replaced = successful(
      updateFoodEntryQuantity(source, {
        expectedRevision: source.revision,
        quantity: { amount: "2", unit: "SERVING" },
        overrideAction: { type: "REPLACE", override: { calories: "333" } },
      }),
    );
    expect(replaced.workingNutrition).toEqual({
      calories: "333",
      protein: "20",
    });
    expect(replaced.workingNutritionOverride).toEqual({ calories: "333" });

    const directlyCleared = successful(
      clearWorkingNutritionOverride(preserved, {
        expectedRevision: preserved.revision,
      }),
    );
    expect(directlyCleared.workingNutrition).toEqual({
      calories: "200",
      protein: "20",
    });
  });

  it("scales estimate bounds with a quantity change and preserves an override", () => {
    const initial = entry({
      id: "scaled-estimate-1",
      quantity: { amount: "0.5", unit: "SERVING" },
      nutrition: { calories: "200" },
      evidenceClass: "ESTIMATED",
      estimateLow: { calories: "80" },
      estimateHigh: { calories: "120" },
    });
    const scaled = successful(
      updateFoodEntryQuantity(initial, {
        expectedRevision: initial.revision,
        quantity: { amount: "1", unit: "SERVING" },
        overrideAction: { type: "PRESERVE" },
      }),
    );

    expect(scaled.derivedNutrition).toEqual({ calories: "200" });
    expect(scaled.estimateLow).toEqual({ calories: "160" });
    expect(scaled.estimateHigh).toEqual({ calories: "240" });
    expect(scaled.workingNutrition).toEqual({ calories: "200" });

    const overridden = successful(
      applyWorkingNutritionOverride(initial, {
        expectedRevision: initial.revision,
        override: { calories: "1000" },
      }),
    );
    const scaledWithOverride = successful(
      updateFoodEntryQuantity(overridden, {
        expectedRevision: overridden.revision,
        quantity: { amount: "1", unit: "SERVING" },
        overrideAction: { type: "PRESERVE" },
      }),
    );
    expect(scaledWithOverride.derivedNutrition).toEqual({ calories: "200" });
    expect(scaledWithOverride.estimateLow).toEqual({ calories: "160" });
    expect(scaledWithOverride.estimateHigh).toEqual({ calories: "240" });
    expect(scaledWithOverride.workingNutrition).toEqual({ calories: "1000" });
  });

  it("changes planned food to confirmed consumption exactly once", () => {
    const plannedChicken = entry({ id: "chicken-1", status: "PLANNED" });
    const confirmed = successful(
      changeFoodEntryStatus(plannedChicken, {
        expectedRevision: plannedChicken.revision,
        status: "CONFIRMED_CONSUMED",
      }),
    );
    expect(confirmed.id).toBe(plannedChicken.id);
    expect(confirmed.revision).toBe(2);
    expect(summarizeFoodDay(foodDay, [confirmed]).confirmedCalories).toBe(
      "100",
    );
  });

  it("logically deletes and restores confirmed food", () => {
    const source = entry();
    expect(summarizeFoodDay(foodDay, [source]).confirmedCalories).toBe("100");
    const deleted = successful(
      deleteFoodEntry(source, {
        expectedRevision: source.revision,
        deletedAt: "2026-08-31T00:00:00Z",
      }),
    );
    expect(summarizeFoodDay(foodDay, [deleted]).confirmedCalories).toBe("0");
    const restored = successful(
      restoreFoodEntry(deleted, { expectedRevision: deleted.revision }),
    );
    expect(restored.revision).toBe(3);
    expect(summarizeFoodDay(foodDay, [restored]).confirmedCalories).toBe("100");
  });

  it("returns a typed conflict and leaves the current entry unchanged for stale revisions", () => {
    const source = entry();
    const first = successful(
      changeFoodEntryStatus(source, {
        expectedRevision: source.revision,
        status: "PLANNED",
      }),
    );
    const stale = changeFoodEntryStatus(first, {
      expectedRevision: source.revision,
      status: "DISCARDED",
    });

    expect(stale).toEqual({
      ok: false,
      error: {
        type: "REVISION_CONFLICT",
        entryId: source.id,
        expectedRevision: 1,
        actualRevision: 2,
      },
    });
    expect(first.status).toBe("PLANNED");
  });
});
