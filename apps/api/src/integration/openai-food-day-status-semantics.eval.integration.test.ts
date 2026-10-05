import OpenAI from "openai";
import { type FoodEntryStatus } from "@cal-calc/domain";
import { it } from "vitest";

import { createOpenAIFoodDayTurnModel } from "../agent/providers/openai/openai-food-day-turn-model.js";
import type { FoodDayModelDecisionInput } from "../agent/turn/food-day-turn-types.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";
import type { FoodDayState } from "../state/build-food-day-state.js";

type ExpectedDecision =
  | { readonly type: "FINAL" }
  | {
      readonly type: "TOOLS";
      readonly entryId: string;
      readonly expectedRevision: number;
      readonly status: FoodEntryStatus;
    };

interface Scenario {
  readonly name: string;
  readonly input: FoodDayModelDecisionInput;
  readonly expected: ExpectedDecision;
}

function state(
  foodDayId: string,
  entryId: string,
  displayName: string,
  status: FoodEntryStatus,
  revision: number,
): FoodDayState {
  return {
    foodDay: {
      id: foodDayId,
      localDate: "2026-09-30",
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
    targetProgress: {
      calories: { remainingToTarget: "2100", overTargetBy: "0" },
      protein: { remainingToTarget: "120", overTargetBy: "0" },
    },
    entries: [
      {
        id: entryId,
        displayName,
        rawUserDescription: displayName,
        quantity: { amount: "1", unit: "SERVING" },
        status,
        workingNutrition: { calories: "300", protein: "12" },
        evidenceClass: "EXACT",
        revision,
      },
    ],
  };
}

const scenarios: readonly Scenario[] = [
  {
    name: "genuine plan changes a considered entry to PLANNED",
    input: {
      state: state(
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        "Vegetable curry",
        "CONSIDERED",
        2,
      ),
      recentTranscript: [],
      userMessage:
        "I've decided I'm having the vegetable curry for dinner tonight.",
    },
    expected: {
      type: "TOOLS",
      entryId: "20000000-0000-4000-8000-000000000001",
      expectedRevision: 2,
      status: "PLANNED",
    },
  },
  {
    name: "actual consumption confirms a planned entry",
    input: {
      state: state(
        "10000000-0000-4000-8000-000000000002",
        "20000000-0000-4000-8000-000000000002",
        "Veggie wrap",
        "PLANNED",
        3,
      ),
      recentTranscript: [],
      userMessage: "I actually ate the veggie wrap.",
    },
    expected: {
      type: "TOOLS",
      entryId: "20000000-0000-4000-8000-000000000002",
      expectedRevision: 3,
      status: "CONFIRMED_CONSUMED",
    },
  },
  {
    name: "not consumed discards a planned entry without removing it",
    input: {
      state: state(
        "10000000-0000-4000-8000-000000000003",
        "20000000-0000-4000-8000-000000000003",
        "Tomato soup",
        "PLANNED",
        4,
      ),
      recentTranscript: [],
      userMessage: "I didn't end up having the tomato soup.",
    },
    expected: {
      type: "TOOLS",
      entryId: "20000000-0000-4000-8000-000000000003",
      expectedRevision: 4,
      status: "DISCARDED",
    },
  },
  {
    name: "explicit hypothetical is answered without a ledger mutation",
    input: {
      state: state(
        "10000000-0000-4000-8000-000000000004",
        "20000000-0000-4000-8000-000000000004",
        "Pasta",
        "PLANNED",
        5,
      ),
      recentTranscript: [],
      userMessage:
        "Hypothetically, if I ate the pasta later, what would that mean for my day? I am not saying I ate it.",
    },
    expected: { type: "FINAL" },
  },
];

function requiredEnvironment(name: "OPENAI_API_KEY" | "OPENAI_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live status eval.`);
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
    if (parsed.name === "CHANGE_FOOD_STATUS") {
      return {
        name: parsed.name,
        entryId: parsed.arguments.entryId,
        expectedRevision: parsed.arguments.expectedRevision,
        status: parsed.arguments.status,
      };
    }
    if (
      parsed.name === "REMOVE_FOOD" ||
      parsed.name === "UPDATE_FOOD_QUANTITY"
    ) {
      return {
        name: parsed.name,
        entryId: parsed.arguments.entryId,
        expectedRevision: parsed.arguments.expectedRevision,
      };
    }
    return { name: parsed.name };
  } catch {
    return { name: safeToolName(call), invalidArguments: true };
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
      // One paid decision request; no finalize, tool execution, or retry.
      const decision = await model.decide(input);
      actual =
        decision.type === "FINAL"
          ? "FINAL"
          : JSON.stringify({
              type: "TOOLS",
              count: decision.calls.length,
              calls: decision.calls.map(summarizeCall),
            });

      if (expected.type === "FINAL") {
        if (decision.type !== "FINAL")
          throw new EvalMismatch("expected FINAL without tools");
        return;
      }
      if (decision.type !== "TOOLS" || decision.calls.length !== 1) {
        throw new EvalMismatch("expected exactly one status tool call");
      }
      const parsed = parseFoodDayToolCall(decision.calls[0]);
      if (
        parsed.name !== "CHANGE_FOOD_STATUS" ||
        parsed.arguments.entryId !== expected.entryId ||
        parsed.arguments.expectedRevision !== expected.expectedRevision ||
        parsed.arguments.status !== expected.status
      ) {
        throw new EvalMismatch("status tool meaning differed");
      }
    } catch (error) {
      // SDK errors may contain sensitive request data; print only their type.
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
