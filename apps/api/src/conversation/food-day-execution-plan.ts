import { isDeepStrictEqual } from "node:util";

import { createBodyWeightEntry, createFoodEntry } from "@cal-calc/domain";
import {
  parseAccountTurnPlan,
  type AccountTurnPlan,
  type FoodDayCompleteness,
} from "@cal-calc/persistence";

import { validateBodyWeightLogEvidence } from "../agent/tools/execute-food-day-tool.js";
import {
  parseFoodDayToolCall,
  type FoodDayToolCall,
} from "../agent/tools/food-day-tools.js";
import type { FoodDayCalendarContext } from "../agent/turn/food-day-turn-types.js";
import {
  FoodDayTurnValidationError,
  parseInitialFoodDayModelDecision,
} from "../agent/turn/run-food-day-turn.js";
import type { FoodDayState } from "../state/build-food-day-state.js";

type ToolSlot = AccountTurnPlan["slots"][number];
const entryActions = [
  "UPDATE_FOOD_QUANTITY",
  "REMOVE_FOOD",
  "CHANGE_FOOD_STATUS",
] as const;
const completenessValues: readonly FoodDayCompleteness[] = [
  "UNKNOWN",
  "PARTIAL",
  "USER_DECLARED_COMPLETE",
];

/** The v1 slot envelope is existing durable storage. A one-slot
 * DIRECT_RESPONSE is its terminal variant; other slots are ordered tools. */
export function createFoodDayExecutionPlan(input: {
  readonly decision: unknown;
  readonly state: FoodDayState;
  readonly userMessage: string;
  readonly calendarContext?: FoodDayCalendarContext;
}): AccountTurnPlan {
  const decision = parseInitialFoodDayModelDecision(input.decision);
  if (decision.type === "FINAL") {
    return parseFoodDayExecutionPlan(
      {
        schema: "account-turn-plan-v1",
        foodDayId: input.state.foodDay.id,
        slots: [
          {
            index: 0,
            action: "DIRECT_RESPONSE",
            command: { response: decision.text },
          },
        ],
      },
      input.state.foodDay.id,
    );
  }
  const calls = decision.calls.map((call, index) => {
    const parsed = canonicalizeTool(parseTool(call), input.state.foodDay.id);
    const command: Record<string, unknown> = { ...parsed.arguments };
    if (parsed.name === "SET_FOOD_DAY_COMPLETENESS") {
      command.expectedCompleteness = input.state.foodDay.completeness;
    }
    if (parsed.name === "LOG_BODY_WEIGHT") {
      validateBodyWeightLogEvidence(
        input.userMessage,
        parsed.arguments,
        input.calendarContext,
      );
    }
    return { index, action: parsed.name, command };
  });
  const plan = parseFoodDayExecutionPlan(
    {
      schema: "account-turn-plan-v1",
      foodDayId: input.state.foodDay.id,
      slots: calls,
    },
    input.state.foodDay.id,
  );
  checkStatePreconditions(plan, input.state);
  return plan;
}

/** Strict application-level rehydration after the persistence JSON envelope.
 * It needs no fresh STATE, so a committed plan can replay before preparation. */
export function parseFoodDayExecutionPlan(
  value: unknown,
  trustedFoodDayId: string,
): AccountTurnPlan {
  let plan: AccountTurnPlan;
  try {
    plan = parseAccountTurnPlan(value);
    if (plan.foodDayId !== trustedFoodDayId) throw new TypeError();
    const direct = plan.slots[0]?.action === "DIRECT_RESPONSE";
    if (direct) {
      if (plan.slots.length !== 1) throw new TypeError();
      const command = plan.slots[0]?.command;
      if (
        command === undefined ||
        !exactKeys(command, ["response"]) ||
        typeof command.response !== "string" ||
        command.response.trim() === "" ||
        command.response !== command.response.trim()
      )
        throw new TypeError();
      return plan;
    }
    const mutatedEntries = new Set<string>();
    let completenessWritten = false;
    for (const slot of plan.slots) {
      if (slot.action === "DIRECT_RESPONSE") throw new TypeError();
      const call = parseSlot(slot, trustedFoodDayId);
      if (isEntryAction(call)) {
        if (mutatedEntries.has(call.arguments.entryId)) throw new TypeError();
        mutatedEntries.add(call.arguments.entryId);
      }
      if (call.name === "SET_FOOD_DAY_COMPLETENESS") {
        if (completenessWritten) throw new TypeError();
        completenessWritten = true;
      }
    }
    return plan;
  } catch {
    throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
  }
}

function parseSlot(slot: ToolSlot, foodDayId: string): FoodDayToolCall {
  if (slot.action === "SET_FOOD_DAY_COMPLETENESS") {
    if (
      !exactKeys(slot.command, [
        "targetCompleteness",
        "expectedCompleteness",
      ]) ||
      !completenessValues.includes(
        slot.command.expectedCompleteness as FoodDayCompleteness,
      )
    )
      throw new TypeError();
    return parseCanonicalTool({
      name: slot.action,
      arguments: { targetCompleteness: slot.command.targetCompleteness },
    });
  }
  const call = canonicalizeTool(
    parseCanonicalTool({
      name: slot.action,
      arguments: slot.command,
    }),
    foodDayId,
  );
  if (!isDeepStrictEqual(call.arguments, slot.command)) throw new TypeError();
  return call;
}

function parseTool(value: unknown): FoodDayToolCall {
  try {
    return parseFoodDayToolCall(value);
  } catch {
    throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
  }
}

function canonicalizeTool(
  call: FoodDayToolCall,
  foodDayId: string,
): FoodDayToolCall {
  try {
    if (call.name === "LOG_FOOD") {
      const entry = createFoodEntry({
        id: "validation-only", // Never stored as an entry ID.
        foodDayId,
        ...call.arguments,
        status: call.arguments.status ?? "CONFIRMED_CONSUMED",
      });
      return {
        name: call.name,
        arguments: {
          rawUserDescription: entry.rawUserDescription,
          displayName: entry.displayName,
          quantity: entry.quantity,
          nutritionBasis: entry.nutritionBasis,
          evidenceClass: entry.evidenceClass,
          status: call.arguments.status ?? "CONFIRMED_CONSUMED",
        },
      };
    }
    if (call.name === "LOG_BODY_WEIGHT") {
      const weight = createBodyWeightEntry({
        id: "validation-only", // The future mutation creates its own ID.
        ...call.arguments,
      });
      return {
        name: call.name,
        arguments: {
          localDate: weight.localDate,
          sourceValue: weight.sourceValue,
          sourceUnit: weight.sourceUnit,
        },
      };
    }
    return call;
  } catch {
    throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
  }
}

function parseCanonicalTool(value: unknown): FoodDayToolCall {
  return parseFoodDayToolCall(value);
}

function isEntryAction(
  call: FoodDayToolCall,
): call is Extract<FoodDayToolCall, { name: (typeof entryActions)[number] }> {
  return entryActions.some((action) => action === call.name);
}

function checkStatePreconditions(
  plan: AccountTurnPlan,
  state: FoodDayState,
): void {
  for (const slot of plan.slots) {
    const call = parseSlot(slot, state.foodDay.id);
    if (isEntryAction(call)) {
      const entry = state.entries.find(
        (item) => item.id === call.arguments.entryId,
      );
      if (
        entry === undefined ||
        entry.revision !== call.arguments.expectedRevision
      )
        throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
      if (
        call.name === "CHANGE_FOOD_STATUS" &&
        entry.status === call.arguments.status
      )
        throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
    }
    if (
      call.name === "SET_FOOD_DAY_COMPLETENESS" &&
      slot.command.expectedCompleteness !== state.foodDay.completeness
    )
      throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
    if (
      call.name === "SET_FOOD_DAY_COMPLETENESS" &&
      call.arguments.targetCompleteness === state.foodDay.completeness
    )
      throw new FoodDayTurnValidationError("INVALID_MODEL_DECISION");
  }
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  if (Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}
