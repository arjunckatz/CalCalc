import OpenAI from "openai";
import { it } from "vitest";

import { createOpenAIFoodDayTurnModel } from "../agent/providers/openai/openai-food-day-turn-model.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";
import type { FoodDayModelDecision } from "../agent/turn/food-day-turn-types.js";
import {
  relativeDateScenarios,
  relativeDateState,
  type RelativeDateScenario,
} from "./body-weight-relative-date-eval-fixtures.js";
import {
  boundedAnswerExcerpt,
  isCorrectionUnavailableResponse,
  isExactWeightToolDecision,
  isSafeDateClarification,
} from "./body-weight-semantics-eval-assertions.js";

function requiredEnvironment(name: "OPENAI_API_KEY" | "OPENAI_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for the live relative-date eval.`);
  return value;
}

class EvalMismatch extends Error {
  override readonly name = "EvalMismatch";
}

function summary(decision: FoodDayModelDecision): object {
  if (decision.type === "FINAL") {
    return { type: "FINAL", answer: boundedAnswerExcerpt(decision.text) };
  }
  return {
    type: "TOOLS",
    count: decision.calls.length,
    orderedToolNames: decision.calls
      .slice(0, 8)
      .map((call) =>
        typeof call === "object" &&
        call !== null &&
        "name" in call &&
        typeof call.name === "string"
          ? call.name.slice(0, 40)
          : "unknown",
      ),
    calls: decision.calls.slice(0, 8).map((call) => {
      try {
        const parsed = parseFoodDayToolCall(call);
        return parsed.name === "LOG_BODY_WEIGHT"
          ? {
              name: parsed.name,
              arguments: {
                ...parsed.arguments,
                sourceValue: parsed.arguments.sourceValue.slice(0, 80),
              },
            }
          : { name: parsed.name };
      } catch {
        return { invalidArguments: true };
      }
    }),
  };
}

function matchesFinalAnswer(
  kind: Extract<RelativeDateScenario, { expected: "FINAL" }>["answerCheck"],
  answer: string,
): boolean {
  return kind === "CORRECTION_UNAVAILABLE"
    ? isCorrectionUnavailableResponse(answer)
    : isSafeDateClarification(answer);
}

it.each(relativeDateScenarios)(
  "$id: $name",
  async (scenario) => {
    const apiKey = requiredEnvironment("OPENAI_API_KEY");
    const modelName = requiredEnvironment("OPENAI_MODEL");
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
    const model = createOpenAIFoodDayTurnModel({ client, model: modelName });
    const input = {
      state: relativeDateState,
      userMessage: scenario.userMessage,
      recentTranscript: [],
      ...(scenario.calendarContext === undefined
        ? {}
        : { calendarContext: scenario.calendarContext }),
    };
    let actual: object = { type: "NO_DECISION" };

    try {
      // One production decision request only; no tool execution or finalization.
      const decision = await model.decide(input);
      actual = summary(decision);
      if (scenario.expected === "TOOLS") {
        if (!isExactWeightToolDecision(decision, scenario.arguments)) {
          throw new EvalMismatch(
            "expected exactly one LOG_BODY_WEIGHT call with exact arguments",
          );
        }
      } else if (
        decision.type !== "FINAL" ||
        !matchesFinalAnswer(scenario.answerCheck, decision.text)
      ) {
        throw new EvalMismatch("expected a safe FINAL answer with zero tools");
      }
    } catch (error) {
      // SDK errors can contain request details; report only their type.
      const failure =
        error instanceof EvalMismatch
          ? error.message
          : error instanceof Error
            ? error.name
            : "UnknownError";
      const expected =
        scenario.expected === "TOOLS"
          ? {
              type: "TOOLS",
              name: "LOG_BODY_WEIGHT",
              arguments: scenario.arguments,
            }
          : { type: "FINAL", answerCheck: scenario.answerCheck };
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `${scenario.id} ${scenario.name}: calendarContextPresent=${scenario.calendarContext !== undefined}; expected=${JSON.stringify(expected)}; actual=${JSON.stringify(actual)}; failure=${failure}`,
      );
    }
  },
  75_000,
);
