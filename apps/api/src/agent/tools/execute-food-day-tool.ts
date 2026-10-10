import type {
  FoodDayCompleteness,
  PostgresTransactionRunner,
} from "@cal-calc/persistence";

import {
  getBodyWeightHistory,
  type GetBodyWeightHistoryDependencies,
} from "../../queries/get-body-weight-history.js";
import {
  isCanonicalLocalDate,
  previousCalendarDate,
} from "../../calendar/local-date.js";
import type { FoodDayCalendarContext } from "../turn/food-day-turn-types.js";
import {
  changeFoodEntryStatusMutation,
  type ChangeFoodEntryStatusMutationResult,
} from "../../mutations/change-food-entry-status.js";
import {
  createFoodEntryMutation,
  type CreateFoodEntryMutationResult,
} from "../../mutations/create-food-entry.js";
import {
  logBodyWeightMutation,
  type LogBodyWeightMutationResult,
} from "../../mutations/log-body-weight.js";
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
import { parseFoodDayToolCall, ToolValidationError } from "./food-day-tools.js";
import {
  projectBodyWeightHistory,
  type ModelBodyWeightHistory,
} from "./project-body-weight-history.js";

export interface ExecuteFoodDayToolDependencies extends GetBodyWeightHistoryDependencies {
  readonly transactionRunner: PostgresTransactionRunner;
}

export interface TrustedFoodDayToolContext {
  readonly trustedUserId: string;
  readonly foodDayId: string;
  readonly idempotencyKey: IdempotencyKey;
  /** Completeness from the fresh canonical STATE shown to the model. */
  readonly stateCompleteness: FoodDayCompleteness;
  /** Exact current turn text; date/unit evidence must come from this message. */
  readonly userMessage: string;
  readonly calendarContext?: FoodDayCalendarContext;
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
    }
  | {
      readonly name: "LOG_BODY_WEIGHT";
      readonly result: LogBodyWeightMutationResult;
    }
  | {
      readonly name: "GET_BODY_WEIGHT_HISTORY";
      readonly result: ModelBodyWeightHistory;
    };

export async function executeFoodDayTool(
  dependencies: ExecuteFoodDayToolDependencies,
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
    case "LOG_BODY_WEIGHT":
      if (
        !mentionsSupportedDate(
          trustedContext.userMessage,
          call.arguments.localDate,
          trustedContext.calendarContext,
        ) ||
        !mentionsExplicitSourceUnit(
          trustedContext.userMessage,
          call.arguments.sourceUnit,
        )
      ) {
        throw new ToolValidationError();
      }
      return {
        name: call.name,
        result: await logBodyWeightMutation(dependencies, {
          trustedUserId,
          idempotencyKey,
          operationScope: "FOOD_DAY_TURN_TOOL",
          command: call.arguments,
        }),
      };
    case "GET_BODY_WEIGHT_HISTORY":
      return executeBodyWeightHistoryRead(dependencies, trustedUserId);
  }
}

/** Trusted, side-effect-free read shared by initial and continuation phases. */
export async function executeBodyWeightHistoryRead(
  dependencies: GetBodyWeightHistoryDependencies,
  trustedUserId: string,
): Promise<Extract<FoodDayToolResult, { name: "GET_BODY_WEIGHT_HISTORY" }>> {
  return {
    name: "GET_BODY_WEIGHT_HISTORY",
    result: projectBodyWeightHistory(
      await getBodyWeightHistory(dependencies, { trustedUserId }),
    ),
  };
}

function mentionsSupportedDate(
  message: string,
  localDate: string,
  calendarContext: FoodDayCalendarContext | undefined,
): boolean {
  if (mentionsExplicitDate(message, localDate)) return true;
  const currentLocalDate = calendarContext?.currentLocalDate;
  if (!isCanonicalLocalDate(currentLocalDate)) return false;
  return (
    (/(?:^|[^\p{L}\p{N}_-])today(?![\p{L}\p{N}_-])/iu.test(message) &&
      localDate === currentLocalDate) ||
    (/(?:^|[^\p{L}\p{N}_-])yesterday(?![\p{L}\p{N}_-])/iu.test(message) &&
      localDate === previousCalendarDate(currentLocalDate))
  );
}

function mentionsExplicitDate(message: string, localDate: string): boolean {
  if (typeof message !== "string") return false;
  // A date embedded in a larger word, number, or hyphenated token is not an
  // explicit standalone measurement date.
  for (const match of message.matchAll(
    /(?:^|[^\p{L}\p{N}_-])(\d{4}-\d{2}-\d{2})(?![\p{L}\p{N}_-])/gu,
  )) {
    if (match[1] === localDate) return true;
  }
  return false;
}

function mentionsExplicitSourceUnit(
  message: string,
  sourceUnit: "KG" | "LB",
): boolean {
  if (typeof message !== "string") return false;
  const unitToken =
    sourceUnit === "KG"
      ? /(?:^|[^\p{L}_])(?:kg|kgs|kilogram|kilograms|kilo|kilos)(?![\p{L}\p{N}_])/iu
      : /(?:^|[^\p{L}_])(?:lb|lbs|pound|pounds)(?![\p{L}\p{N}_])/iu;
  return unitToken.test(message);
}
