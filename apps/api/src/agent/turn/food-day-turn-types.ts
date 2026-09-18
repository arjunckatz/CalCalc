import type { FoodDayState } from "../../state/build-food-day-state.js";
import type { IdempotencyKey } from "../../mutations/mutation-identity.js";
import type { FoodDayToolResult } from "../tools/execute-food-day-tool.js";

/** Identity, target, and retry identity are supplied by trusted orchestration. */
export interface FoodDayTurnInput {
  readonly trustedUserId: string;
  readonly foodDayId: string;
  readonly turnIdempotencyKey: IdempotencyKey;
  readonly userMessage: string;
}

export interface FoodDayModelDecisionInput {
  readonly userMessage: string;
  readonly state: FoodDayState;
}

export type FoodDayModelDecision =
  | { readonly type: "FINAL"; readonly text: string }
  | { readonly type: "TOOLS"; readonly calls: readonly unknown[] };

export interface FoodDayModelFinalizationInput extends FoodDayModelDecisionInput {
  readonly toolResults: readonly FoodDayToolResult[];
}

/** Provider-neutral interface; runtime protocol checks still treat responses as untrusted. */
export interface FoodDayTurnModel {
  decide(input: FoodDayModelDecisionInput): Promise<FoodDayModelDecision>;
  finalize(input: FoodDayModelFinalizationInput): Promise<string>;
}

export interface FoodDayTurnResult {
  readonly response: string;
  /** The initial canonical STATE the model saw, never an in-memory mutation. */
  readonly state: FoodDayState;
  readonly toolResults: readonly FoodDayToolResult[];
}
