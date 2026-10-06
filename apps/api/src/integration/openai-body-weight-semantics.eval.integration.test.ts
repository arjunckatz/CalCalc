import OpenAI from "openai";
import { createFoodDay } from "@cal-calc/domain";
import { it } from "vitest";

import { createOpenAIFoodDayTurnModel } from "../agent/providers/openai/openai-food-day-turn-model.js";
import type { FoodDayToolResult } from "../agent/tools/execute-food-day-tool.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";
import type { FoodDayModelDecision } from "../agent/turn/food-day-turn-types.js";
import { buildFoodDayState } from "../state/build-food-day-state.js";
import {
  boundedAnswerExcerpt,
  isCanonicalHistoryUncertainResponse,
  isCorrectionUnavailableResponse,
  isDateClarification,
  isExactWeightToolDecision,
  isGoalNotObservationResponse,
  isSuccessfulWeightAcknowledgement,
  type ExpectedWeightArguments,
} from "./body-weight-semantics-eval-assertions.js";

type Scenario = {
  readonly name: string;
  readonly userMessage: string;
  readonly recentTranscript?: readonly {
    readonly userMessage: string;
    readonly response: string;
  }[];
} & (
  | {
      readonly expected: "TOOLS";
      readonly arguments: ExpectedWeightArguments;
      readonly finalize: boolean;
    }
  | {
      readonly expected: "FINAL";
      readonly answerCheck:
        | "DATE_CLARIFICATION"
        | "GOAL_REFUSAL"
        | "CORRECTION_UNAVAILABLE"
        | "HISTORY_UNCERTAIN";
    }
);

const foodDay = createFoodDay({
  id: "10000000-0000-4000-8000-000000000001",
  status: "OPEN",
  calorieTarget: "2200",
  proteinTarget: "120",
});
const state = buildFoodDayState({
  foodDay,
  entries: [],
  completeness: "UNKNOWN",
  localDate: "2026-10-01", // Logical FoodDay date, never a civil-today anchor.
});

const scenarios: readonly Scenario[] = [
  {
    name: "A: actual dated observation logs and finalizes from the authoritative result",
    userMessage: "On 2026-10-05 I weighed 80.4 kg.",
    expected: "TOOLS",
    arguments: {
      localDate: "2026-10-05",
      sourceValue: "80.4",
      sourceUnit: "KG",
    },
    finalize: true,
  },
  {
    name: "B: unrelated appointment date does not resolve today's weigh-in",
    userMessage: "My appointment is on 2026-10-05. I weighed 80 kg today.",
    expected: "FINAL",
    answerCheck: "DATE_CLARIFICATION",
  },
  {
    name: "C: planned first date does not displace the actual second date",
    userMessage:
      "On 2026-10-05 I planned to weigh myself. On 2026-10-06 I weighed 80 kg.",
    expected: "TOOLS",
    arguments: { localDate: "2026-10-06", sourceValue: "80", sourceUnit: "KG" },
    finalize: false,
  },
  {
    name: "D: negated date is not selected over the affirmed date",
    userMessage: "I wasn't 80 kg on 2026-10-05; I was 80 kg on 2026-10-06.",
    expected: "TOOLS",
    arguments: { localDate: "2026-10-06", sourceValue: "80", sourceUnit: "KG" },
    finalize: false,
  },
  {
    name: "E: goal is not logged as an observation",
    userMessage: "Please log my goal of 75 kg for 2026-10-05.",
    expected: "FINAL",
    answerCheck: "GOAL_REFUSAL",
  },
  {
    name: "F: correction does not append a new weigh-in",
    userMessage:
      "Correction: the 2026-10-05 weigh-in was 79.8 kg, not 80.8 kg.",
    expected: "FINAL",
    answerCheck: "CORRECTION_UNAVAILABLE",
  },
  {
    name: "G: transcript weight is not canonical latest-weight history",
    userMessage: "What's my latest weight?",
    recentTranscript: [
      {
        userMessage: "On 2026-10-05 I weighed 80.4 kg.",
        response: "Logged 80.4 kg for October 5.",
      },
    ],
    expected: "FINAL",
    answerCheck: "HISTORY_UNCERTAIN",
  },
];

function requiredEnvironment(name: "OPENAI_API_KEY" | "OPENAI_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live weight eval.`);
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
    orderedToolNames: decision.calls.map((call) => {
      if (call === null || typeof call !== "object" || !("name" in call)) {
        return "unknown";
      }
      return typeof call.name === "string" ? call.name.slice(0, 40) : "unknown";
    }),
    calls: decision.calls.map((call) => {
      try {
        const parsed = parseFoodDayToolCall(call);
        return parsed.name === "LOG_BODY_WEIGHT"
          ? { name: parsed.name, arguments: parsed.arguments }
          : { name: parsed.name };
      } catch {
        return { invalidArguments: true };
      }
    }),
  };
}

function checkFinalAnswer(
  kind: Extract<Scenario, { expected: "FINAL" }>["answerCheck"],
  text: string,
): boolean {
  switch (kind) {
    case "DATE_CLARIFICATION":
      return isDateClarification(text);
    case "GOAL_REFUSAL":
      return isGoalNotObservationResponse(text);
    case "CORRECTION_UNAVAILABLE":
      return isCorrectionUnavailableResponse(text);
    case "HISTORY_UNCERTAIN":
      return isCanonicalHistoryUncertainResponse(text);
  }
}

it.each(scenarios)(
  "$name",
  async (scenario) => {
    const apiKey = requiredEnvironment("OPENAI_API_KEY");
    const modelName = requiredEnvironment("OPENAI_MODEL");
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 });
    const model = createOpenAIFoodDayTurnModel({ client, model: modelName });
    const input = {
      state,
      userMessage: scenario.userMessage,
      recentTranscript: scenario.recentTranscript ?? [],
    };
    let actual: object = { type: "NO_DECISION" };
    let finalAnswer: string | undefined;

    try {
      // One paid decision; only A makes one additional tool-free finalization call.
      const decision = await model.decide(input);
      actual = summary(decision);
      if (scenario.expected === "FINAL") {
        if (
          decision.type !== "FINAL" ||
          !checkFinalAnswer(scenario.answerCheck, decision.text)
        ) {
          throw new EvalMismatch(
            "expected a safe FINAL answer with zero tools",
          );
        }
        return;
      }

      if (!isExactWeightToolDecision(decision, scenario.arguments)) {
        throw new EvalMismatch(
          "expected exactly one LOG_BODY_WEIGHT call with exact arguments",
        );
      }
      if (!scenario.finalize) return;

      const authoritative: FoodDayToolResult = {
        name: "LOG_BODY_WEIGHT",
        result: {
          disposition: "CREATED",
          weightEntry: {
            id: "20000000-0000-4000-8000-000000000001",
            localDate: "2026-10-05",
            sourceValue: "80.4",
            sourceUnit: "KG",
            weightKg: "80.4",
            createdAt: "2026-10-05T12:00:00.000Z",
          },
        },
      };
      finalAnswer = await model.finalize({
        ...input,
        toolResults: [authoritative],
      });
      if (!isSuccessfulWeightAcknowledgement(finalAnswer)) {
        throw new EvalMismatch(
          "final answer did not safely acknowledge the recorded observation",
        );
      }
    } catch (error) {
      // SDK errors may include secrets or request data; expose only their type.
      const failure =
        error instanceof EvalMismatch
          ? error.message
          : error instanceof Error
            ? error.name
            : "UnknownError";
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `${scenario.name}: expected=${JSON.stringify(scenario.expected === "TOOLS" ? { type: "TOOLS", calls: [{ name: "LOG_BODY_WEIGHT", arguments: scenario.arguments }] } : { type: "FINAL", answerCheck: scenario.answerCheck })}; actual=${JSON.stringify(actual)}; finalExcerpt=${finalAnswer === undefined ? "none" : JSON.stringify(boundedAnswerExcerpt(finalAnswer))}; failure=${failure}`,
      );
    }
  },
  75_000,
);
