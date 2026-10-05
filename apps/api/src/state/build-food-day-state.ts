import {
  compareDecimals,
  subtractDecimals,
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
  /** Exact progress against targets using only confirmed-consumed totals. */
  readonly targetProgress: {
    readonly calories: {
      readonly remainingToTarget: string;
      readonly overTargetBy: string;
    };
    readonly protein: {
      /** Null when any confirmed entry has unknown protein. */
      readonly remainingToTarget: string | null;
      readonly overTargetBy: string | null;
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
  const confirmed: FoodDayState["totals"]["confirmed"] = {
    calories: summary.confirmedCalories,
    protein: summary.hasUnknownProtein ? null : summary.confirmedProtein,
    hasUnknownProtein: summary.hasUnknownProtein,
  };
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
    totals: { confirmed },
    targetProgress: {
      calories: progressForTarget(foodDay.calorieTarget, confirmed.calories),
      protein:
        confirmed.protein === null
          ? { remainingToTarget: null, overTargetBy: null }
          : progressForTarget(foodDay.proteinTarget, confirmed.protein),
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

function progressForTarget(target: string, confirmed: string) {
  const comparison = compareDecimals(confirmed, target);
  if (comparison < 0) {
    return {
      remainingToTarget: subtractDecimals(target, confirmed),
      overTargetBy: "0",
    };
  }
  if (comparison > 0) {
    return {
      remainingToTarget: "0",
      overTargetBy: subtractDecimals(confirmed, target),
    };
  }
  return { remainingToTarget: "0", overTargetBy: "0" };
}
