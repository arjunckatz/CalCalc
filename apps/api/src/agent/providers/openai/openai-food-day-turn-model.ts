import type OpenAI from "openai";
import type {
  Response,
  ResponseInputItem,
} from "openai/resources/responses/responses";

import type { FoodDayToolCall } from "../../tools/food-day-tools.js";
import type {
  FoodDayModelDecision,
  FoodDayModelDecisionInput,
  FoodDayModelFinalizationInput,
  FoodDayTurnModel,
} from "../../turn/food-day-turn-types.js";
import type { FoodDayState } from "../../../state/build-food-day-state.js";
import {
  normalizeOpenAIFoodDayToolArguments,
  openAIFoodDayTools,
} from "./food-day-tool-schemas.js";
import { decisionInstructions, finalizationInstructions } from "./prompts.js";

export interface OpenAIFoodDayTurnModelConfig {
  readonly client: OpenAI;
  readonly model: string;
}

type ProtocolReason =
  | "INVALID_RESPONSE"
  | "UNSUPPORTED_FUNCTION"
  | "INVALID_FUNCTION_ARGUMENTS"
  | "EMPTY_TEXT"
  | "UNEXPECTED_FUNCTION_CALL";

const protocolMessages: Record<ProtocolReason, string> = {
  INVALID_RESPONSE: "OpenAI returned an unusable FoodDay response.",
  UNSUPPORTED_FUNCTION: "OpenAI returned an unsupported FoodDay function.",
  INVALID_FUNCTION_ARGUMENTS:
    "OpenAI returned invalid FoodDay function arguments.",
  EMPTY_TEXT: "OpenAI returned no usable FoodDay text.",
  UNEXPECTED_FUNCTION_CALL:
    "OpenAI returned a function call during FoodDay finalization.",
};

export class OpenAIFoodDayModelProtocolError extends Error {
  override readonly name = "OpenAIFoodDayModelProtocolError";

  constructor(readonly reason: ProtocolReason) {
    super(protocolMessages[reason]);
  }
}

/** Provider binding only; trusted tool execution remains with M4B2 and M4B1. */
export function createOpenAIFoodDayTurnModel({
  client,
  model,
}: OpenAIFoodDayTurnModelConfig): FoodDayTurnModel {
  if (typeof model !== "string" || model.trim() === "") {
    throw new TypeError("An OpenAI model ID is required.");
  }
  const modelId = model.trim();
  return {
    async decide(
      input: FoodDayModelDecisionInput,
    ): Promise<FoodDayModelDecision> {
      const response = await client.responses.create({
        model: modelId,
        instructions: decisionInstructions,
        input: decisionInput(input),
        tools: openAIFoodDayTools,
        tool_choice: "auto",
        store: false,
      });
      assertUsableResponse(response);
      const calls: unknown[] = [];
      for (const item of response.output) {
        if (item.type !== "function_call") continue;
        const name = supportedToolName(item.name);
        let argumentsValue: unknown;
        try {
          argumentsValue = JSON.parse(item.arguments);
        } catch {
          // Never retain raw provider arguments in an error or cause.
          throw new OpenAIFoodDayModelProtocolError(
            "INVALID_FUNCTION_ARGUMENTS",
          );
        }
        calls.push({
          name,
          arguments: normalizeOpenAIFoodDayToolArguments(name, argumentsValue),
        });
      }
      if (calls.length > 0) return { type: "TOOLS", calls };
      return { type: "FINAL", text: usableText(response.output_text) };
    },

    async finalize(input: FoodDayModelFinalizationInput): Promise<string> {
      const response = await client.responses.create({
        model: modelId,
        instructions: finalizationInstructions,
        input: finalizationInput(input),
        store: false,
      });
      assertUsableResponse(response);
      if (response.output.some((item) => item.type === "function_call")) {
        throw new OpenAIFoodDayModelProtocolError("UNEXPECTED_FUNCTION_CALL");
      }
      return usableText(response.output_text);
    },
  };
}

function decisionInput(
  input: FoodDayModelDecisionInput,
): string | ResponseInputItem[] {
  const state = stateForModel(input.state);
  if (
    input.recentTranscript.length === 0 &&
    input.calendarContext === undefined
  ) {
    return JSON.stringify({ state, userMessage: input.userMessage });
  }
  const authoritativeContext = JSON.stringify({ canonicalFoodDayState: state });
  return conversationalInput(
    input.calendarContext === undefined
      ? authoritativeContext
      : `${authoritativeContext}\nCURRENT CALENDAR CONTEXT:\n${JSON.stringify(input.calendarContext)}`,
    input.recentTranscript,
    input.userMessage,
  );
}

function finalizationInput(
  input: FoodDayModelFinalizationInput,
): string | ResponseInputItem[] {
  const stateBeforeMutations = stateForModel(input.state);
  if (input.recentTranscript.length === 0) {
    return JSON.stringify({
      stateBeforeMutations,
      userMessage: input.userMessage,
      toolResults: input.toolResults,
    });
  }
  return conversationalInput(
    JSON.stringify({ stateBeforeMutations, toolResults: input.toolResults }),
    input.recentTranscript,
    input.userMessage,
  );
}

function conversationalInput(
  authoritativeContext: string,
  recentTranscript: FoodDayModelDecisionInput["recentTranscript"],
  currentUserMessage: string,
): ResponseInputItem[] {
  return [
    { role: "developer", content: authoritativeContext },
    ...recentTranscript.flatMap(({ userMessage, response }) => [
      { role: "user" as const, content: userMessage },
      { role: "assistant" as const, content: response },
    ]),
    { role: "user", content: currentUserMessage },
  ];
}

function assertUsableResponse(response: Response): void {
  if (response.status !== "completed" || !Array.isArray(response.output)) {
    throw new OpenAIFoodDayModelProtocolError("INVALID_RESPONSE");
  }
}

function supportedToolName(name: string): FoodDayToolCall["name"] {
  if (
    name === "LOG_FOOD" ||
    name === "UPDATE_FOOD_QUANTITY" ||
    name === "REMOVE_FOOD" ||
    name === "CHANGE_FOOD_STATUS" ||
    name === "SET_FOOD_DAY_COMPLETENESS" ||
    name === "LOG_BODY_WEIGHT" ||
    name === "GET_BODY_WEIGHT_HISTORY"
  ) {
    return name;
  }
  throw new OpenAIFoodDayModelProtocolError("UNSUPPORTED_FUNCTION");
}

function usableText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OpenAIFoodDayModelProtocolError("EMPTY_TEXT");
  }
  return value.trim();
}

/** Explicit projection keeps provider input limited to canonical STATE fields. */
function stateForModel(state: FoodDayState) {
  return {
    foodDay: {
      id: state.foodDay.id,
      localDate: state.foodDay.localDate,
      status: state.foodDay.status,
      completeness: state.foodDay.completeness,
      targets: {
        calories: state.foodDay.targets.calories,
        protein: state.foodDay.targets.protein,
      },
    },
    totals: {
      confirmed: {
        calories: state.totals.confirmed.calories,
        protein: state.totals.confirmed.protein,
        hasUnknownProtein: state.totals.confirmed.hasUnknownProtein,
      },
    },
    targetProgress: {
      calories: {
        remainingToTarget: state.targetProgress.calories.remainingToTarget,
        overTargetBy: state.targetProgress.calories.overTargetBy,
      },
      protein: {
        remainingToTarget: state.targetProgress.protein.remainingToTarget,
        overTargetBy: state.targetProgress.protein.overTargetBy,
      },
    },
    entries: state.entries.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      rawUserDescription: entry.rawUserDescription,
      quantity: { amount: entry.quantity.amount, unit: entry.quantity.unit },
      status: entry.status,
      workingNutrition: {
        calories: entry.workingNutrition.calories,
        protein: entry.workingNutrition.protein,
        carbs: entry.workingNutrition.carbs,
        fat: entry.workingNutrition.fat,
        fibre: entry.workingNutrition.fibre,
        sodium: entry.workingNutrition.sodium,
      },
      evidenceClass: entry.evidenceClass,
      revision: entry.revision,
    })),
  };
}
