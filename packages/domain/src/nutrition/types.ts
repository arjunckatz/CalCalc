import { z } from "zod";

import { DomainValidationError } from "../errors.js";
import { normalizeDecimal, type DecimalString } from "./decimal.js";

export const measurementUnits = [
  "GRAM",
  "MILLILITRE",
  "SERVING",
  "CONTAINER",
] as const;

export type MeasurementUnit = (typeof measurementUnits)[number];

export interface Quantity {
  readonly amount: DecimalString;
  readonly unit: MeasurementUnit;
}

export interface Nutrition {
  readonly calories: DecimalString;
  readonly protein?: DecimalString;
  readonly carbs?: DecimalString;
  readonly fat?: DecimalString;
  readonly fibre?: DecimalString;
  readonly sodium?: DecimalString;
}

export type NutritionOverride = Partial<Nutrition>;

export interface NutritionBasis {
  readonly amount: DecimalString;
  readonly unit: MeasurementUnit;
  readonly nutrition: Nutrition;
}

export interface NutritionEstimateRange {
  readonly low: Nutrition;
  readonly high: Nutrition;
}

const quantityInputSchema = z.object({
  amount: z.string(),
  unit: z.enum(measurementUnits),
});

const nutritionInputSchema = z
  .object({
    calories: z.string(),
    protein: z.string().optional(),
    carbs: z.string().optional(),
    fat: z.string().optional(),
    fibre: z.string().optional(),
    sodium: z.string().optional(),
  })
  .strict();

const nutritionOverrideInputSchema = nutritionInputSchema.partial();

const nutritionBasisInputSchema = z.object({
  amount: z.string(),
  unit: z.enum(measurementUnits),
  nutrition: nutritionInputSchema,
});

function fromZodError(label: string, error: z.ZodError): DomainValidationError {
  const issues = error.issues.map((issue) => issue.message);
  return new DomainValidationError(`${label}: ${issues.join("; ")}`, issues);
}

export function parseQuantity(input: unknown, label = "quantity"): Quantity {
  const result = quantityInputSchema.safeParse(input);
  if (!result.success) {
    throw fromZodError(label, result.error);
  }

  return {
    amount: normalizeDecimal(result.data.amount, {
      label: `${label}.amount`,
      allowZero: false,
    }),
    unit: result.data.unit,
  };
}

export function parseNutrition(input: unknown, label = "nutrition"): Nutrition {
  const result = nutritionInputSchema.safeParse(input);
  if (!result.success) {
    throw fromZodError(label, result.error);
  }

  return normalizeNutrition(result.data, label);
}

export function parseNutritionOverride(
  input: unknown,
  label = "nutrition override",
): NutritionOverride {
  const result = nutritionOverrideInputSchema.safeParse(input);
  if (!result.success) {
    throw fromZodError(label, result.error);
  }
  if (Object.keys(result.data).length === 0) {
    throw new DomainValidationError(
      `${label}: at least one nutrient is required`,
    );
  }

  return normalizeNutritionFields(result.data, label);
}

export function parseNutritionBasis(
  input: unknown,
  label = "nutrition basis",
): NutritionBasis {
  const result = nutritionBasisInputSchema.safeParse(input);
  if (!result.success) {
    throw fromZodError(label, result.error);
  }

  return {
    amount: normalizeDecimal(result.data.amount, {
      label: `${label}.amount`,
      allowZero: false,
    }),
    unit: result.data.unit,
    nutrition: normalizeNutrition(result.data.nutrition, `${label}.nutrition`),
  };
}

function normalizeNutrition(
  nutrition: z.infer<typeof nutritionInputSchema>,
  label: string,
): Nutrition {
  return {
    calories: normalizeDecimal(nutrition.calories, {
      label: `${label}.calories`,
    }),
    ...normalizeOptionalNutrients(nutrition, label),
  };
}

function normalizeNutritionFields(
  nutrition: z.infer<typeof nutritionOverrideInputSchema>,
  label: string,
): NutritionOverride {
  const normalized: Record<string, DecimalString> = {};
  for (const [key, value] of Object.entries(nutrition)) {
    if (value !== undefined) {
      normalized[key] = normalizeDecimal(value, { label: `${label}.${key}` });
    }
  }
  return normalized;
}

function normalizeOptionalNutrients(
  nutrition: z.infer<typeof nutritionInputSchema>,
  label: string,
): Omit<Nutrition, "calories"> {
  return normalizeNutritionFields(
    {
      protein: nutrition.protein,
      carbs: nutrition.carbs,
      fat: nutrition.fat,
      fibre: nutrition.fibre,
      sodium: nutrition.sodium,
    },
    label,
  );
}
