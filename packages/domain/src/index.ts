export {
  DomainValidationError,
  IncompatibleUnitError,
  type MutationResult,
  type RevisionConflict,
} from "./errors.js";
export { calculateNutrition } from "./nutrition/calculate.js";
export {
  normalizeDecimal,
  roundDecimalForDisplay,
  type DecimalString,
} from "./nutrition/decimal.js";
export {
  measurementUnits,
  parseNutrition,
  parseNutritionBasis,
  parseNutritionOverride,
  parseQuantity,
  type MeasurementUnit,
  type Nutrition,
  type NutritionBasis,
  type NutritionEstimateRange,
  type NutritionOverride,
  type Quantity,
} from "./nutrition/types.js";
export {
  applyWorkingNutritionOverride,
  changeFoodEntryStatus,
  clearWorkingNutritionOverride,
  createFoodEntry,
  deleteFoodEntry,
  replaceFoodEntry,
  restoreFoodEntry,
  updateFoodEntryQuantity,
  type CreateFoodEntryInput,
  type FoodEntryContentInput,
  type QuantityOverrideAction,
} from "./ledger/food-entry.js";
export { summarizeFoodDay, type FoodDaySummary } from "./ledger/summary.js";
export {
  createFoodDay,
  evidenceClasses,
  foodDayStatuses,
  foodEntryStatuses,
  type EvidenceClass,
  type FoodDay,
  type FoodDayStatus,
  type FoodEntry,
  type FoodEntryStatus,
} from "./ledger/types.js";
export {
  IdempotencyConflictError,
  InMemoryIdempotencyStore,
  type IdempotentExecution,
} from "./operations/idempotency.js";
