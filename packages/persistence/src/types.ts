import type {
  EvidenceClass,
  FoodDay,
  FoodDayStatus,
  FoodEntry,
  FoodEntryStatus,
  MeasurementUnit,
  Nutrition,
  NutritionOverride,
} from "@cal-calc/domain";

export type FoodDayCompleteness =
  "UNKNOWN" | "PARTIAL" | "USER_DECLARED_COMPLETE";

export type ConsumedTimePrecision = "EXACT" | "APPROXIMATE";

export interface FoodDayRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: FoodDayStatus;
  readonly completeness: FoodDayCompleteness;
  readonly calorie_target: string;
  readonly protein_target: string;
  readonly maintenance_snapshot: string | null;
  readonly goal_version_id: string | null;
  readonly local_date: string | null;
  readonly timezone: string | null;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PersistedFoodDay {
  readonly foodDay: FoodDay;
  readonly userId: string;
  readonly completeness: FoodDayCompleteness;
  readonly localDate?: string;
  readonly timezone?: string;
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FoodEntryRow {
  readonly id: string;
  readonly user_id: string;
  readonly food_day_id: string;
  readonly raw_user_description: string;
  readonly display_name: string;
  readonly normalized_name: string | null;
  readonly brand: string | null;
  readonly quantity_amount: string;
  readonly quantity_unit: MeasurementUnit;
  readonly nutrition_basis_amount: string;
  readonly nutrition_basis_unit: MeasurementUnit;
  readonly nutrition_basis: Nutrition;
  readonly derived_nutrition: Nutrition;
  readonly working_nutrition_override: NutritionOverride | null;
  readonly working_nutrition: Nutrition;
  readonly evidence_class: EvidenceClass;
  readonly estimate_low: Nutrition | null;
  readonly estimate_high: Nutrition | null;
  readonly status: FoodEntryStatus;
  readonly revision: number;
  readonly reported_at: string;
  readonly consumed_at: string | null;
  readonly consumed_time_precision: ConsumedTimePrecision | null;
  readonly deleted_at: string | null;
  readonly last_operation_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PersistedFoodEntry {
  readonly entry: FoodEntry;
  readonly userId: string;
  readonly reportedAt: string;
  readonly consumedAt?: string;
  readonly consumedTimePrecision?: ConsumedTimePrecision;
  readonly lastOperationId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FoodEntryRevisionRow {
  readonly id: string;
  readonly user_id: string;
  readonly food_entry_id: string;
  readonly revision: number;
  readonly operation_id: string | null;
  readonly snapshot: FoodEntryRow;
  readonly created_at: string;
}
