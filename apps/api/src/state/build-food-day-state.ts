import {
  summarizeFoodDay,
  type FoodDay,
  type FoodEntry,
  type Nutrition,
  type Quantity,
} from "@cal-calc/domain";
import type { FoodDayCompleteness } from "@cal-calc/persistence";

export interface BuildFoodDayStateInput {
  readonly foodDay: FoodDay;
  readonly entries: readonly FoodEntry[];
  readonly completeness: FoodDayCompleteness;
  readonly localDate: string | null;
}

export interface FoodDayState {
  readonly foodDay: {
    readonly id: string;
    readonly localDate: string | null;
    readonly status: FoodDay["status"];
    readonly completeness: FoodDayCompleteness;
    readonly targets: {
      readonly calories: string;
      readonly protein: string;
    };
  };
  readonly totals: {
    readonly confirmed: {
      readonly calories: string;
      /** Null means at least one confirmed entry has unknown protein. */
      readonly protein: string | null;
      readonly hasUnknownProtein: boolean;
    };
  };
  readonly entries: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly rawUserDescription: string;
    readonly quantity: Quantity;
    readonly status: FoodEntry["status"];
    readonly workingNutrition: Nutrition;
    readonly evidenceClass: FoodEntry["evidenceClass"];
    readonly revision: number;
  }[];
}

/** Pure factual projection of one canonical, active FoodDay inspection result. */
export function buildFoodDayState(input: BuildFoodDayStateInput): FoodDayState {
  const { foodDay, entries, completeness, localDate } = input;
  const summary = summarizeFoodDay(foodDay, entries);
  return {
    foodDay: {
      id: foodDay.id,
      localDate,
      status: foodDay.status,
      completeness,
      targets: {
        calories: foodDay.calorieTarget,
        protein: foodDay.proteinTarget,
      },
    },
    totals: {
      confirmed: {
        calories: summary.confirmedCalories,
        protein: summary.hasUnknownProtein ? null : summary.confirmedProtein,
        hasUnknownProtein: summary.hasUnknownProtein,
      },
    },
    entries: entries.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      rawUserDescription: entry.rawUserDescription,
      quantity: { ...entry.quantity },
      status: entry.status,
      workingNutrition: { ...entry.workingNutrition },
      evidenceClass: entry.evidenceClass,
      revision: entry.revision,
    })),
  };
}
