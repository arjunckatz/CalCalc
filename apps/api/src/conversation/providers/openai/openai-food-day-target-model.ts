import type OpenAI from "openai";

import type {
  FoodDayTargetResolutionModel,
  RawFoodDayTargetDecision,
} from "../../resolve-food-day-target.js";
import { foodDayTargetInstructions } from "./food-day-target-prompt.js";

export interface OpenAIFoodDayTargetModelConfig {
  readonly client: OpenAI;
  readonly model: string;
}

export type OpenAIFoodDayTargetModelErrorReason =
  "PROVIDER_FAILURE" | "INVALID_RESPONSE";

export class OpenAIFoodDayTargetModelError extends Error {
  override readonly name = "OpenAIFoodDayTargetModelError";
  constructor(readonly reason: OpenAIFoodDayTargetModelErrorReason) {
    super(`FoodDay target model failed: ${reason}.`);
  }
}

const variant = (kind: string, field?: string) => ({
  type: "object",
  properties: {
    kind: { type: "string", enum: [kind] },
    ...(field === undefined ? {} : { [field]: { type: "string" } }),
  },
  required: field === undefined ? ["kind"] : ["kind", field],
  additionalProperties: false,
});

const decisionFormat = {
  type: "json_schema" as const,
  name: "food_day_target_decision",
  strict: true,
  schema: {
    type: "object",
    properties: {
      decision: {
        anyOf: [
          variant("EXISTING_DAY", "dayToken"),
          variant("EXISTING_ENTRY_REFERENCE", "entryToken"),
          variant("DATE_TARGET", "localDate"),
          variant("DAYLESS"),
          variant("CLARIFY", "question"),
        ],
      },
    },
    required: ["decision"],
    additionalProperties: false,
  },
};

/** One tool-free, stateless Responses decision; validation remains application-owned. */
export function createOpenAIFoodDayTargetModel({
  client,
  model,
}: OpenAIFoodDayTargetModelConfig): FoodDayTargetResolutionModel {
  if (typeof model !== "string" || model.trim() === "")
    throw new TypeError("An OpenAI model ID is required.");
  const modelId = model.trim();
  return {
    async decide(input) {
      let response;
      try {
        response = await client.responses.create({
          model: modelId,
          instructions: foodDayTargetInstructions,
          input: [
            {
              role: "developer",
              content: JSON.stringify({
                acceptedCalendarContext: input.calendarContext,
                canonicalRoutingSnapshot: input.routing,
              }),
            },
            { role: "user", content: input.message },
          ],
          text: { format: decisionFormat },
          store: false,
        });
      } catch {
        // Never expose an SDK error's request, prompt, token, or cause.
        throw new OpenAIFoodDayTargetModelError("PROVIDER_FAILURE");
      }
      if (
        response.status !== "completed" ||
        !Array.isArray(response.output) ||
        response.output.some((item) => item.type === "function_call") ||
        typeof response.output_text !== "string"
      )
        throw new OpenAIFoodDayTargetModelError("INVALID_RESPONSE");
      try {
        const parsed: unknown = JSON.parse(response.output_text);
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.keys(parsed).length !== 1 ||
          !("decision" in parsed)
        )
          throw new Error("Malformed structured output.");
        if (!isRawDecision(parsed.decision))
          throw new Error("Malformed decision.");
        return parsed.decision;
      } catch {
        throw new OpenAIFoodDayTargetModelError("INVALID_RESPONSE");
      }
    },
  };
}

function isRawDecision(value: unknown): value is RawFoodDayTargetDecision {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  switch (record.kind) {
    case "EXISTING_DAY":
      return (
        keys.length === 2 &&
        keys.includes("dayToken") &&
        typeof record.dayToken === "string"
      );
    case "EXISTING_ENTRY_REFERENCE":
      return (
        keys.length === 2 &&
        keys.includes("entryToken") &&
        typeof record.entryToken === "string"
      );
    case "DATE_TARGET":
      return (
        keys.length === 2 &&
        keys.includes("localDate") &&
        typeof record.localDate === "string"
      );
    case "DAYLESS":
      return keys.length === 1;
    case "CLARIFY":
      return (
        keys.length === 2 &&
        keys.includes("question") &&
        typeof record.question === "string"
      );
    default:
      return false;
  }
}
