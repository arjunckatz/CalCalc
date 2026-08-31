import { z } from "zod";

import { DomainValidationError } from "../errors.js";
import { normalizeDecimal, type DecimalString } from "../nutrition/decimal.js";
import type {
  Nutrition,
  NutritionBasis,
  NutritionOverride,
  Quantity,
} from "../nutrition/types.js";

export const foodEntryStatuses = [
  "CONFIRMED_CONSUMED",
  "PLANNED",
  "CONSIDERED",
  "DISCARDED",
] as const;

export type FoodEntryStatus = (typeof foodEntryStatuses)[number];

export const foodDayStatuses = ["OPEN", "CLOSED", "PROVISIONAL"] as const;

export type FoodDayStatus = (typeof foodDayStatuses)[number];

export const evidenceClasses = ["EXACT", "SOURCED", "ESTIMATED"] as const;

export type EvidenceClass = (typeof evidenceClasses)[number];

export interface FoodDay {
  readonly id: string;
  readonly status: FoodDayStatus;
  readonly calorieTarget: DecimalString;
  readonly proteinTarget: DecimalString;
  readonly maintenanceSnapshot?: DecimalString;
  readonly goalVersionId?: string;
}

export interface FoodEntry {
  readonly id: string;
  readonly foodDayId: string;
  readonly rawUserDescription: string;
  readonly displayName: string;
  readonly normalizedName?: string | undefined;
  readonly brand?: string | undefined;
  readonly quantity: Quantity;
  readonly nutritionBasis: NutritionBasis;
  readonly derivedNutrition: Nutrition;
  readonly workingNutrition: Nutrition;
  readonly workingNutritionOverride?: NutritionOverride | undefined;
  readonly evidenceClass: EvidenceClass;
  readonly estimateLow?: Nutrition | undefined;
  readonly estimateHigh?: Nutrition | undefined;
  readonly status: FoodEntryStatus;
  /** Revisions start at 1 and increase once per successful meaningful mutation. */
  readonly revision: number;
  readonly deletedAt?: string | undefined;
}

const foodDayInputSchema = z.object({
  id: z.string().trim().min(1),
  status: z.enum(foodDayStatuses),
  calorieTarget: z.string(),
  proteinTarget: z.string(),
  maintenanceSnapshot: z.string().optional(),
  goalVersionId: z.string().trim().min(1).optional(),
});

export function createFoodDay(input: {
  readonly id: string;
  readonly status: FoodDayStatus;
  readonly calorieTarget: string;
  readonly proteinTarget: string;
  readonly maintenanceSnapshot?: string;
  readonly goalVersionId?: string;
}): FoodDay {
  const result = foodDayInputSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => issue.message);
    throw new DomainValidationError(`food day: ${issues.join("; ")}`, issues);
  }

  return {
    id: result.data.id,
    status: result.data.status,
    calorieTarget: normalizeDecimal(result.data.calorieTarget, {
      label: "food day calorie target",
    }),
    proteinTarget: normalizeDecimal(result.data.proteinTarget, {
      label: "food day protein target",
    }),
    ...(result.data.maintenanceSnapshot === undefined
      ? {}
      : {
          maintenanceSnapshot: normalizeDecimal(
            result.data.maintenanceSnapshot,
            { label: "food day maintenance snapshot" },
          ),
        }),
    ...(result.data.goalVersionId === undefined
      ? {}
      : { goalVersionId: result.data.goalVersionId }),
  };
}
