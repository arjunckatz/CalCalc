import type {
  FoodDayCompleteness,
  PostgresTransactionRunner,
} from "@cal-calc/persistence";

import {
  changeFoodEntryStatusMutation,
  type ChangeFoodEntryStatusMutationResult,
} from "../../mutations/change-food-entry-status.js";
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
  setFoodDayCompletenessMutation,
  type SetFoodDayCompletenessMutationResult,
} from "../../mutations/set-food-day-completeness.js";
import {
  updateFoodEntryMutation,
  type UpdateFoodEntryMutationResult,
} from "../../mutations/update-food-entry.js";
import { parseFoodDayToolCall } from "./food-day-tools.js";

export interface TrustedFoodDayToolContext {
  readonly trustedUserId: string;
  readonly foodDayId: string;
  readonly idempotencyKey: IdempotencyKey;
  /** Completeness from the fresh canonical STATE shown to the model. */
  readonly stateCompleteness: FoodDayCompleteness;
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
    }
  | {
      readonly name: "CHANGE_FOOD_STATUS";
      readonly result: ChangeFoodEntryStatusMutationResult;
    }
  | {
      readonly name: "SET_FOOD_DAY_COMPLETENESS";
      readonly result: SetFoodDayCompletenessMutationResult;
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
          operationScope: "FOOD_DAY_TURN_TOOL",
          command: { foodDayId: trustedContext.foodDayId, ...call.arguments },
        }),
      };
    case "UPDATE_FOOD_QUANTITY":
      return {
        name: call.name,
        result: await updateFoodEntryMutation(dependencies, {
          trustedUserId,
          idempotencyKey,
          operationScope: "FOOD_DAY_TURN_TOOL",
          trustedFoodDayId: trustedContext.foodDayId,
          command: call.arguments,
        }),
      };
    case "REMOVE_FOOD":
      return {
        name: call.name,
        result: await removeFoodEntryMutation(dependencies, {
          trustedUserId,
          idempotencyKey,
          operationScope: "FOOD_DAY_TURN_TOOL",
          trustedFoodDayId: trustedContext.foodDayId,
          command: call.arguments,
        }),
      };
    case "CHANGE_FOOD_STATUS":
      return {
        name: call.name,
        result: await changeFoodEntryStatusMutation(dependencies, {
          trustedUserId,
          idempotencyKey,
          operationScope: "FOOD_DAY_TURN_TOOL",
          trustedFoodDayId: trustedContext.foodDayId,
          command: call.arguments,
        }),
      };
    case "SET_FOOD_DAY_COMPLETENESS":
      return {
        name: call.name,
        result: await setFoodDayCompletenessMutation(dependencies, {
          trustedUserId,
          trustedFoodDayId: trustedContext.foodDayId,
          idempotencyKey,
          operationScope: "FOOD_DAY_TURN_TOOL",
          command: {
            expectedCompleteness: trustedContext.stateCompleteness,
            targetCompleteness: call.arguments.targetCompleteness,
          },
        }),
      };
  }
}
