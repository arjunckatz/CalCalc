import OpenAI from "openai";
import { beforeAll, it } from "vitest";

import {
  createOpenAIFoodDayTurnModel,
  OpenAIFoodDayModelProtocolError,
} from "../agent/providers/openai/openai-food-day-turn-model.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";
import type { FoodDayModelDecision } from "../agent/turn/food-day-turn-types.js";
import {
  boundedAnswerExcerpt,
  isExactHistoryReadToolDecision,
} from "./body-weight-semantics-eval-assertions.js";
import {
  isAmbiguousLatestDateAnswer,
  isBoundedOlderDateAnswer,
  isEmptyCanonicalHistoryAnswer,
  isExactLogOnlyDecision,
  isExactLogThenHistoryDecision,
  isFreshLogAndHistoryAnswer,
  isFreshStaleRepairAnswer,
  isOneLatestObservationAnswer,
  isRawRecentHistoryAnswer,
  isTrendLimitationAnswer,
} from "./body-weight-history-eval-assertions.js";
import {
  historyEvalScenarios,
  historyEvalState,
  type HistoryEvalScenario,
} from "./body-weight-history-eval-fixtures.js";
import {
  completeHistoryEvalTurn,
  HistoryEvalFlowMismatch,
} from "./body-weight-history-eval-flow.js";

function requiredEnvironment(name: "OPENAI_API_KEY" | "OPENAI_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this opt-in live eval.`);
  return value;
}

class EvalMismatch extends Error {
  override readonly name = "EvalMismatch";
}

let apiKey: string;
let modelId: string;
beforeAll(() => {
  apiKey = requiredEnvironment("OPENAI_API_KEY");
  modelId = requiredEnvironment("OPENAI_MODEL");
});

function decisionSummary(decision: FoodDayModelDecision): object {
  if (decision.type === "FINAL") {
    return { type: "FINAL", excerpt: boundedAnswerExcerpt(decision.text) };
  }
  return {
    type: "TOOLS",
    count: decision.calls.length,
    calls: decision.calls.slice(0, 8).map((call) => {
      try {
        const parsed = parseFoodDayToolCall(call);
        return parsed.name === "LOG_BODY_WEIGHT"
          ? {
              name: parsed.name,
              arguments: {
                localDate: parsed.arguments.localDate.slice(0, 10),
                sourceValue: parsed.arguments.sourceValue.slice(0, 24),
                sourceUnit: parsed.arguments.sourceUnit,
              },
            }
          : { name: parsed.name, arguments: {} };
      } catch {
        const value =
          call !== null && typeof call === "object"
            ? (call as Record<string, unknown>)
            : {};
        const argumentsValue = value.arguments;
        const keys =
          argumentsValue !== null &&
          typeof argumentsValue === "object" &&
          !Array.isArray(argumentsValue)
            ? Object.keys(argumentsValue)
            : [];
        return {
          name:
            value.name === "LOG_BODY_WEIGHT" ||
            value.name === "GET_BODY_WEIGHT_HISTORY"
              ? value.name
              : "OTHER_TOOL",
          invalidToolCall: true,
          argumentCount: keys.length,
          recognizedUnexpectedKeys: keys.filter((key) =>
            ["limit", "localDate", "userId", "foo"].includes(key),
          ),
        };
      }
    }),
  };
}

function expectedSummary(scenario: HistoryEvalScenario): object {
  switch (scenario.expectedDecision) {
    case "HISTORY_READ":
      return {
        type: "TOOLS",
        calls: [{ name: "GET_BODY_WEIGHT_HISTORY", arguments: {} }],
      };
    case "LOG_THEN_READ":
      return {
        initial:
          "LOG_BODY_WEIGHT optionally followed by GET_BODY_WEIGHT_HISTORY",
        continuation: "GET_BODY_WEIGHT_HISTORY after LOG-only",
      };
    case "FINAL":
      return { type: "FINAL", tools: 0 };
    case null:
      return {
        decision: "NONE",
        continuation: "fresh GET after stale GET/LOG",
      };
  }
}

function validFinalAnswer(
  id: HistoryEvalScenario["id"],
  text: string,
): boolean {
  switch (id) {
    case "A":
      return isEmptyCanonicalHistoryAnswer(text);
    case "B":
      return isOneLatestObservationAnswer(text);
    case "C":
      return isAmbiguousLatestDateAnswer(text);
    case "D":
      return isRawRecentHistoryAnswer(text);
    case "E":
      return isBoundedOlderDateAnswer(text);
    case "F":
      return isFreshLogAndHistoryAnswer(text);
    case "G":
      return isTrendLimitationAnswer(text);
    case "H":
      return isFreshStaleRepairAnswer(text);
  }
}

const semanticFailureReason: Record<HistoryEvalScenario["id"], string> = {
  A: "empty canonical history was not distinguished from transcript weight",
  B: "unique latest-date weight or date was missing, wrong, or embellished",
  C: "same-date multiplicity was not preserved without a unique latest claim",
  D: "raw recent date/weight pairs were missing, mismatched, or derived",
  E: "bounded older-date uncertainty was missing or contradicted",
  F: "successful log or fresh canonical latest answer was missing or wrong",
  G: "unsupported weight-loss calculation was not safely limited",
  H: "fresh post-log canonical history was not used safely",
};

it.each(historyEvalScenarios)(
  "$id: $name",
  async (scenario) => {
    const client = new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: 30_000,
    });
    const model = createOpenAIFoodDayTurnModel({
      client,
      model: modelId,
    });
    const input = {
      state: structuredClone(historyEvalState),
      userMessage: scenario.userMessage,
      recentTranscript: structuredClone(scenario.recentTranscript ?? []),
    };
    let phase: "INITIAL_DECISION" | "POST_TOOL" | "FINAL_FINALIZATION" =
      scenario.expectedDecision === null ? "POST_TOOL" : "INITIAL_DECISION";
    let path = scenario.id === "H" ? "STALE_REPAIR" : "NOT_SELECTED";
    let actualDecision: object = { type: "NOT_CALLED" };
    let finalExcerpt = "none";
    let responsesCalls = 0;
    let initialLogOnly = false;

    try {
      if (scenario.expectedDecision !== null) {
        responsesCalls += 1;
        const decision = await model.decide({
          ...input,
          ...(scenario.calendarContext === undefined
            ? {}
            : { calendarContext: structuredClone(scenario.calendarContext) }),
        });
        actualDecision = decisionSummary(decision);
        if (scenario.expectedDecision === "FINAL") {
          if (
            decision.type !== "FINAL" ||
            !validFinalAnswer(scenario.id, decision.text)
          ) {
            throw new EvalMismatch(
              "expected a safe FINAL answer with zero tools",
            );
          }
          if (responsesCalls !== scenario.maxResponsesCalls) {
            throw new EvalMismatch("unexpected Responses-call count");
          }
          return;
        }
        initialLogOnly =
          scenario.id === "F" && isExactLogOnlyDecision(decision);
        if (scenario.id === "F") {
          path = initialLogOnly ? "CONTINUATION_RECOVERY" : "INITIAL_BATCH";
        }
        const validDecision =
          scenario.expectedDecision === "HISTORY_READ"
            ? isExactHistoryReadToolDecision(decision)
            : initialLogOnly || isExactLogThenHistoryDecision(decision);
        if (!validDecision) {
          throw new EvalMismatch(
            "decision tool names, order, or arguments differ",
          );
        }
      }

      const completion = await completeHistoryEvalTurn(
        model,
        scenario,
        input,
        initialLogOnly,
        (nextPhase) => {
          phase = nextPhase;
        },
      );
      responsesCalls += completion.modelCalls;
      const answer = completion.answer;
      finalExcerpt = boundedAnswerExcerpt(answer);
      if (!validFinalAnswer(scenario.id, answer)) {
        throw new EvalMismatch(semanticFailureReason[scenario.id]);
      }
      if (responsesCalls > scenario.maxResponsesCalls) {
        throw new EvalMismatch("unexpected Responses-call count");
      }
    } catch (error) {
      // Never serialize SDK errors, credentials, request input, or tool-result arrays.
      const failure =
        error instanceof EvalMismatch
          ? error.message
          : error instanceof Error
            ? error.name
            : "UnknownError";
      const flowDetails =
        error instanceof HistoryEvalFlowMismatch
          ? `; expectedStep=${JSON.stringify(error.expectedStep)}; actualStep=${JSON.stringify(error.actualStep)}`
          : error instanceof OpenAIFoodDayModelProtocolError
            ? `; actualStep=${JSON.stringify({ type: "PROVIDER_PROTOCOL_ERROR", reason: error.reason })}`
            : "";
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `${scenario.id}: phase=${phase}; path=${path}; expected=${JSON.stringify(expectedSummary(scenario))}; actual=${JSON.stringify(actualDecision)}; finalExcerpt=${JSON.stringify(finalExcerpt)}; failure=${failure}${flowDetails}`,
      );
    }
  },
  75_000,
);
