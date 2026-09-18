import { environmentVariableNames } from "@cal-calc/config";
import { normalizeDecimal } from "@cal-calc/domain";
import type { NonEmptyArray } from "@cal-calc/shared";

export {
  authenticateAuthorizationHeader,
  AuthenticationError,
  parseBearerAuthorization,
  type AccessTokenVerifier,
  type AuthenticatedIdentity,
  type AuthenticationErrorReason,
} from "./auth/authorization.js";
export {
  createSupabaseAccessTokenVerifier,
  SupabaseAccessTokenVerifier,
  type SupabaseAccessTokenVerifierConfig,
} from "./auth/supabase-verifier.js";

export {
  createPostgresRuntime,
  type PostgresRuntime,
  type PostgresRuntimeConfig,
} from "./postgres/runtime.js";
export { PostgresPoolTransactionRunner } from "./postgres/transaction-runner.js";
export { createApiApp, type ApiAppDependencies } from "./http/app.js";
export {
  listFoodEntriesForFoodDay,
  InvalidFoodDayIdError,
  type ListFoodEntriesForFoodDayDependencies,
  type ListFoodEntriesForFoodDayInput,
  type ListFoodEntriesForFoodDayResult,
} from "./queries/list-food-entries-for-food-day.js";
export {
  buildFoodDayState,
  type BuildFoodDayStateInput,
  type FoodDayState,
} from "./state/build-food-day-state.js";
export { getFoodDayState } from "./state/get-food-day-state.js";
export {
  parseFoodDayToolCall,
  ToolValidationError,
  type FoodDayToolCall,
} from "./agent/tools/food-day-tools.js";
export {
  executeFoodDayTool,
  type FoodDayToolResult,
  type TrustedFoodDayToolContext,
} from "./agent/tools/execute-food-day-tool.js";
export {
  runFoodDayTurn,
  FoodDayTurnExecutionError,
  FoodDayTurnValidationError,
  MAX_FOOD_DAY_TOOL_CALLS_PER_TURN,
  type RunFoodDayTurnDependencies,
} from "./agent/turn/run-food-day-turn.js";
export type {
  FoodDayModelDecision,
  FoodDayModelDecisionInput,
  FoodDayModelFinalizationInput,
  FoodDayTurnInput,
  FoodDayTurnModel,
  FoodDayTurnResult,
} from "./agent/turn/food-day-turn-types.js";
export type { FoodDayDto } from "./http/food-day-dto.js";
export type { FoodEntryDto } from "./http/food-entry-dto.js";
export {
  createFoodEntryMutation,
  type CreateFoodEntryCommand,
  type CreateFoodEntryMutationInput,
  type CreateFoodEntryMutationResult,
} from "./mutations/create-food-entry.js";
export {
  createFoodDayMutation,
  parseCreateFoodDayCommand,
  InvalidCreateFoodDayCommandError,
  type CreateFoodDayCommand,
  type CreateFoodDayMutationInput,
  type CreateFoodDayMutationResult,
} from "./mutations/create-food-day.js";
export {
  updateFoodEntryMutation,
  type UpdateFoodEntryCommand,
  type UpdateFoodEntryMutationInput,
  type UpdateFoodEntryMutationResult,
} from "./mutations/update-food-entry.js";
export {
  removeFoodEntryMutation,
  type RemoveFoodEntryCommand,
  type RemoveFoodEntryMutationInput,
  type RemoveFoodEntryMutationResult,
} from "./mutations/remove-food-entry.js";
export {
  deriveMutationIdentity,
  parseIdempotencyKey,
  MutationIdentityError,
  type IdempotencyKey,
  type MutationAction,
  type MutationIdentity,
  type MutationIdentityInput,
  type MutationOperationScope,
  type SemanticValue,
} from "./mutations/mutation-identity.js";

export function describeFoundation(): NonEmptyArray<string> {
  return [normalizeDecimal("1"), environmentVariableNames.supabaseUrl];
}
