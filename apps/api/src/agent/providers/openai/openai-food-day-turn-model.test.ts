import type OpenAI from "openai";
import { createFoodEntry } from "@cal-calc/domain";
import { describe, expect, it, vi } from "vitest";

import type { FoodDayState } from "../../../state/build-food-day-state.js";
import type { FoodDayToolResult } from "../../tools/execute-food-day-tool.js";
import {
  parseFoodDayToolCall,
  ToolValidationError,
} from "../../tools/food-day-tools.js";
import {
  createOpenAIFoodDayTurnModel,
  OpenAIFoodDayModelProtocolError,
} from "./openai-food-day-turn-model.js";

const state: FoodDayState = {
  foodDay: {
    id: "20000000-0000-4000-8000-000000000001",
    localDate: "2026-09-18",
    status: "OPEN",
    completeness: "USER_DECLARED_COMPLETE",
    targets: { calories: "2400", protein: "120" },
  },
  totals: {
    confirmed: { calories: "400", protein: "20", hasUnknownProtein: false },
  },
  entries: [
    {
      id: "30000000-0000-4000-8000-000000000001",
      displayName: "Lunch",
      rawUserDescription: "Had lunch",
      quantity: { amount: "1", unit: "SERVING" },
      status: "CONFIRMED_CONSUMED",
      workingNutrition: { calories: "400", protein: "20" },
      evidenceClass: "EXACT",
      revision: 1,
    },
  ],
};
const toolResults: readonly FoodDayToolResult[] = [
  {
    name: "LOG_FOOD",
    result: {
      disposition: "CREATED",
      entry: createFoodEntry({
        id: "40000000-0000-4000-8000-000000000001",
        foodDayId: state.foodDay.id,
        rawUserDescription: "Apple",
        displayName: "Apple",
        quantity: { amount: "1", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "95" },
        },
        evidenceClass: "SOURCED",
        status: "CONFIRMED_CONSUMED",
      }),
    },
  },
];

function response(
  output_text = "Done.",
  output: unknown[] = [],
  status = "completed",
) {
  return {
    status,
    output_text,
    output,
    id: "resp_private",
    usage: { total_tokens: 10 },
  };
}

function functionCall(name: string, args: unknown, call_id = "call_private") {
  return {
    type: "function_call",
    name,
    arguments: JSON.stringify(args),
    call_id,
    id: "fc_private",
  };
}

function setup(initial = response()) {
  const create = vi.fn<(request: unknown) => Promise<unknown>>();
  create.mockResolvedValue(initial);
  const client = { responses: { create } } as unknown as OpenAI;
  const model = createOpenAIFoodDayTurnModel({ client, model: "test-model" });
  return { create, model };
}

function requestAt(create: ReturnType<typeof setup>["create"], index = 0) {
  return create.mock.calls[index]![0] as Record<string, unknown>;
}

describe("OpenAI FoodDay decision binding", () => {
  it("requires an injected nonblank model but makes no request on construction", () => {
    const { create } = setup();
    expect(create).not.toHaveBeenCalled();
    expect(() =>
      createOpenAIFoodDayTurnModel({
        client: { responses: { create } } as unknown as OpenAI,
        model: "   ",
      }),
    ).toThrow(TypeError);
  });

  it("uses the injected model and distinct decision instructions", async () => {
    const { create, model } = setup();
    await model.decide({ userMessage: "Hello", state });
    const request = requestAt(create);
    expect(request.model).toBe("test-model");
    expect(request.instructions).toContain("canonical FoodDay STATE");
    expect(request.instructions).toContain("do not invent");
  });

  it("serializes only canonical STATE facts and the current message as stable JSON", async () => {
    const { create, model } = setup();
    await model.decide({ userMessage: "Add lunch", state });
    const input = JSON.parse(requestAt(create).input as string);
    expect(input.userMessage).toBe("Add lunch");
    expect(input.state).toEqual(state);
    expect(input.state.entries[0]).toMatchObject({
      id: state.entries[0]?.id,
      revision: 1,
      quantity: { amount: "1", unit: "SERVING" },
      status: "CONFIRMED_CONSUMED",
      workingNutrition: { calories: "400", protein: "20" },
      evidenceClass: "EXACT",
    });
    expect(
      (requestAt(create).input as string).includes("[object Object]"),
    ).toBe(false);
  });

  it("does not serialize additional runtime fields outside FoodDayState", async () => {
    const { create, model } = setup();
    const extended = { ...state, secret: "do-not-send" };
    await model.decide({ userMessage: "Hello", state: extended });
    expect(requestAt(create).input).not.toContain("do-not-send");
  });

  it("offers exactly three functions with auto selection and disables response storage", async () => {
    const { create, model } = setup();
    await model.decide({ userMessage: "Hello", state });
    const request = requestAt(create);
    expect(
      (request.tools as { name: string }[]).map((tool) => tool.name),
    ).toEqual(["LOG_FOOD", "UPDATE_FOOD_QUANTITY", "REMOVE_FOOD"]);
    expect(request.tool_choice).toBe("auto");
    expect(request.store).toBe(false);
  });

  it("sends no provider conversation or previous response ID", async () => {
    const { create, model } = setup();
    await model.decide({ userMessage: "Hello", state });
    expect(requestAt(create)).not.toHaveProperty("previous_response_id");
    expect(requestAt(create)).not.toHaveProperty("conversation");
  });

  it("maps trimmed text-only output to FINAL without fabricating a tool call", async () => {
    const { model } = setup(response("  No change needed.  "));
    expect(await model.decide({ userMessage: "Hello", state })).toEqual({
      type: "FINAL",
      text: "No change needed.",
    });
  });

  it.each(["", "  "])("rejects unusable decision text %j", async (text) => {
    const { model } = setup(response(text));
    await expect(
      model.decide({ userMessage: "Hello", state }),
    ).rejects.toMatchObject({
      name: "OpenAIFoodDayModelProtocolError",
      reason: "EMPTY_TEXT",
    });
  });

  it.each(["LOG_FOOD", "UPDATE_FOOD_QUANTITY", "REMOVE_FOOD"] as const)(
    "maps provider %s into an untrusted M4B1-compatible call",
    async (name) => {
      const args =
        name === "LOG_FOOD"
          ? {
              rawUserDescription: "Apple",
              displayName: "Apple",
              quantity: { amount: "1", unit: "SERVING" },
              nutritionBasis: {
                amount: "1",
                unit: "SERVING",
                nutrition: { calories: "95" },
              },
              evidenceClass: "SOURCED",
            }
          : name === "UPDATE_FOOD_QUANTITY"
            ? {
                entryId: state.entries[0]?.id,
                expectedRevision: 1,
                quantity: { amount: "2", unit: "SERVING" },
                overrideAction: { type: "PRESERVE" },
              }
            : { entryId: state.entries[0]?.id, expectedRevision: 1 };
      const { model } = setup(response("", [functionCall(name, args)]));
      const decision = await model.decide({ userMessage: "Change", state });
      expect(decision).toEqual({
        type: "TOOLS",
        calls: [{ name, arguments: args }],
      });
      if (decision.type === "TOOLS") {
        expect(parseFoodDayToolCall(decision.calls[0])).toMatchObject({ name });
      }
    },
  );

  it("preserves multiple provider function calls in output order", async () => {
    const calls = [
      functionCall(
        "REMOVE_FOOD",
        { entryId: state.entries[0]?.id, expectedRevision: 1 },
        "call_1",
      ),
      functionCall(
        "UPDATE_FOOD_QUANTITY",
        {
          entryId: state.entries[0]?.id,
          expectedRevision: 1,
          quantity: { amount: "2", unit: "SERVING" },
          overrideAction: { type: "CLEAR" },
        },
        "call_2",
      ),
    ];
    const { model } = setup(response("", calls));
    const decision = await model.decide({ userMessage: "Change", state });
    expect(decision.type).toBe("TOOLS");
    if (decision.type === "TOOLS") {
      expect(
        decision.calls.map((call) => (call as { name: string }).name),
      ).toEqual(["REMOVE_FOOD", "UPDATE_FOOD_QUANTITY"]);
    }
  });

  it("ignores incidental decision text when a function call exists", async () => {
    const { model } = setup(
      response("Do not surface this.", [
        functionCall("REMOVE_FOOD", {
          entryId: state.entries[0]?.id,
          expectedRevision: 1,
        }),
      ]),
    );
    expect((await model.decide({ userMessage: "Remove", state })).type).toBe(
      "TOOLS",
    );
  });

  it("does not return provider call IDs or response metadata", async () => {
    const { model } = setup(
      response("", [
        functionCall("REMOVE_FOOD", {
          entryId: state.entries[0]?.id,
          expectedRevision: 1,
        }),
      ]),
    );
    const decision = await model.decide({ userMessage: "Remove", state });
    expect(JSON.stringify(decision)).not.toMatch(
      /call_private|fc_private|resp_private|total_tokens/,
    );
    if (decision.type === "TOOLS") {
      expect(Object.keys(decision.calls[0] as object)).toEqual([
        "name",
        "arguments",
      ]);
    }
  });

  it("rejects malformed function argument JSON without exposing the raw argument text", async () => {
    const rawArguments = "{secret-token-malformed";
    const { model } = setup(
      response("", [
        { ...functionCall("LOG_FOOD", {}), arguments: rawArguments },
      ]),
    );
    const error = await model
      .decide({ userMessage: "Log", state })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(OpenAIFoodDayModelProtocolError);
    expect(error).toMatchObject({ reason: "INVALID_FUNCTION_ARGUMENTS" });
    expect(JSON.stringify(error)).not.toContain(rawArguments);
    expect((error as Error).message).not.toContain(rawArguments);
  });

  it("leaves valid JSON with semantically invalid arguments for M4B1 to reject", async () => {
    const { model } = setup(
      response("", [functionCall("REMOVE_FOOD", { entryId: "bad" })]),
    );
    const decision = await model.decide({ userMessage: "Remove", state });
    expect(decision.type).toBe("TOOLS");
    if (decision.type === "TOOLS") {
      expect(() => parseFoodDayToolCall(decision.calls[0])).toThrow(
        ToolValidationError,
      );
    }
  });

  it("rejects an unoffered function rather than treating it as text", async () => {
    const { model } = setup(response("Text", [functionCall("DELETE_ALL", {})]));
    await expect(
      model.decide({ userMessage: "Hi", state }),
    ).rejects.toMatchObject({
      reason: "UNSUPPORTED_FUNCTION",
    });
  });

  it("rejects an incomplete provider response as a protocol error", async () => {
    const { model } = setup(response("Partial", [], "incomplete"));
    await expect(
      model.decide({ userMessage: "Hi", state }),
    ).rejects.toMatchObject({
      reason: "INVALID_RESPONSE",
    });
  });

  it("propagates the original SDK/API error unchanged", async () => {
    const { create, model } = setup();
    const sdkError = new Error("network failure");
    create.mockRejectedValueOnce(sdkError);
    await expect(model.decide({ userMessage: "Hi", state })).rejects.toBe(
      sdkError,
    );
  });
});

describe("OpenAI FoodDay finalization binding", () => {
  it("makes a new response request with the original STATE, message, and rich tool results", async () => {
    const { create, model } = setup();
    await model.finalize({ userMessage: "Add apple", state, toolResults });
    const request = requestAt(create);
    expect(request.model).toBe("test-model");
    expect(request.instructions).toContain("Tool results are authoritative");
    expect(JSON.parse(request.input as string)).toEqual({
      stateBeforeMutations: state,
      userMessage: "Add apple",
      toolResults,
    });
  });

  it("offers no function tools, provider conversation state, or response storage", async () => {
    const { create, model } = setup();
    await model.finalize({ userMessage: "Add apple", state, toolResults });
    const request = requestAt(create);
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("previous_response_id");
    expect(request).not.toHaveProperty("conversation");
    expect(request.store).toBe(false);
  });

  it("returns trimmed provider text only, without metadata", async () => {
    const { model } = setup(response("  Apple recorded.  "));
    expect(
      await model.finalize({ userMessage: "Add apple", state, toolResults }),
    ).toBe("Apple recorded.");
  });

  it("rejects blank final text", async () => {
    const { model } = setup(response("   "));
    await expect(
      model.finalize({ userMessage: "Hi", state, toolResults }),
    ).rejects.toMatchObject({
      reason: "EMPTY_TEXT",
    });
  });

  it("rejects an unexpected finalization function call even if text is present", async () => {
    const { model } = setup(response("Done", [functionCall("LOG_FOOD", {})]));
    await expect(
      model.finalize({ userMessage: "Hi", state, toolResults }),
    ).rejects.toMatchObject({
      reason: "UNEXPECTED_FUNCTION_CALL",
    });
  });

  it("propagates the original finalization SDK/API error unchanged", async () => {
    const { create, model } = setup();
    const sdkError = new Error("provider unavailable");
    create.mockRejectedValueOnce(sdkError);
    await expect(
      model.finalize({ userMessage: "Hi", state, toolResults }),
    ).rejects.toBe(sdkError);
  });
});
