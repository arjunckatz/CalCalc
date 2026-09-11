import type {
  FoodEntry,
  Nutrition,
  NutritionBasis,
  Quantity,
} from "@cal-calc/domain";

export interface FoodEntryDto {
  readonly id: string;
  readonly foodDayId: string;
  readonly rawUserDescription: string;
  readonly displayName: string;
  readonly quantity: Quantity;
  readonly nutritionBasis: NutritionBasis;
  readonly derivedNutrition: Nutrition;
  readonly workingNutrition: Nutrition;
  readonly evidenceClass: FoodEntry["evidenceClass"];
  readonly status: FoodEntry["status"];
  readonly revision: number;
  readonly deletedAt: string | null;
}

export function toFoodEntryDto(entry: FoodEntry): FoodEntryDto {
  return {
    id: entry.id,
    foodDayId: entry.foodDayId,
    rawUserDescription: entry.rawUserDescription,
    displayName: entry.displayName,
    quantity: { amount: entry.quantity.amount, unit: entry.quantity.unit },
    nutritionBasis: {
      amount: entry.nutritionBasis.amount,
      unit: entry.nutritionBasis.unit,
      nutrition: nutritionDto(entry.nutritionBasis.nutrition),
    },
    derivedNutrition: nutritionDto(entry.derivedNutrition),
    workingNutrition: nutritionDto(entry.workingNutrition),
    evidenceClass: entry.evidenceClass,
    status: entry.status,
    revision: entry.revision,
    deletedAt: entry.deletedAt ?? null,
  };
}

function nutritionDto(value: Nutrition): Nutrition {
  return {
    calories: value.calories,
    ...(value.protein === undefined ? {} : { protein: value.protein }),
    ...(value.carbs === undefined ? {} : { carbs: value.carbs }),
    ...(value.fat === undefined ? {} : { fat: value.fat }),
    ...(value.fibre === undefined ? {} : { fibre: value.fibre }),
    ...(value.sodium === undefined ? {} : { sodium: value.sodium }),
  };
}
