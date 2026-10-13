import {
  parseAccountTurnPlan,
  type AccountTurnPlan,
} from "@cal-calc/persistence";

import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";

/** Semantic validation precedes persistence; provider JSON is never stored raw. */
export function createAccountTurnPlanFromToolCalls(
  calls: readonly unknown[],
): AccountTurnPlan {
  if (
    !Array.isArray(calls) ||
    Object.getPrototypeOf(calls) !== Array.prototype ||
    calls.length < 1 ||
    calls.length > 8 ||
    Reflect.ownKeys(calls).length !== calls.length + 1
  ) {
    throw new TypeError("Account turn plan requires one to eight tool calls.");
  }
  return parseAccountTurnPlan({
    schema: "account-turn-plan-v1",
    slots: Array.from({ length: calls.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(calls, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("Invalid account turn tool call array.");
      }
      const call = descriptor.value;
      const parsed = parseFoodDayToolCall(call);
      return { index, action: parsed.name, command: parsed.arguments };
    }),
  });
}
