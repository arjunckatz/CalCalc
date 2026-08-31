import { z } from "zod";

import {
  DomainValidationError,
  type MutationResult,
  type RevisionConflict,
} from "../errors.js";
import { calculateNutrition } from "../nutrition/calculate.js";
import { compareDecimals } from "../nutrition/decimal.js";
import {
  parseNutrition,
  parseNutritionBasis,
  parseNutritionOverride,
  parseQuantity,
  type Nutrition,
  type NutritionBasis,
  type NutritionOverride,
  type Quantity,
} from "../nutrition/types.js";
import {
  evidenceClasses,
  foodEntryStatuses,
  type EvidenceClass,
  type FoodEntry,
  type FoodEntryStatus,
} from "./types.js";

const entryTextSchema = z.object({
  rawUserDescription: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  normalizedName: z.string().trim().min(1).optional(),
  brand: z.string().trim().min(1).optional(),
});

export interface FoodEntryContentInput {
  readonly rawUserDescription: string;
  readonly displayName: string;
  readonly normalizedName?: string;
  readonly brand?: string;
  readonly quantity: Quantity;
  readonly nutritionBasis: NutritionBasis;
  readonly evidenceClass: EvidenceClass;
  readonly estimateLow?: Nutrition;
  readonly estimateHigh?: Nutrition;
  readonly status: FoodEntryStatus;
  readonly workingNutritionOverride?: NutritionOverride;
}

export interface CreateFoodEntryInput extends FoodEntryContentInput {
  readonly id: string;
  readonly foodDayId: string;
}

interface PreparedContent {
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
}

export type QuantityOverrideAction =
  | { readonly type: "PRESERVE" }
  | { readonly type: "CLEAR" }
  | { readonly type: "REPLACE"; readonly override: NutritionOverride };

export function createFoodEntry(input: CreateFoodEntryInput): FoodEntry {
  const identity = z
    .object({
      id: z.string().trim().min(1),
      foodDayId: z.string().trim().min(1),
    })
    .safeParse(input);
  if (!identity.success) {
    throw validationFromZod("food entry identity", identity.error);
  }

  return {
    id: identity.data.id,
    foodDayId: identity.data.foodDayId,
    ...prepareContent(input),
    revision: 1,
  };
}

export function updateFoodEntryQuantity(
  entry: FoodEntry,
  input: {
    readonly expectedRevision: number;
    readonly quantity: Quantity;
    readonly overrideAction: QuantityOverrideAction;
  },
): MutationResult<FoodEntry> {
  const conflict = checkRevision(entry, input.expectedRevision);
  if (conflict !== undefined) return { ok: false, error: conflict };

  const quantity = parseQuantity(input.quantity);
  const derivedNutrition = calculateNutrition(entry.nutritionBasis, quantity);
  const override = resolveQuantityOverride(entry, input.overrideAction);
  const workingNutrition = mergeWorkingNutrition(derivedNutrition, override);
  const estimates = scaleEstimateRange(entry, quantity, derivedNutrition);

  return success(entry, {
    quantity,
    derivedNutrition,
    workingNutrition,
    ...estimates,
    ...(override === undefined
      ? { workingNutritionOverride: undefined }
      : { workingNutritionOverride: override }),
  });
}

function scaleEstimateRange(
  entry: FoodEntry,
  quantity: Quantity,
  derivedNutrition: Nutrition,
): Pick<FoodEntry, "estimateLow" | "estimateHigh"> {
  if (entry.estimateLow === undefined && entry.estimateHigh === undefined) {
    return {};
  }
  if (entry.estimateLow === undefined || entry.estimateHigh === undefined) {
    throw new DomainValidationError(
      "Both estimateLow and estimateHigh must be present on an estimated entry.",
    );
  }

  const low = calculateNutrition(
    {
      amount: entry.quantity.amount,
      unit: entry.quantity.unit,
      nutrition: entry.estimateLow,
    },
    quantity,
  );
  const high = calculateNutrition(
    {
      amount: entry.quantity.amount,
      unit: entry.quantity.unit,
      nutrition: entry.estimateHigh,
    },
    quantity,
  );
  return parseEstimateRange(entry.evidenceClass, low, high, derivedNutrition);
}

export function replaceFoodEntry(
  entry: FoodEntry,
  input: FoodEntryContentInput & { readonly expectedRevision: number },
): MutationResult<FoodEntry> {
  const conflict = checkRevision(entry, input.expectedRevision);
  if (conflict !== undefined) return { ok: false, error: conflict };

  const replacement = prepareContent(input);
  return success(entry, {
    ...replacement,
    normalizedName: replacement.normalizedName,
    brand: replacement.brand,
    workingNutritionOverride: replacement.workingNutritionOverride,
    estimateLow: replacement.estimateLow,
    estimateHigh: replacement.estimateHigh,
  });
}

export function changeFoodEntryStatus(
  entry: FoodEntry,
  input: {
    readonly expectedRevision: number;
    readonly status: FoodEntryStatus;
  },
): MutationResult<FoodEntry> {
  const conflict = checkRevision(entry, input.expectedRevision);
  if (conflict !== undefined) return { ok: false, error: conflict };
  const status = z.enum(foodEntryStatuses).safeParse(input.status);
  if (!status.success)
    throw validationFromZod("food entry status", status.error);
  if (status.data === entry.status) {
    throw new DomainValidationError("Food entry status did not change.");
  }
  return success(entry, { status: status.data });
}

export function applyWorkingNutritionOverride(
  entry: FoodEntry,
  input: {
    readonly expectedRevision: number;
    readonly override: NutritionOverride;
  },
): MutationResult<FoodEntry> {
  const conflict = checkRevision(entry, input.expectedRevision);
  if (conflict !== undefined) return { ok: false, error: conflict };
  const override = parseNutritionOverride(input.override);
  return success(entry, {
    workingNutritionOverride: override,
    workingNutrition: mergeWorkingNutrition(entry.derivedNutrition, override),
  });
}

export function clearWorkingNutritionOverride(
  entry: FoodEntry,
  input: { readonly expectedRevision: number },
): MutationResult<FoodEntry> {
  const conflict = checkRevision(entry, input.expectedRevision);
  if (conflict !== undefined) return { ok: false, error: conflict };
  if (entry.workingNutritionOverride === undefined) {
    throw new DomainValidationError(
      "Food entry has no working nutrition override.",
    );
  }
  return success(entry, {
    workingNutritionOverride: undefined,
    workingNutrition: { ...entry.derivedNutrition },
  });
}

export function deleteFoodEntry(
  entry: FoodEntry,
  input: { readonly expectedRevision: number; readonly deletedAt: string },
): MutationResult<FoodEntry> {
  const conflict = checkRevision(entry, input.expectedRevision);
  if (conflict !== undefined) return { ok: false, error: conflict };
  if (entry.deletedAt !== undefined) {
    throw new DomainValidationError("Food entry is already deleted.");
  }
  const deletedAt = z.iso.datetime({ offset: true }).safeParse(input.deletedAt);
  if (!deletedAt.success) throw validationFromZod("deletedAt", deletedAt.error);
  return success(entry, { deletedAt: deletedAt.data });
}

export function restoreFoodEntry(
  entry: FoodEntry,
  input: { readonly expectedRevision: number },
): MutationResult<FoodEntry> {
  const conflict = checkRevision(entry, input.expectedRevision);
  if (conflict !== undefined) return { ok: false, error: conflict };
  if (entry.deletedAt === undefined) {
    throw new DomainValidationError("Food entry is not deleted.");
  }
  return success(entry, { deletedAt: undefined });
}

function prepareContent(input: FoodEntryContentInput): PreparedContent {
  const text = entryTextSchema.safeParse(input);
  if (!text.success) throw validationFromZod("food entry", text.error);
  const evidenceClass = z.enum(evidenceClasses).safeParse(input.evidenceClass);
  const status = z.enum(foodEntryStatuses).safeParse(input.status);
  if (!evidenceClass.success) {
    throw validationFromZod("evidence class", evidenceClass.error);
  }
  if (!status.success)
    throw validationFromZod("food entry status", status.error);

  const quantity = parseQuantity(input.quantity);
  const nutritionBasis = parseNutritionBasis(input.nutritionBasis);
  const derivedNutrition = calculateNutrition(nutritionBasis, quantity);
  const override =
    input.workingNutritionOverride === undefined
      ? undefined
      : parseNutritionOverride(input.workingNutritionOverride);
  const estimates = parseEstimateRange(
    evidenceClass.data,
    input.estimateLow,
    input.estimateHigh,
    derivedNutrition,
  );

  return {
    rawUserDescription: text.data.rawUserDescription,
    displayName: text.data.displayName,
    ...(text.data.normalizedName === undefined
      ? {}
      : { normalizedName: text.data.normalizedName }),
    ...(text.data.brand === undefined ? {} : { brand: text.data.brand }),
    quantity,
    nutritionBasis,
    derivedNutrition,
    workingNutrition: mergeWorkingNutrition(derivedNutrition, override),
    ...(override === undefined ? {} : { workingNutritionOverride: override }),
    evidenceClass: evidenceClass.data,
    ...estimates,
    status: status.data,
  };
}

function parseEstimateRange(
  evidenceClass: EvidenceClass,
  lowInput: Nutrition | undefined,
  highInput: Nutrition | undefined,
  derived: Nutrition,
): Pick<FoodEntry, "estimateLow" | "estimateHigh"> {
  if (lowInput === undefined && highInput === undefined) return {};
  if (evidenceClass !== "ESTIMATED") {
    throw new DomainValidationError(
      "Estimate bounds are only valid for ESTIMATED evidence.",
    );
  }
  if (lowInput === undefined || highInput === undefined) {
    throw new DomainValidationError(
      "Both estimateLow and estimateHigh must be provided together.",
    );
  }

  const low = parseNutrition(lowInput, "estimateLow");
  const high = parseNutrition(highInput, "estimateHigh");
  for (const nutrient of [
    "calories",
    "protein",
    "carbs",
    "fat",
    "fibre",
    "sodium",
  ] as const) {
    const lowValue = low[nutrient];
    const highValue = high[nutrient];
    if (lowValue === undefined && highValue === undefined) {
      continue;
    }
    if (lowValue === undefined || highValue === undefined) {
      throw new DomainValidationError(
        `estimate bounds for ${nutrient} require both low and high values.`,
      );
    }
    if (compareDecimals(lowValue, highValue) > 0) {
      throw new DomainValidationError(
        `estimateLow.${nutrient} exceeds estimateHigh.${nutrient}.`,
      );
    }
    const derivedValue = derived[nutrient];
    if (
      derivedValue !== undefined &&
      (compareDecimals(derivedValue, lowValue) < 0 ||
        compareDecimals(derivedValue, highValue) > 0)
    ) {
      throw new DomainValidationError(
        `derivedNutrition.${nutrient} is outside the estimate range.`,
      );
    }
  }
  return { estimateLow: low, estimateHigh: high };
}

function resolveQuantityOverride(
  entry: FoodEntry,
  action: QuantityOverrideAction,
): NutritionOverride | undefined {
  switch (action.type) {
    case "PRESERVE":
      return entry.workingNutritionOverride === undefined
        ? undefined
        : { ...entry.workingNutritionOverride };
    case "CLEAR":
      return undefined;
    case "REPLACE":
      return parseNutritionOverride(action.override);
  }
}

function mergeWorkingNutrition(
  derived: Nutrition,
  override: NutritionOverride | undefined,
): Nutrition {
  return parseNutrition({ ...derived, ...override }, "working nutrition");
}

function checkRevision(
  entry: FoodEntry,
  expectedRevision: number,
): RevisionConflict | undefined {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new DomainValidationError(
      "expectedRevision must be a positive integer.",
    );
  }
  if (expectedRevision === entry.revision) return undefined;
  return {
    type: "REVISION_CONFLICT",
    entryId: entry.id,
    expectedRevision,
    actualRevision: entry.revision,
  };
}

function success(
  entry: FoodEntry,
  patch: Partial<FoodEntry>,
): MutationResult<FoodEntry> {
  return {
    ok: true,
    value: { ...entry, ...patch, revision: entry.revision + 1 },
  };
}

function validationFromZod(
  label: string,
  error: z.ZodError,
): DomainValidationError {
  const issues = error.issues.map((issue) => issue.message);
  return new DomainValidationError(`${label}: ${issues.join("; ")}`, issues);
}
