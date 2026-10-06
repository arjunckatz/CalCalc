import OpenAI from "openai";
import { subtractDecimals } from "@cal-calc/domain";
import { it } from "vitest";

import { createOpenAIFoodDayTurnModel } from "../agent/providers/openai/openai-food-day-turn-model.js";
import type { FoodDayModelDecisionInput } from "../agent/turn/food-day-turn-types.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";
import type { FoodDayState } from "../state/build-food-day-state.js";

const foodDayId = "10000000-0000-4000-8000-000000000001";
const yogurtId = "20000000-0000-4000-8000-000000000001";
const bananaId = "20000000-0000-4000-8000-000000000002";
const oatsId = "20000000-0000-4000-8000-000000000003";

type StateEntry = FoodDayState["entries"][number];

function entry(
  id: string,
  displayName: string,
  amount: string,
  unit: StateEntry["quantity"]["unit"],
  revision = 1,
): StateEntry {
  return {
    id,
    displayName,
    rawUserDescription: `Had ${displayName.toLowerCase()}`,
    quantity: { amount, unit },
    status: "CONFIRMED_CONSUMED",
    workingNutrition: { calories: "100", protein: "5" },
    evidenceClass: "EXACT",
    revision,
  };
}

function state(entries: readonly StateEntry[]): FoodDayState {
  const confirmedCalories = String(entries.length * 100);
  const confirmedProtein = String(entries.length * 5);
  return {
    foodDay: {
      id: foodDayId,
      localDate: "2026-09-29",
      status: "OPEN",
      completeness: "UNKNOWN",
      targets: { calories: "2100", protein: "120" },
    },
    totals: {
      confirmed: {
        calories: confirmedCalories,
        protein: confirmedProtein,
        hasUnknownProtein: false,
      },
    },
    targetProgress: {
      calories: {
        remainingToTarget: subtractDecimals("2100", confirmedCalories),
        overTargetBy: "0",
      },
      protein: {
        remainingToTarget: subtractDecimals("120", confirmedProtein),
        overTargetBy: "0",
      },
    },
    entries,
  };
}

type ExpectedTool =
  | {
      readonly name: "UPDATE_FOOD_QUANTITY";
      readonly entryId: string;
      readonly expectedRevision: number;
      readonly amount: string;
      readonly unit: "GRAM";
      readonly overrideAction: "PRESERVE";
    }
  | {
      readonly name: "REMOVE_FOOD";
      readonly entryId: string;
      readonly expectedRevision: number;
    };

interface Scenario {
  readonly name: string;
  readonly input: FoodDayModelDecisionInput;
  readonly expected: ExpectedTool;
}

const scenarios: readonly Scenario[] = [
  {
    name: "referential quantity correction",
    input: {
      state: state([
        entry(oatsId, "Oats", "1", "SERVING"),
        entry(yogurtId, "Yogurt", "200", "GRAM"),
      ]),
      recentTranscript: [
        {
          userMessage: "I had 200 g of yogurt.",
          response: "Logged your 200 g of yogurt.",
        },
      ],
      userMessage: "Actually make that 250 g.",
    },
    expected: {
      name: "UPDATE_FOOD_QUANTITY",
      entryId: yogurtId,
      expectedRevision: 1,
      amount: "250",
      unit: "GRAM",
      overrideAction: "PRESERVE",
    },
  },
  {
    name: "ordinal reference to second food",
    input: {
      state: state([
        entry(yogurtId, "Yogurt", "200", "GRAM"),
        entry(bananaId, "Banana", "1", "SERVING"),
      ]),
      recentTranscript: [
        {
          userMessage: "I had yogurt and then a banana.",
          response: "Logged your yogurt first and banana second.",
        },
      ],
      userMessage: "Remove the second one.",
    },
    expected: {
      name: "REMOVE_FOOD",
      entryId: bananaId,
      expectedRevision: 1,
    },
  },
  {
    name: "pronoun reference to most recent food",
    input: {
      state: state([
        entry(oatsId, "Oats", "1", "SERVING"),
        entry(bananaId, "Banana", "1", "SERVING"),
      ]),
      recentTranscript: [
        {
          userMessage: "I just had a banana.",
          response: "Logged the banana.",
        },
      ],
      userMessage: "Actually delete that.",
    },
    expected: {
      name: "REMOVE_FOOD",
      entryId: bananaId,
      expectedRevision: 1,
    },
  },
  {
    name: "current state overrides stale transcript quantity and revision",
    input: {
      state: state([
        entry(bananaId, "Banana", "1", "SERVING"),
        entry(yogurtId, "Yogurt", "300", "GRAM", 3),
      ]),
      recentTranscript: [
        {
          userMessage: "I had 200 g of yogurt.",
          response: "Logged your yogurt as 200 g.",
        },
      ],
      userMessage: "Actually make that yogurt 350 g.",
    },
    expected: {
      name: "UPDATE_FOOD_QUANTITY",
      entryId: yogurtId,
      expectedRevision: 3,
      amount: "350",
      unit: "GRAM",
      overrideAction: "PRESERVE",
    },
  },
];

function requiredEnvironment(name: "OPENAI_API_KEY" | "OPENAI_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for the live conversation eval.`);
  return value;
}

class EvalMismatch extends Error {
  override readonly name = "EvalMismatch";
}

function toolName(call: unknown): string {
  if (call === null || typeof call !== "object" || !("name" in call)) {
    return "unknown";
  }
  if (
    call.name === "LOG_FOOD" ||
    call.name === "UPDATE_FOOD_QUANTITY" ||
    call.name === "REMOVE_FOOD" ||
    call.name === "CHANGE_FOOD_STATUS"
  ) {
    return call.name;
  }
  return "unknown";
}

function projectedTool(call: ReturnType<typeof parseFoodDayToolCall>) {
  if (call.name === "LOG_FOOD") return { name: "LOG_FOOD" };
  if (call.name === "REMOVE_FOOD") {
    return {
      name: call.name,
      entryId: call.arguments.entryId,
      expectedRevision: call.arguments.expectedRevision,
    };
  }
  if (call.name === "CHANGE_FOOD_STATUS") {
    return {
      name: call.name,
      entryId: call.arguments.entryId,
      expectedRevision: call.arguments.expectedRevision,
      status: call.arguments.status,
    };
  }
  if (call.name === "SET_FOOD_DAY_COMPLETENESS") {
    return {
      name: call.name,
      targetCompleteness: call.arguments.targetCompleteness,
    };
  }
  if (call.name === "LOG_BODY_WEIGHT") return { name: call.name };
  return {
    name: call.name,
    entryId: call.arguments.entryId,
    expectedRevision: call.arguments.expectedRevision,
    amount: call.arguments.quantity.amount,
    unit: call.arguments.quantity.unit,
    overrideAction: call.arguments.overrideAction.type,
  };
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
      // Exactly one paid Responses request. No finalize, tool execution, or retry.
      const decision = await model.decide(input);
      if (decision.type === "FINAL") {
        actual = "FINAL"; // Do not print generated prose or provider objects.
        throw new EvalMismatch("expected one tool call");
      }
      actual = `TOOLS(count=${decision.calls.length}, names=${decision.calls.map(toolName).join(",")})`;
      if (decision.calls.length !== 1) {
        throw new EvalMismatch("expected exactly one tool call");
      }
      const parsed = parseFoodDayToolCall(decision.calls[0]);
      const projected = projectedTool(parsed);
      actual = JSON.stringify(projected);
      if (JSON.stringify(projected) !== JSON.stringify(expected)) {
        throw new EvalMismatch("tool meaning differed");
      }
    } catch (error) {
      // SDK errors may carry request details; never retain their message or cause.
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
