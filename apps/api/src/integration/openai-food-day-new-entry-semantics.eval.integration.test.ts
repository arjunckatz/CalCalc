import OpenAI from "openai";
import { it } from "vitest";

import { createOpenAIFoodDayTurnModel } from "../agent/providers/openai/openai-food-day-turn-model.js";
import type { FoodDayModelDecisionInput } from "../agent/turn/food-day-turn-types.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";
import type { FoodDayState } from "../state/build-food-day-state.js";

type ExpectedDecision =
  | { readonly type: "FINAL" }
  | {
      readonly type: "TOOLS";
      readonly name: "LOG_FOOD";
      readonly status: "CONFIRMED_CONSUMED" | "PLANNED";
    };

interface Scenario {
  readonly name: string;
  readonly input: FoodDayModelDecisionInput;
  readonly expected: ExpectedDecision;
}

function emptyState(foodDayId: string): FoodDayState {
  return {
    foodDay: {
      id: foodDayId,
      localDate: "2026-10-01",
      status: "OPEN",
      completeness: "UNKNOWN",
      targets: { calories: "2100", protein: "120" },
    },
    totals: {
      confirmed: {
        calories: "0",
        protein: "0",
        hasUnknownProtein: false,
      },
    },
    entries: [],
  };
}

const scenarios: readonly Scenario[] = [
  {
    name: "committed new dinner plan",
    input: {
      state: emptyState("10000000-0000-4000-8000-000000000001"),
      recentTranscript: [],
      userMessage: "I've decided I'll have a chicken wrap for dinner tonight.",
    },
    expected: { type: "TOOLS", name: "LOG_FOOD", status: "PLANNED" },
  },
  {
    name: "new food actually consumed",
    input: {
      state: emptyState("10000000-0000-4000-8000-000000000002"),
      recentTranscript: [],
      userMessage: "I ate a chicken wrap for lunch.",
    },
    expected: {
      type: "TOOLS",
      name: "LOG_FOOD",
      status: "CONFIRMED_CONSUMED",
    },
  },
  {
    name: "explicit hypothetical remains conversation-only",
    input: {
      state: emptyState("10000000-0000-4000-8000-000000000003"),
      recentTranscript: [],
      userMessage:
        "If I had a chicken wrap later, what would that mean for my day?",
    },
    expected: { type: "FINAL" },
  },
  {
    name: "casual possibility remains conversation-only",
    input: {
      state: emptyState("10000000-0000-4000-8000-000000000004"),
      recentTranscript: [],
      userMessage: "I'm thinking about maybe having a chicken wrap later.",
    },
    expected: { type: "FINAL" },
  },
];

function requiredEnvironment(name: "OPENAI_API_KEY" | "OPENAI_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for the live new-entry eval.`);
  return value;
}

class EvalMismatch extends Error {
  override readonly name = "EvalMismatch";
}

function safeToolName(call: unknown): string {
  if (call === null || typeof call !== "object" || !("name" in call)) {
    return "unknown";
  }
  const name = call.name;
  return name === "LOG_FOOD" ||
    name === "UPDATE_FOOD_QUANTITY" ||
    name === "REMOVE_FOOD" ||
    name === "CHANGE_FOOD_STATUS"
    ? name
    : "unknown";
}

function summarizeCall(call: unknown): object {
  try {
    const parsed = parseFoodDayToolCall(call);
    return parsed.name === "LOG_FOOD"
      ? { name: parsed.name, status: parsed.arguments.status ?? "omitted" }
      : { name: parsed.name };
  } catch (error) {
    return {
      name: safeToolName(call),
      parseError: error instanceof Error ? error.name : "UnknownError",
    };
  }
}

it.each(scenarios)(
  "$name",
  async ({ name, input, expected }) => {
    const apiKey = requiredEnvironment("OPENAI_API_KEY");
    const modelName = requiredEnvironment("OPENAI_MODEL");
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
    const model = createOpenAIFoodDayTurnModel({ client, model: modelName });
    let actual = "no decision";

    try {
      // One paid decision request; never finalize, execute tools, or retry.
      const decision = await model.decide(input);
      actual =
        decision.type === "FINAL"
          ? JSON.stringify({ type: "FINAL", toolCount: 0 })
          : JSON.stringify({
              type: "TOOLS",
              toolCount: decision.calls.length,
              calls: decision.calls.map(summarizeCall),
            });

      if (expected.type === "FINAL") {
        if (decision.type !== "FINAL" || Object.hasOwn(decision, "calls")) {
          throw new EvalMismatch("expected FINAL without tools");
        }
        return;
      }
      if (decision.type !== "TOOLS" || decision.calls.length !== 1) {
        throw new EvalMismatch("expected exactly one LOG_FOOD call");
      }
      const parsed = parseFoodDayToolCall(decision.calls[0]);
      if (
        parsed.name !== expected.name ||
        parsed.arguments.status !== expected.status
      ) {
        throw new EvalMismatch("creation tool or status differed");
      }
      const foodText =
        `${parsed.arguments.rawUserDescription} ${parsed.arguments.displayName}`.toLowerCase();
      if (!foodText.includes("chicken") || !foodText.includes("wrap")) {
        throw new EvalMismatch("creation tool selected a different food");
      }
    } catch (error) {
      // SDK errors may contain request data; emit only the error type.
      const reason =
        error instanceof EvalMismatch
          ? error.message
          : error instanceof Error
            ? error.name
            : "UnknownError";
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `${name}: expected=${JSON.stringify(expected)}; actual=${actual}; failure=${reason}`,
      );
    }
  },
  45_000,
);
