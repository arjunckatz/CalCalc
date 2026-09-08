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
export type { FoodDayDto } from "./http/food-day-dto.js";

export function describeFoundation(): NonEmptyArray<string> {
  return [normalizeDecimal("1"), environmentVariableNames.supabaseUrl];
}
