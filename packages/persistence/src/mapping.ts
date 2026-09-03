import {
  createFoodDay,
  createFoodEntry,
  deleteFoodEntry,
  DomainValidationError,
  parseNutrition,
  type FoodDay,
  type FoodEntry,
  type Nutrition,
} from "@cal-calc/domain";

import type {
  FoodDayCompleteness,
  FoodDayRow,
  FoodEntryRevisionRow,
  FoodEntryRow,
  PersistedFoodDay,
  PersistedFoodEntry,
} from "./types.js";

const nutrients = [
  "calories",
  "protein",
  "carbs",
  "fat",
  "fibre",
  "sodium",
] as const;

export function toFoodDayRow(
  foodDay: FoodDay,
  metadata: {
    readonly userId: string;
    readonly completeness: FoodDayCompleteness;
    readonly localDate?: string;
    readonly timezone?: string;
    readonly openedAt: string;
    readonly closedAt?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
): FoodDayRow {
  return {
    id: foodDay.id,
    user_id: metadata.userId,
    status: foodDay.status,
    completeness: metadata.completeness,
    calorie_target: foodDay.calorieTarget,
    protein_target: foodDay.proteinTarget,
    maintenance_snapshot: foodDay.maintenanceSnapshot ?? null,
    goal_version_id: foodDay.goalVersionId ?? null,
    local_date: metadata.localDate ?? null,
    timezone: metadata.timezone ?? null,
    opened_at: metadata.openedAt,
    closed_at: metadata.closedAt ?? null,
    created_at: metadata.createdAt,
    updated_at: metadata.updatedAt,
  };
}

export function fromFoodDayRow(row: FoodDayRow): PersistedFoodDay {
  return {
    foodDay: createFoodDay({
      id: row.id,
      status: row.status,
      calorieTarget: row.calorie_target,
      proteinTarget: row.protein_target,
      ...(row.maintenance_snapshot === null
        ? {}
        : { maintenanceSnapshot: row.maintenance_snapshot }),
      ...(row.goal_version_id === null
        ? {}
        : { goalVersionId: row.goal_version_id }),
    }),
    userId: row.user_id,
    completeness: row.completeness,
    ...(row.local_date === null ? {} : { localDate: row.local_date }),
    ...(row.timezone === null ? {} : { timezone: row.timezone }),
    openedAt: row.opened_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toFoodEntryRow(
  entry: FoodEntry,
  metadata: {
    readonly userId: string;
    readonly reportedAt: string;
    readonly consumedAt?: string;
    readonly consumedTimePrecision?: "EXACT" | "APPROXIMATE";
    readonly lastOperationId?: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
): FoodEntryRow {
  if (
    (metadata.consumedAt === undefined) !==
    (metadata.consumedTimePrecision === undefined)
  ) {
    throw new DomainValidationError(
      "consumedAt and consumedTimePrecision must be provided together.",
    );
  }

  return {
    ...toFoodEntryWriteValues(entry),
    user_id: metadata.userId,
    reported_at: metadata.reportedAt,
    consumed_at: metadata.consumedAt ?? null,
    consumed_time_precision: metadata.consumedTimePrecision ?? null,
    last_operation_id: metadata.lastOperationId ?? null,
    created_at: metadata.createdAt,
    updated_at: metadata.updatedAt,
  };
}

export function toFoodEntryWriteValues(entry: FoodEntry) {
  return {
    id: entry.id,
    food_day_id: entry.foodDayId,
    raw_user_description: entry.rawUserDescription,
    display_name: entry.displayName,
    normalized_name: entry.normalizedName ?? null,
    brand: entry.brand ?? null,
    quantity_amount: entry.quantity.amount,
    quantity_unit: entry.quantity.unit,
    nutrition_basis_amount: entry.nutritionBasis.amount,
    nutrition_basis_unit: entry.nutritionBasis.unit,
    nutrition_basis: copyNutrition(entry.nutritionBasis.nutrition),
    derived_nutrition: copyNutrition(entry.derivedNutrition),
    working_nutrition_override:
      entry.workingNutritionOverride === undefined
        ? null
        : { ...entry.workingNutritionOverride },
    working_nutrition: copyNutrition(entry.workingNutrition),
    evidence_class: entry.evidenceClass,
    estimate_low:
      entry.estimateLow === undefined ? null : copyNutrition(entry.estimateLow),
    estimate_high:
      entry.estimateHigh === undefined
        ? null
        : copyNutrition(entry.estimateHigh),
    status: entry.status,
    revision: entry.revision,
    deleted_at: entry.deletedAt ?? null,
  };
}

export function fromFoodEntryRow(row: FoodEntryRow): PersistedFoodEntry {
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new DomainValidationError(
      "Stored food entry revision must be at least 1.",
    );
  }
  if (row.deleted_at !== null && row.revision < 2) {
    throw new DomainValidationError(
      "Stored deleted food entry revision must be at least 2.",
    );
  }
  if ((row.estimate_low === null) !== (row.estimate_high === null)) {
    throw new DomainValidationError("Stored estimate bounds must be paired.");
  }
  if ((row.consumed_at === null) !== (row.consumed_time_precision === null)) {
    throw new DomainValidationError(
      "Stored consumed time and precision must be paired.",
    );
  }

  const validatedEntry = createFoodEntry({
    id: row.id,
    foodDayId: row.food_day_id,
    rawUserDescription: row.raw_user_description,
    displayName: row.display_name,
    ...(row.normalized_name === null
      ? {}
      : { normalizedName: row.normalized_name }),
    ...(row.brand === null ? {} : { brand: row.brand }),
    quantity: {
      amount: row.quantity_amount,
      unit: row.quantity_unit,
    },
    nutritionBasis: {
      amount: row.nutrition_basis_amount,
      unit: row.nutrition_basis_unit,
      nutrition: row.nutrition_basis,
    },
    evidenceClass: row.evidence_class,
    ...(row.estimate_low === null ? {} : { estimateLow: row.estimate_low }),
    ...(row.estimate_high === null ? {} : { estimateHigh: row.estimate_high }),
    status: row.status,
    ...(row.working_nutrition_override === null
      ? {}
      : { workingNutritionOverride: row.working_nutrition_override }),
  });

  const storedDerivedNutrition = parseNutrition(
    row.derived_nutrition,
    "stored derived nutrition",
  );
  assertNutritionEqual(
    storedDerivedNutrition,
    validatedEntry.derivedNutrition,
    "stored derived nutrition",
  );
  const storedWorkingNutrition = parseNutrition(
    row.working_nutrition,
    "stored working nutrition",
  );
  assertNutritionEqual(
    storedWorkingNutrition,
    validatedEntry.workingNutrition,
    "stored working nutrition",
  );
  const deletedAt = validateDeletedAt(validatedEntry, row.deleted_at);

  const entry: FoodEntry = {
    ...validatedEntry,
    revision: row.revision,
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };

  return {
    entry,
    userId: row.user_id,
    reportedAt: row.reported_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    ...(row.consumed_time_precision === null
      ? {}
      : { consumedTimePrecision: row.consumed_time_precision }),
    ...(row.last_operation_id === null
      ? {}
      : { lastOperationId: row.last_operation_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toFoodEntryRevisionRow(
  row: FoodEntryRow,
  metadata: {
    readonly revisionId: string;
    readonly operationId?: string;
    readonly createdAt: string;
  },
): FoodEntryRevisionRow {
  return {
    id: metadata.revisionId,
    user_id: row.user_id,
    food_entry_id: row.id,
    revision: row.revision,
    operation_id: metadata.operationId ?? null,
    snapshot: cloneRow(row),
    created_at: metadata.createdAt,
  };
}

function copyNutrition(nutrition: Nutrition): Nutrition {
  return { ...nutrition };
}

function assertNutritionEqual(
  actual: Nutrition,
  expected: Nutrition,
  label: string,
): void {
  for (const nutrient of nutrients) {
    if (actual[nutrient] !== expected[nutrient]) {
      throw new DomainValidationError(`${label} does not match ${nutrient}.`);
    }
  }
}

function validateDeletedAt(
  entry: FoodEntry,
  deletedAt: string | null,
): string | undefined {
  if (deletedAt === null) return undefined;
  const result = deleteFoodEntry(entry, {
    expectedRevision: entry.revision,
    deletedAt,
  });
  if (!result.ok || result.value.deletedAt === undefined) {
    throw new DomainValidationError("Stored deletion state is invalid.");
  }
  return result.value.deletedAt;
}

function cloneRow(row: FoodEntryRow): FoodEntryRow {
  return JSON.parse(JSON.stringify(row)) as FoodEntryRow;
}
