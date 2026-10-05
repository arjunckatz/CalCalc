import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import type { FoodDayCompleteness } from "@cal-calc/persistence";
import OpenAI from "openai";
import { it } from "vitest";

import { createOpenAIFoodDayTurnModel } from "../agent/providers/openai/openai-food-day-turn-model.js";
import { openAIFoodDayTools } from "../agent/providers/openai/food-day-tool-schemas.js";
import type { FoodDayModelDecisionInput } from "../agent/turn/food-day-turn-types.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";
import { buildFoodDayState } from "../state/build-food-day-state.js";

type ExpectedTool =
  | {
      readonly name: "SET_FOOD_DAY_COMPLETENESS";
      readonly targetCompleteness: "PARTIAL" | "USER_DECLARED_COMPLETE";
    }
  | {
      readonly name: "LOG_FOOD";
      readonly status: "CONFIRMED_CONSUMED";
      readonly foodTerm: string;
    };

type ExpectedDecision =
  | { readonly type: "FINAL" }
  | { readonly type: "TOOLS"; readonly calls: readonly ExpectedTool[] };

interface Scenario {
  readonly name: string;
  readonly fixtureId: number;
  readonly completeness: FoodDayCompleteness;
  readonly withExistingFood: boolean;
  readonly userMessage: string;
  readonly expected: ExpectedDecision;
}

function inputFor(scenario: Scenario): FoodDayModelDecisionInput {
  const suffix = String(scenario.fixtureId).padStart(12, "0");
  const foodDay = createFoodDay({
    id: `10000000-0000-4000-8000-${suffix}`,
    status: "OPEN",
    calorieTarget: "2200",
    proteinTarget: "120",
  });
  const entries = scenario.withExistingFood
    ? [
        createFoodEntry({
          id: `20000000-0000-4000-8000-${suffix}`,
          foodDayId: foodDay.id,
          rawUserDescription: "I had oatmeal for breakfast.",
          displayName: "Oatmeal",
          quantity: { amount: "1", unit: "SERVING" },
          nutritionBasis: {
            amount: "1",
            unit: "SERVING",
            nutrition: { calories: "150", protein: "5" },
          },
          evidenceClass: "SOURCED" as const,
          status: "CONFIRMED_CONSUMED" as const,
        }),
      ]
    : [];
  return {
    state: buildFoodDayState({
      foodDay,
      entries,
      completeness: scenario.completeness,
      localDate: "2026-10-04",
    }),
    recentTranscript: [],
    userMessage: scenario.userMessage,
  };
}

const scenarios: readonly Scenario[] = [
  {
    name: "explicit declaration completes a partial FoodDay",
    fixtureId: 1,
    completeness: "PARTIAL",
    withExistingFood: true,
    userMessage: "That's everything I ate today.",
    expected: {
      type: "TOOLS",
      calls: [
        {
          name: "SET_FOOD_DAY_COMPLETENESS",
          targetCompleteness: "USER_DECLARED_COMPLETE",
        },
      ],
    },
  },
  {
    name: "explicitly incomplete log changes unknown completeness to partial",
    fixtureId: 2,
    completeness: "UNKNOWN",
    withExistingFood: true,
    userMessage: "My food log is still incomplete; I have more to add later.",
    expected: {
      type: "TOOLS",
      calls: [
        { name: "SET_FOOD_DAY_COMPLETENESS", targetCompleteness: "PARTIAL" },
      ],
    },
  },
  {
    name: "retracting completion returns the FoodDay to partial",
    fixtureId: 3,
    completeness: "USER_DECLARED_COMPLETE",
    withExistingFood: true,
    userMessage: "Actually, I still haven't logged dinner yet.",
    expected: {
      type: "TOOLS",
      calls: [
        { name: "SET_FOOD_DAY_COMPLETENESS", targetCompleteness: "PARTIAL" },
      ],
    },
  },
  {
    name: "repeating an already complete declaration needs no mutation",
    fixtureId: 4,
    completeness: "USER_DECLARED_COMPLETE",
    withExistingFood: true,
    userMessage: "Yep, that's everything for today.",
    expected: { type: "FINAL" },
  },
  {
    name: "ordinary food logging does not infer completeness",
    fixtureId: 5,
    completeness: "UNKNOWN",
    withExistingFood: false,
    userMessage: "I had an apple as a snack.",
    expected: {
      type: "TOOLS",
      calls: [
        { name: "LOG_FOOD", status: "CONFIRMED_CONSUMED", foodTerm: "apple" },
      ],
    },
  },
  {
    name: "compound disclosure logs food before declaring completion",
    fixtureId: 6,
    completeness: "PARTIAL",
    withExistingFood: true,
    userMessage: "I also had a cookie, and that's everything I ate today.",
    expected: {
      type: "TOOLS",
      calls: [
        { name: "LOG_FOOD", status: "CONFIRMED_CONSUMED", foodTerm: "cookie" },
        {
          name: "SET_FOOD_DAY_COMPLETENESS",
          targetCompleteness: "USER_DECLARED_COMPLETE",
        },
      ],
    },
  },
];

function requiredEnvironment(name: "OPENAI_API_KEY" | "OPENAI_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for the live completeness eval.`);
  return value;
}

class EvalMismatch extends Error {
  override readonly name = "EvalMismatch";
}

function safeToolName(call: unknown): string {
  if (call === null || typeof call !== "object" || !("name" in call)) {
    return "unrecognized";
  }
  const name = call.name;
  return typeof name === "string" &&
    openAIFoodDayTools.some((tool) => tool.name === name)
    ? name
    : "unrecognized";
}

function summarizeCall(call: unknown): object {
  try {
    const parsed = parseFoodDayToolCall(call);
    if (parsed.name === "SET_FOOD_DAY_COMPLETENESS") {
      return {
        name: parsed.name,
        targetCompleteness: parsed.arguments.targetCompleteness,
      };
    }
    if (parsed.name === "LOG_FOOD") {
      return {
        name: parsed.name,
        status: parsed.arguments.status ?? "omitted",
      };
    }
    return { name: parsed.name };
  } catch (error) {
    return {
      name: safeToolName(call),
      parseError: error instanceof Error ? error.name : "UnknownError",
    };
  }
}

function summarizeExpected(expected: ExpectedDecision): object {
  const calls = expected.type === "TOOLS" ? expected.calls : [];
  return {
    type: expected.type,
    toolCount: calls.length,
    orderedToolNames: calls.map((call) => call.name),
    calls,
  };
}

it.each(scenarios)(
  "$name",
  async (scenario) => {
    const apiKey = requiredEnvironment("OPENAI_API_KEY");
    const modelName = requiredEnvironment("OPENAI_MODEL");
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
    const model = createOpenAIFoodDayTurnModel({ client, model: modelName });
    const expected = scenario.expected;
    let actual: object = { type: "NO_DECISION" };

    try {
      // Exactly one paid decision request; no finalize or backend tool execution.
      const decision = await model.decide(inputFor(scenario));
      const calls = decision.type === "TOOLS" ? decision.calls : [];
      actual = {
        type: decision.type,
        toolCount: calls.length,
        orderedToolNames: calls.map(safeToolName),
        calls: calls.map(summarizeCall),
      };

      if (expected.type === "FINAL") {
        if (decision.type !== "FINAL" || Object.hasOwn(decision, "calls")) {
          throw new EvalMismatch("expected FINAL without tools");
        }
        return;
      }
      if (decision.type !== "TOOLS" || calls.length !== expected.calls.length) {
        throw new EvalMismatch("decision kind or tool count differed");
      }

      for (const [index, expectedCall] of expected.calls.entries()) {
        const parsed = parseFoodDayToolCall(calls[index]);
        if (parsed.name !== expectedCall.name) {
          throw new EvalMismatch(`tool ${index} name or order differed`);
        }
        if (expectedCall.name === "SET_FOOD_DAY_COMPLETENESS") {
          if (
            parsed.name !== "SET_FOOD_DAY_COMPLETENESS" ||
            parsed.arguments.targetCompleteness !==
              expectedCall.targetCompleteness
          ) {
            throw new EvalMismatch(
              `tool ${index} completeness target differed`,
            );
          }
        } else {
          if (
            parsed.name !== "LOG_FOOD" ||
            parsed.arguments.status !== expectedCall.status
          ) {
            throw new EvalMismatch(`tool ${index} food status differed`);
          }
          const foodText =
            `${parsed.arguments.rawUserDescription} ${parsed.arguments.displayName}`.toLowerCase();
          if (!foodText.includes(expectedCall.foodTerm)) {
            throw new EvalMismatch(`tool ${index} selected a different food`);
          }
        }
      }
    } catch (error) {
      // SDK errors may include request data: report only their type.
      const failure =
        error instanceof EvalMismatch
          ? error.message
          : error instanceof Error
            ? error.name
            : "UnknownError";
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `${scenario.name}: expected=${JSON.stringify(summarizeExpected(expected))}; actual=${JSON.stringify(actual)}; failure=${failure}`,
      );
    }
  },
  45_000,
);
