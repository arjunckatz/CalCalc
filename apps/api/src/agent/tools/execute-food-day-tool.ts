import type { PostgresTransactionRunner } from "@cal-calc/persistence";

import {
  createFoodEntryMutation,
  type CreateFoodEntryMutationResult,
} from "../../mutations/create-food-entry.js";
import type { IdempotencyKey } from "../../mutations/mutation-identity.js";
import {
  removeFoodEntryMutation,
  type RemoveFoodEntryMutationResult,
} from "../../mutations/remove-food-entry.js";
import {
  updateFoodEntryMutation,
  type UpdateFoodEntryMutationResult,
} from "../../mutations/update-food-entry.js";
import { parseFoodDayToolCall } from "./food-day-tools.js";

export interface TrustedFoodDayToolContext {
  readonly trustedUserId: string;
  readonly foodDayId: string;
  readonly idempotencyKey: IdempotencyKey;
}

export type FoodDayToolResult =
  | {
      readonly name: "LOG_FOOD";
      readonly result: CreateFoodEntryMutationResult;
    }
  | {
      readonly name: "UPDATE_FOOD_QUANTITY";
      readonly result: UpdateFoodEntryMutationResult;
    }
  | {
      readonly name: "REMOVE_FOOD";
      readonly result: RemoveFoodEntryMutationResult;
    };

export async function executeFoodDayTool(
  dependencies: { readonly transactionRunner: PostgresTransactionRunner },
  trustedContext: TrustedFoodDayToolContext,
  untrustedToolCall: unknown,
): Promise<FoodDayToolResult> {
  const call = parseFoodDayToolCall(untrustedToolCall);
  const { trustedUserId, idempotencyKey } = trustedContext;
  switch (call.name) {
    case "LOG_FOOD":
      return {
        name: call.name,
        result: await createFoodEntryMutation(dependencies, {
          trustedUserId,
          idempotencyKey,
          command: { foodDayId: trustedContext.foodDayId, ...call.arguments },
        }),
      };
    case "UPDATE_FOOD_QUANTITY":
      return {
        name: call.name,
        result: await updateFoodEntryMutation(dependencies, {
          trustedUserId,
          idempotencyKey,
          command: call.arguments,
        }),
      };
    case "REMOVE_FOOD":
      return {
        name: call.name,
        result: await removeFoodEntryMutation(dependencies, {
          trustedUserId,
          idempotencyKey,
          command: call.arguments,
        }),
      };
  }
}
