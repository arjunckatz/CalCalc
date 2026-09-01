import {
  applyWorkingNutritionOverride,
  createFoodDay,
  createFoodEntry,
  deleteFoodEntry,
  type FoodEntry,
  type MutationResult,
} from "@cal-calc/domain";
import { describe, expect, it } from "vitest";

import {
  fromFoodDayRow,
  fromFoodEntryRow,
  toFoodDayRow,
  toFoodEntryRevisionRow,
  toFoodEntryRow,
} from "./index.js";

const userId = "10000000-0000-4000-8000-000000000001";
const foodDayId = "20000000-0000-4000-8000-000000000001";
const entryId = "30000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-01T00:00:00.000Z";

function successful<Value>(result: MutationResult<Value>): Value {
  if (!result.ok) throw new Error(`Unexpected conflict: ${result.error.type}`);
  return result.value;
}

function exactEntry(
  overrides: Partial<{
    status: "CONFIRMED_CONSUMED" | "PLANNED";
    nutrition: { calories: string; protein?: string };
    quantityAmount: string;
    basisAmount: string;
  }> = {},
): FoodEntry {
  return createFoodEntry({
    id: entryId,
    foodDayId,
    rawUserDescription: "275 g label food",
    displayName: "Label food",
    quantity: {
      amount: overrides.quantityAmount ?? "275",
      unit: "GRAM",
    },
    nutritionBasis: {
      amount: overrides.basisAmount ?? "100",
      unit: "GRAM",
      nutrition: overrides.nutrition ?? {
        calories: "249.13",
        protein: "14.91",
      },
    },
    evidenceClass: "EXACT",
    status: overrides.status ?? "CONFIRMED_CONSUMED",
  });
}

function estimatedEntry(): FoodEntry {
  return createFoodEntry({
    id: entryId,
    foodDayId,
    rawUserDescription: "half a kalakand",
    displayName: "Half kalakand",
    quantity: { amount: "0.5", unit: "SERVING" },
    nutritionBasis: {
      amount: "1",
      unit: "SERVING",
      nutrition: { calories: "200" },
    },
    evidenceClass: "ESTIMATED",
    estimateLow: { calories: "80" },
    estimateHigh: { calories: "120" },
    status: "CONFIRMED_CONSUMED",
  });
}

function entryRow(entry: FoodEntry) {
  return toFoodEntryRow(entry, {
    userId,
    reportedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

describe("food entry persistence mapping", () => {
  it("round-trips an EXACT entry without decimal corruption", () => {
    const entry = exactEntry();
    const row = entryRow(entry);
    const restored = fromFoodEntryRow(row);

    expect(entry.derivedNutrition).toEqual({
      calories: "685.1075",
      protein: "41.0025",
    });
    expect(JSON.stringify(row)).toContain('"calories":"685.1075"');
    expect(restored.entry).toEqual(entry);
  });

  it("round-trips an ESTIMATED entry with low and high bounds", () => {
    const entry = estimatedEntry();

    const restored = fromFoodEntryRow(entryRow(entry)).entry;
    expect(restored.evidenceClass).toBe("ESTIMATED");
    expect(restored.estimateLow).toEqual({ calories: "80" });
    expect(restored.estimateHigh).toEqual({ calories: "120" });
  });

  it("rejects a stored estimate whose low value exceeds its high value", () => {
    const row = entryRow(estimatedEntry());

    expect(() =>
      fromFoodEntryRow({
        ...row,
        estimate_low: { calories: "110" },
        estimate_high: { calories: "90" },
      }),
    ).toThrow("estimateLow.calories exceeds estimateHigh.calories");
  });

  it("rejects stored derived nutrition outside its estimate bounds", () => {
    const row = entryRow(estimatedEntry());

    expect(() =>
      fromFoodEntryRow({
        ...row,
        estimate_low: { calories: "80" },
        estimate_high: { calories: "90" },
      }),
    ).toThrow("derivedNutrition.calories is outside the estimate range");
  });

  it("rejects unpaired optional nutrients in stored estimate bounds", () => {
    const row = entryRow(estimatedEntry());

    expect(() =>
      fromFoodEntryRow({
        ...row,
        estimate_low: { calories: "80", protein: "1" },
        estimate_high: { calories: "120" },
      }),
    ).toThrow("estimate bounds for protein require both low and high values");
  });

  it("preserves a working override separately from derived nutrition", () => {
    const source = createFoodEntry({
      id: entryId,
      foodDayId,
      rawUserDescription: "restaurant meal",
      displayName: "Restaurant meal",
      quantity: { amount: "1", unit: "SERVING" },
      nutritionBasis: {
        amount: "1",
        unit: "SERVING",
        nutrition: { calories: "620", protein: "41" },
      },
      evidenceClass: "SOURCED",
      status: "CONFIRMED_CONSUMED",
    });
    const overridden = successful(
      applyWorkingNutritionOverride(source, {
        expectedRevision: source.revision,
        override: { calories: "500" },
      }),
    );

    const restored = fromFoodEntryRow(entryRow(overridden)).entry;
    expect(restored.derivedNutrition).toEqual({
      calories: "620",
      protein: "41",
    });
    expect(restored.workingNutritionOverride).toEqual({ calories: "500" });
    expect(restored.workingNutrition).toEqual({
      calories: "500",
      protein: "41",
    });
  });

  it("keeps unknown optional protein absent rather than storing zero", () => {
    const entry = exactEntry({ nutrition: { calories: "100" } });
    const row = entryRow(entry);
    const restored = fromFoodEntryRow(row).entry;

    expect(row.working_nutrition.protein).toBeUndefined();
    expect(restored.workingNutrition.protein).toBeUndefined();
    expect("protein" in restored.workingNutrition).toBe(false);
  });

  it.each(["PLANNED", "CONFIRMED_CONSUMED"] as const)(
    "preserves the %s status",
    (status) => {
      const restored = fromFoodEntryRow(entryRow(exactEntry({ status }))).entry;
      expect(restored.status).toBe(status);
    },
  );

  it("preserves logical deletion and revision numbers", () => {
    const entry = exactEntry();
    const deleted = successful(
      deleteFoodEntry(entry, {
        expectedRevision: entry.revision,
        deletedAt: timestamp,
      }),
    );
    const row = entryRow(deleted);
    const restored = fromFoodEntryRow(row).entry;
    const revision = toFoodEntryRevisionRow(row, {
      revisionId: "40000000-0000-4000-8000-000000000001",
      operationId: "50000000-0000-4000-8000-000000000001",
      createdAt: timestamp,
    });

    expect(restored.deletedAt).toBe(timestamp);
    expect(restored.revision).toBe(2);
    expect(revision.revision).toBe(2);
    expect(revision.snapshot).toEqual(row);
  });

  it("rejects a stored revision 1 entry with a deletion timestamp", () => {
    const row = entryRow(exactEntry());

    expect(() =>
      fromFoodEntryRow({
        ...row,
        deleted_at: timestamp,
      }),
    ).toThrow("Stored deleted food entry revision must be at least 2");
  });
});

describe("food day persistence mapping", () => {
  it("preserves target snapshots and logging completeness", () => {
    const foodDay = createFoodDay({
      id: foodDayId,
      status: "PROVISIONAL",
      calorieTarget: "2100",
      proteinTarget: "120",
      maintenanceSnapshot: "2400",
      goalVersionId: "goal-version-7",
    });
    const row = toFoodDayRow(foodDay, {
      userId,
      completeness: "PARTIAL",
      localDate: "2026-09-01",
      timezone: "Asia/Calcutta",
      openedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const restored = fromFoodDayRow(row);

    expect(restored.foodDay).toEqual(foodDay);
    expect(restored.foodDay.calorieTarget).toBe("2100");
    expect(restored.foodDay.maintenanceSnapshot).toBe("2400");
    expect(restored.completeness).toBe("PARTIAL");
    expect(restored.localDate).toBe("2026-09-01");
  });
});
