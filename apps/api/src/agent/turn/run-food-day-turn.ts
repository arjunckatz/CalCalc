import type { PostgresTransactionRunner } from "@cal-calc/persistence";

import { isCanonicalLocalDate } from "../../calendar/local-date.js";
import {
  MutationIdentityError,
  parseIdempotencyKey,
} from "../../mutations/mutation-identity.js";
import type { ListFoodEntriesForFoodDayDependencies } from "../../queries/list-food-entries-for-food-day.js";
import { getFoodDayState } from "../../state/get-food-day-state.js";
import {
  executeFoodDayTool,
  type FoodDayToolResult,
} from "../tools/execute-food-day-tool.js";
import type { FoodDayToolCall } from "../tools/food-day-tools.js";
import type {
  FoodDayModelDecision,
  FoodDayTurnInput,
  FoodDayTurnModel,
  FoodDayTurnResult,
  FoodDayTurnTranscriptItem,
} from "./food-day-turn-types.js";
import { deriveFoodDayToolIdempotencyKey } from "./turn-idempotency.js";

export const MAX_FOOD_DAY_TOOL_CALLS_PER_TURN = 8;

export interface RunFoodDayTurnDependencies extends ListFoodEntriesForFoodDayDependencies {
  readonly transactionRunner: PostgresTransactionRunner;
  readonly model: FoodDayTurnModel;
  readonly loadRecentTranscript: (input: {
    readonly trustedUserId: string;
    readonly foodDayId: string;
  }) => Promise<readonly FoodDayTurnTranscriptItem[]>;
}

type FoodDayTurnValidationReason =
  | "INVALID_USER_MESSAGE"
  | "INVALID_TURN_IDEMPOTENCY_KEY"
  | "INVALID_CALENDAR_CONTEXT"
  | "INVALID_MODEL_DECISION"
  | "INVALID_FINAL_TEXT";

const validationMessages: Record<FoodDayTurnValidationReason, string> = {
  INVALID_USER_MESSAGE: "Invalid FoodDay turn message.",
  INVALID_TURN_IDEMPOTENCY_KEY: "Invalid FoodDay turn idempotency key.",
  INVALID_CALENDAR_CONTEXT: "Invalid FoodDay turn calendar context.",
  INVALID_MODEL_DECISION: "Invalid FoodDay model decision.",
  INVALID_FINAL_TEXT: "Invalid FoodDay final response.",
};

export class FoodDayTurnValidationError extends Error {
  override readonly name = "FoodDayTurnValidationError";

  constructor(readonly reason: FoodDayTurnValidationReason) {
    super(validationMessages[reason]);
  }
}

/** Earlier tool commits remain authoritative when a later tool fails. */
export class FoodDayTurnExecutionError extends Error {
  override readonly name = "FoodDayTurnExecutionError";
  readonly completedToolResults: readonly FoodDayToolResult[];

  constructor(
    readonly failedToolIndex: number,
    readonly failedToolName: FoodDayToolCall["name"] | undefined,
    completedToolResults: readonly FoodDayToolResult[],
    cause: unknown,
  ) {
    super("FoodDay tool batch stopped after a tool failed.", { cause });
    this.completedToolResults = [...completedToolResults];
  }
}

export async function runFoodDayTurn(
  dependencies: RunFoodDayTurnDependencies,
  input: FoodDayTurnInput,
): Promise<FoodDayTurnResult> {
  const userMessage = input.userMessage;
  if (typeof userMessage !== "string" || userMessage.trim() === "") {
    throw new FoodDayTurnValidationError("INVALID_USER_MESSAGE");
  }
  const suppliedCalendarContext = input.calendarContext;
  if (
    suppliedCalendarContext !== undefined &&
    (suppliedCalendarContext === null ||
      typeof suppliedCalendarContext !== "object" ||
      !isCanonicalLocalDate(suppliedCalendarContext.currentLocalDate))
  ) {
    throw new FoodDayTurnValidationError("INVALID_CALENDAR_CONTEXT");
  }
  const calendarContext =
    suppliedCalendarContext === undefined
      ? undefined
      : { currentLocalDate: suppliedCalendarContext.currentLocalDate };
  let turnIdempotencyKey: FoodDayTurnInput["turnIdempotencyKey"];
  try {
    turnIdempotencyKey = parseIdempotencyKey(input.turnIdempotencyKey);
  } catch (error) {
    if (!(error instanceof MutationIdentityError)) throw error;
    throw new FoodDayTurnValidationError("INVALID_TURN_IDEMPOTENCY_KEY");
  }
  const state = await getFoodDayState(dependencies, {
    trustedUserId: input.trustedUserId,
    foodDayId: input.foodDayId,
  });
  const recentTranscript = await dependencies.loadRecentTranscript({
    trustedUserId: input.trustedUserId,
    foodDayId: input.foodDayId,
  });
  const decision = parseDecision(
    await dependencies.model.decide({
      userMessage,
      state,
      recentTranscript,
      ...(calendarContext === undefined
        ? {}
        : { calendarContext: { ...calendarContext } }),
    }),
  );
  if (decision.type === "FINAL") {
    return { response: decision.text, state, toolResults: [] };
  }

  const toolResults: FoodDayToolResult[] = [];
  for (const [index, call] of decision.calls.entries()) {
    try {
      toolResults.push(
        await executeFoodDayTool(
          dependencies,
          {
            trustedUserId: input.trustedUserId,
            foodDayId: input.foodDayId,
            stateCompleteness: state.foodDay.completeness,
            userMessage,
            ...(calendarContext === undefined ? {} : { calendarContext }),
            // Arguments and action are excluded: a changed retry at this slot
            // reaches the agent-scoped fingerprint conflict check.
            idempotencyKey: deriveFoodDayToolIdempotencyKey(
              turnIdempotencyKey,
              index,
            ),
          },
          call,
        ),
      );
    } catch (cause) {
      if (toolResults.length === 0) throw cause;
      throw new FoodDayTurnExecutionError(
        index,
        safeToolName(call),
        toolResults,
        cause,
      );
    }
  }

  const response = validText(
    await dependencies.model.finalize({
      userMessage,
      state,
      recentTranscript,
      toolResults,
    }),
    "INVALID_FINAL_TEXT",
  );
  return { response, state, toolResults };
}

function parseDecision(value: unknown): FoodDayModelDecision {
  try {
    return inspectDecision(value);
  } catch (error) {
    if (error instanceof FoodDayTurnValidationError) throw error;
    // Inspection of hostile objects must not surface getter/proxy failures.
    throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
  }
}

function inspectDecision(value: unknown): FoodDayModelDecision {
  if (!isPlainObject(value)) {
    throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
  }
  const type = Object.getOwnPropertyDescriptor(value, "type");
  if (!type?.enumerable || !("value" in type)) {
    throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
  }
  if (type.value === "FINAL" && hasOnlyDataFields(value, ["type", "text"])) {
    return { type: "FINAL", text: validText(value.text, "INVALID_FINAL_TEXT") };
  }
  if (type.value === "TOOLS" && hasOnlyDataFields(value, ["type", "calls"])) {
    const calls = value.calls;
    if (
      !Array.isArray(calls) ||
      calls.length < 1 ||
      calls.length > MAX_FOOD_DAY_TOOL_CALLS_PER_TURN ||
      Object.getPrototypeOf(calls) !== Array.prototype
    ) {
      throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < calls.length; index += 1) {
      const field = Object.getOwnPropertyDescriptor(calls, String(index));
      if (!field?.enumerable || !("value" in field)) {
        throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
      }
      snapshot.push(field.value);
    }
    if (Reflect.ownKeys(calls).length !== calls.length + 1) {
      throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
    }
    return { type: "TOOLS", calls: snapshot };
  }
  throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
}

function validText(
  value: unknown,
  reason: FoodDayTurnValidationReason,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FoodDayTurnValidationError(reason);
  }
  return value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasOnlyDataFields(
  value: object,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && "value" in descriptor;
    })
  );
}

function safeToolName(value: unknown): FoodDayToolCall["name"] | undefined {
  try {
    if (!isPlainObject(value)) return undefined;
    const field = Object.getOwnPropertyDescriptor(value, "name");
    if (!field || !("value" in field)) return undefined;
    const name = field.value;
    return name === "LOG_FOOD" ||
      name === "UPDATE_FOOD_QUANTITY" ||
      name === "REMOVE_FOOD" ||
      name === "CHANGE_FOOD_STATUS" ||
      name === "SET_FOOD_DAY_COMPLETENESS" ||
      name === "LOG_BODY_WEIGHT"
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}
