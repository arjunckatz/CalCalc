import OpenAI from "openai";
import { createFoodEntry } from "@cal-calc/domain";
import { it } from "vitest";

import type { FoodDayState } from "../state/build-food-day-state.js";
import type { FoodDayToolResult } from "../agent/tools/execute-food-day-tool.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";
import { createOpenAIFoodDayTurnModel } from "../agent/providers/openai/openai-food-day-turn-model.js";

const state: FoodDayState = {
  foodDay: {
    id: "10000000-0000-4000-8000-000000000001",
    localDate: "2026-09-19",
    status: "OPEN",
    completeness: "UNKNOWN",
    targets: { calories: "2100", protein: "120" },
  },
  totals: {
    confirmed: { calories: "150", protein: "8", hasUnknownProtein: false },
  },
  targetProgress: {
    calories: { remainingToTarget: "1950", overTargetBy: "0" },
    protein: { remainingToTarget: "112", overTargetBy: "0" },
  },
  entries: [
    {
      id: "20000000-0000-4000-8000-000000000001",
      displayName: "Breakfast",
      rawUserDescription: "Had breakfast",
      quantity: { amount: "1", unit: "SERVING" },
      status: "CONFIRMED_CONSUMED",
      workingNutrition: { calories: "150", protein: "8" },
      evidenceClass: "EXACT",
      revision: 1,
    },
  ],
};

const logMessage =
  "I just ate 200 g of yogurt. Log this 200 g portion as 120 calories and 10 g protein.";

const syntheticResult: readonly FoodDayToolResult[] = [
  {
    name: "LOG_FOOD",
    result: {
      disposition: "CREATED",
      entry: createFoodEntry({
        id: "30000000-0000-4000-8000-000000000001",
        foodDayId: state.foodDay.id,
        rawUserDescription: "Ate 200 g of yogurt",
        displayName: "Yogurt",
        quantity: { amount: "200", unit: "GRAM" },
        nutritionBasis: {
          amount: "200",
          unit: "GRAM",
          nutrition: { calories: "120", protein: "10" },
        },
        evidenceClass: "EXACT",
        status: "CONFIRMED_CONSUMED",
      }),
    },
  },
];

function requiredEnvironment(name: "OPENAI_API_KEY" | "OPENAI_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live smoke.`);
  return value;
}

function safeFailure(error: unknown, apiKey: string | undefined): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "Non-Error failure";
  const redacted = apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message;
  return `${name}: ${redacted
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 500)}`;
}

it("smokes the live OpenAI FoodDay adapter without executing tools", async () => {
  let stage = "configuration";
  let apiKey: string | undefined;
  let requests = 0;
  let decisionType = "none";
  let toolName = "none";

  try {
    apiKey = requiredEnvironment("OPENAI_API_KEY");
    const modelName = requiredEnvironment("OPENAI_MODEL");
    // No SDK retry may turn this three-request smoke into additional API calls.
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
    const model = createOpenAIFoodDayTurnModel({ client, model: modelName });

    stage = "FINAL decision";
    requests += 1;
    const finalDecision = await model.decide({
      state,
      recentTranscript: [],
      userMessage:
        "What are my confirmed calories so far? Don't change anything.",
    });
    decisionType = finalDecision.type;
    if (finalDecision.type !== "FINAL" || !finalDecision.text.trim()) {
      throw new Error("Expected non-empty FINAL text without a tool call.");
    }
    console.info(
      `FINAL passed: ${finalDecision.text.replace(/\s+/g, " ").slice(0, 120)}`,
    );

    stage = "LOG_FOOD decision";
    requests += 1;
    const logDecision = await model.decide({
      state,
      recentTranscript: [],
      userMessage: logMessage,
    });
    decisionType = logDecision.type;
    if (logDecision.type !== "TOOLS" || logDecision.calls.length === 0) {
      throw new Error("Expected at least one LOG_FOOD tool call.");
    }
    const logCall = logDecision.calls.find(
      (call) =>
        call !== null &&
        typeof call === "object" &&
        "name" in call &&
        call.name === "LOG_FOOD",
    );
    toolName = logCall ? "LOG_FOOD" : "none";
    if (!logCall) throw new Error("Expected a LOG_FOOD tool call.");
    console.info(
      `LOG_FOOD decision passed: ${logDecision.calls.length} call(s)`,
    );

    stage = "M4B1 validation";
    const validatedCall = parseFoodDayToolCall(logCall);
    if (validatedCall.name !== "LOG_FOOD") {
      throw new Error("Backend validation did not return LOG_FOOD.");
    }
    console.info("M4B1 backend validation passed");

    stage = "finalize";
    requests += 1;
    const finalText = await model.finalize({
      state,
      recentTranscript: [],
      userMessage: logMessage,
      toolResults: syntheticResult,
    });
    if (!/yog(h)?urt/i.test(finalText)) {
      throw new Error("Final response did not mention the logged yogurt.");
    }
    console.info(
      `Finalize passed: ${finalText.replace(/\s+/g, " ").slice(0, 120)}`,
    );
    console.info(
      `Live smoke passed with ${requests} Responses API calls (${modelName})`,
    );
  } catch (error) {
    // The original SDK error may contain request details, so do not expose it as a cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `${stage} failed: ${safeFailure(error, apiKey)}; calls=${requests}; decision=${decisionType}; tool=${toolName}`,
    );
  }
}, 120_000);
