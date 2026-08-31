import { DomainValidationError } from "../errors.js";
import {
  addDecimals,
  subtractDecimals,
  type DecimalString,
} from "../nutrition/decimal.js";
import type { FoodDay, FoodEntry } from "./types.js";

export interface FoodDaySummary {
  readonly confirmedCalories: DecimalString;
  readonly confirmedProtein: DecimalString;
  readonly hasUnknownProtein: boolean;
  readonly calorieTarget: DecimalString;
  readonly proteinTarget: DecimalString;
  readonly remainingCalories: DecimalString;
}

/** Only confirmed, non-deleted entries count; totals use working nutrition. */
export function summarizeFoodDay(
  foodDay: FoodDay,
  entries: readonly FoodEntry[],
): FoodDaySummary {
  let confirmedCalories = "0";
  let confirmedProtein = "0";
  let hasUnknownProtein = false;

  for (const entry of entries) {
    if (entry.foodDayId !== foodDay.id) {
      throw new DomainValidationError(
        `Food entry ${entry.id} does not belong to food day ${foodDay.id}.`,
      );
    }
    if (
      entry.status !== "CONFIRMED_CONSUMED" ||
      entry.deletedAt !== undefined
    ) {
      continue;
    }

    confirmedCalories = addDecimals(
      confirmedCalories,
      entry.workingNutrition.calories,
    );
    if (entry.workingNutrition.protein === undefined) {
      hasUnknownProtein = true;
    } else {
      confirmedProtein = addDecimals(
        confirmedProtein,
        entry.workingNutrition.protein,
      );
    }
  }

  return {
    confirmedCalories,
    confirmedProtein,
    hasUnknownProtein,
    calorieTarget: foodDay.calorieTarget,
    proteinTarget: foodDay.proteinTarget,
    remainingCalories: subtractDecimals(
      foodDay.calorieTarget,
      confirmedCalories,
    ),
  };
}
