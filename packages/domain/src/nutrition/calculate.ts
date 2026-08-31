import { IncompatibleUnitError } from "../errors.js";
import { scaleDecimal } from "./decimal.js";
import {
  parseNutritionBasis,
  parseQuantity,
  type Nutrition,
  type NutritionBasis,
  type Quantity,
} from "./types.js";

const optionalNutrients = [
  "protein",
  "carbs",
  "fat",
  "fibre",
  "sodium",
] as const;

export function calculateNutrition(
  basisInput: NutritionBasis,
  quantityInput: Quantity,
): Nutrition {
  const basis = parseNutritionBasis(basisInput);
  const quantity = parseQuantity(quantityInput);

  if (basis.unit !== quantity.unit) {
    throw new IncompatibleUnitError(basis.unit, quantity.unit);
  }

  const calculated: {
    calories: string;
    protein?: string;
    carbs?: string;
    fat?: string;
    fibre?: string;
    sodium?: string;
  } = {
    calories: scaleDecimal(
      basis.nutrition.calories,
      quantity.amount,
      basis.amount,
    ),
  };

  for (const nutrient of optionalNutrients) {
    const value = basis.nutrition[nutrient];
    if (value !== undefined) {
      calculated[nutrient] = scaleDecimal(value, quantity.amount, basis.amount);
    }
  }

  return calculated;
}
