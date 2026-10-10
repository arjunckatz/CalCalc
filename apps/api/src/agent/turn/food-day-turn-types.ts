import type { FoodDayState } from "../../state/build-food-day-state.js";
import type { IdempotencyKey } from "../../mutations/mutation-identity.js";
import type { FoodDayToolResult } from "../tools/execute-food-day-tool.js";

/** Identity, target, and retry identity are supplied by trusted orchestration. */
export interface FoodDayCalendarContext {
  /** Client-resolved civil date for this turn; not FoodDay state or a location proof. */
  readonly currentLocalDate: string;
}

export interface FoodDayTurnInput {
  readonly trustedUserId: string;
  readonly foodDayId: string;
  readonly turnIdempotencyKey: IdempotencyKey;
  readonly userMessage: string;
  readonly calendarContext?: FoodDayCalendarContext;
}

export interface FoodDayTurnTranscriptItem {
  readonly userMessage: string;
  readonly response: string;
}

export interface FoodDayModelDecisionInput {
  readonly userMessage: string;
  readonly state: FoodDayState;
  readonly recentTranscript: readonly FoodDayTurnTranscriptItem[];
  readonly calendarContext?: FoodDayCalendarContext;
}

export type FoodDayModelDecision =
  | { readonly type: "FINAL"; readonly text: string }
  | { readonly type: "TOOLS"; readonly calls: readonly unknown[] };

export interface FoodDayModelFinalizationInput extends FoodDayModelDecisionInput {
  readonly toolResults: readonly FoodDayToolResult[];
}

export type FoodDayModelFinalizationStep =
  | { readonly type: "FINAL"; readonly text: string }
  | {
      readonly type: "READ_TOOL";
      readonly call: {
        readonly name: "GET_BODY_WEIGHT_HISTORY";
        readonly arguments: Readonly<Record<string, never>>;
      };
    };

/** Provider-neutral interface; runtime protocol checks still treat responses as untrusted. */
export interface FoodDayTurnModel {
  decide(input: FoodDayModelDecisionInput): Promise<FoodDayModelDecision>;
  finalizeOrRead(
    input: FoodDayModelFinalizationInput,
  ): Promise<FoodDayModelFinalizationStep>;
  /** Tool-free terminal response, used at most once after a continuation read. */
  finalize(input: FoodDayModelFinalizationInput): Promise<string>;
}

export interface FoodDayTurnResult {
  readonly response: string;
  /** The initial canonical STATE the model saw, never an in-memory mutation. */
  readonly state: FoodDayState;
  readonly toolResults: readonly FoodDayToolResult[];
}

/** Deliberately small boundary returned by durable replay and HTTP composition. */
export interface FoodDayTurnPublicResult {
  readonly response: string;
}
