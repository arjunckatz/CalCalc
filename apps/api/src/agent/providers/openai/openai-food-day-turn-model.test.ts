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
  targetProgress: {
    calories: { remainingToTarget: "2000", overTargetBy: "0" },
    protein: { remainingToTarget: "100", overTargetBy: "0" },
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
const emptyTranscript = [] as const;
const recentTranscript = [
  { userMessage: "  I had yogurt.  ", response: "  Logged yogurt.  " },
  { userMessage: "Make it 200 g.", response: "Updated to 200 g." },
] as const;

function decisionInput(
  userMessage: string,
  selectedState: FoodDayState = state,
) {
  return {
    userMessage,
    state: selectedState,
    recentTranscript: emptyTranscript,
  };
}

function finalizationInput(userMessage: string) {
  return {
    userMessage,
    state,
    recentTranscript: emptyTranscript,
    toolResults,
  };
}

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
    await model.decide(decisionInput("Hello"));
    const request = requestAt(create);
    expect(request.model).toBe("test-model");
    expect(request.instructions).toContain("canonical FoodDay STATE");
    expect(request.instructions).toContain("do not invent");
  });

  it("serializes only canonical STATE facts and the current message as stable JSON", async () => {
    const { create, model } = setup();
    await model.decide(decisionInput("Add lunch"));
    const input = JSON.parse(requestAt(create).input as string);
    expect(input.userMessage).toBe("Add lunch");
    expect(input.state).toEqual(state);
    expect(input.state.foodDay.completeness).toBe("USER_DECLARED_COMPLETE");
    expect(input.state.targetProgress).toEqual({
      calories: { remainingToTarget: "2000", overTargetBy: "0" },
      protein: { remainingToTarget: "100", overTargetBy: "0" },
    });
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

  it("preserves unknown protein progress and incomplete-day context in provider STATE", async () => {
    const { create, model } = setup();
    const partialState: FoodDayState = {
      ...state,
      foodDay: { ...state.foodDay, completeness: "PARTIAL" },
      totals: {
        confirmed: {
          calories: "400",
          protein: null,
          hasUnknownProtein: true,
        },
      },
      targetProgress: {
        ...state.targetProgress,
        protein: { remainingToTarget: null, overTargetBy: null },
      },
    };
    await model.decide(
      decisionInput("How much protein is left?", partialState),
    );
    const input = JSON.parse(requestAt(create).input as string);
    expect(input.state.foodDay.completeness).toBe("PARTIAL");
    expect(input.state.totals.confirmed.protein).toBeNull();
    expect(input.state.targetProgress.protein).toEqual({
      remainingToTarget: null,
      overTargetBy: null,
    });
  });

  it("represents transcript as ordered user/assistant messages before the exact current user message", async () => {
    const { create, model } = setup();
    await model.decide({
      userMessage: "  Actually 250 g.  ",
      state,
      recentTranscript,
    });

    const request = requestAt(create);
    expect(request.input).toEqual([
      {
        role: "developer",
        content: JSON.stringify({ canonicalFoodDayState: state }),
      },
      { role: "user", content: "  I had yogurt.  " },
      { role: "assistant", content: "  Logged yogurt.  " },
      { role: "user", content: "Make it 200 g." },
      { role: "assistant", content: "Updated to 200 g." },
      { role: "user", content: "  Actually 250 g.  " },
    ]);
    expect(request.instructions).toContain(
      "Recent transcript is conversational context only",
    );
    expect(request.instructions).toContain(
      "canonical FoodDay STATE overrides it",
    );
    expect(request.instructions).not.toContain("I had yogurt");
  });

  it.each([
    { label: "without transcript", transcript: emptyTranscript },
    { label: "with transcript", transcript: recentTranscript },
  ])(
    "supplies accepted calendar context as developer decision data $label",
    async ({ transcript }) => {
      const { create, model } = setup();
      await model.decide({
        userMessage: "I weighed 80 kg today.",
        state,
        recentTranscript: transcript,
        calendarContext: { currentLocalDate: "2026-10-06" },
      });
      const input = requestAt(create).input as {
        role: string;
        content: string;
      }[];
      expect(input[0]).toEqual({
        role: "developer",
        content: `${JSON.stringify({ canonicalFoodDayState: state })}\nCURRENT CALENDAR CONTEXT:\n${JSON.stringify({ currentLocalDate: "2026-10-06" })}`,
      });
      expect(input.at(-1)).toEqual({
        role: "user",
        content: "I weighed 80 kg today.",
      });
      expect(state.foodDay).not.toHaveProperty("currentLocalDate");
    },
  );

  it("does not serialize additional runtime fields outside FoodDayState", async () => {
    const { create, model } = setup();
    const extended = { ...state, secret: "do-not-send" };
    await model.decide(decisionInput("Hello", extended));
    expect(requestAt(create).input).not.toContain("do-not-send");
  });

  it("offers exactly seven strict functions, permits multiple calls, and disables response storage", async () => {
    const { create, model } = setup();
    await model.decide(decisionInput("Hello"));
    const request = requestAt(create);
    expect(
      (request.tools as { name: string }[]).map((tool) => tool.name),
    ).toEqual([
      "LOG_FOOD",
      "UPDATE_FOOD_QUANTITY",
      "REMOVE_FOOD",
      "CHANGE_FOOD_STATUS",
      "SET_FOOD_DAY_COMPLETENESS",
      "LOG_BODY_WEIGHT",
      "GET_BODY_WEIGHT_HISTORY",
    ]);
    expect(request.tool_choice).toBe("auto");
    expect(request.parallel_tool_calls).toBe(true);
    expect(
      (request.tools as { strict: boolean }[]).every((tool) => tool.strict),
    ).toBe(true);
    expect(request.store).toBe(false);
  });

  it("sends no provider conversation or previous response ID", async () => {
    const { create, model } = setup();
    await model.decide(decisionInput("Hello"));
    expect(requestAt(create)).not.toHaveProperty("previous_response_id");
    expect(requestAt(create)).not.toHaveProperty("conversation");
  });

  it("maps trimmed text-only output to FINAL without fabricating a tool call", async () => {
    const { model } = setup(response("  No change needed.  "));
    expect(await model.decide(decisionInput("Hello"))).toEqual({
      type: "FINAL",
      text: "No change needed.",
    });
  });

  it.each(["", "  "])("rejects unusable decision text %j", async (text) => {
    const { model } = setup(response(text));
    await expect(model.decide(decisionInput("Hello"))).rejects.toMatchObject({
      name: "OpenAIFoodDayModelProtocolError",
      reason: "EMPTY_TEXT",
    });
  });

  it.each([
    "LOG_FOOD",
    "UPDATE_FOOD_QUANTITY",
    "REMOVE_FOOD",
    "CHANGE_FOOD_STATUS",
    "SET_FOOD_DAY_COMPLETENESS",
    "LOG_BODY_WEIGHT",
    "GET_BODY_WEIGHT_HISTORY",
  ] as const)(
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
            : name === "REMOVE_FOOD"
              ? { entryId: state.entries[0]?.id, expectedRevision: 1 }
              : name === "CHANGE_FOOD_STATUS"
                ? {
                    entryId: state.entries[0]?.id,
                    expectedRevision: 1,
                    status: "PLANNED",
                  }
                : name === "SET_FOOD_DAY_COMPLETENESS"
                  ? { targetCompleteness: "USER_DECLARED_COMPLETE" }
                  : name === "GET_BODY_WEIGHT_HISTORY"
                    ? {}
                    : {
                        localDate: "2026-10-05",
                        sourceValue: "178.5",
                        sourceUnit: "LB",
                      };
      const { model } = setup(response("", [functionCall(name, args)]));
      const decision = await model.decide(decisionInput("Change"));
      expect(decision).toEqual({
        type: "TOOLS",
        calls: [{ name, arguments: args }],
      });
      if (decision.type === "TOOLS") {
        expect(parseFoodDayToolCall(decision.calls[0])).toMatchObject({ name });
      }
    },
  );

  it("maps zero-argument history reads without provider metadata or query parameters", async () => {
    const { model } = setup(
      response("", [functionCall("GET_BODY_WEIGHT_HISTORY", {})]),
    );
    const decision = await model.decide(
      decisionInput("What's my weight history?"),
    );
    expect(decision).toEqual({
      type: "TOOLS",
      calls: [{ name: "GET_BODY_WEIGHT_HISTORY", arguments: {} }],
    });
    expect(JSON.stringify(decision)).not.toMatch(
      /call_private|fc_private|resp_private|total_tokens/,
    );
  });

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
      functionCall(
        "CHANGE_FOOD_STATUS",
        {
          entryId: state.entries[0]?.id,
          expectedRevision: 1,
          status: "PLANNED",
        },
        "call_3",
      ),
    ];
    const { model } = setup(response("", calls));
    const decision = await model.decide(decisionInput("Change"));
    expect(decision.type).toBe("TOOLS");
    if (decision.type === "TOOLS") {
      expect(
        decision.calls.map((call) => (call as { name: string }).name),
      ).toEqual(["REMOVE_FOOD", "UPDATE_FOOD_QUANTITY", "CHANGE_FOOD_STATUS"]);
    }
  });

  it("preserves LOG_BODY_WEIGHT then GET_BODY_WEIGHT_HISTORY from one provider response", async () => {
    const weight = {
      localDate: "2026-10-06",
      sourceValue: "80",
      sourceUnit: "KG",
    };
    const { model } = setup(
      response("", [
        functionCall("LOG_BODY_WEIGHT", weight, "call_weight"),
        functionCall("GET_BODY_WEIGHT_HISTORY", {}, "call_history"),
      ]),
    );
    expect(
      await model.decide(
        decisionInput("I weighed 80 kg today. What's my latest weight?"),
      ),
    ).toEqual({
      type: "TOOLS",
      calls: [
        { name: "LOG_BODY_WEIGHT", arguments: weight },
        { name: "GET_BODY_WEIGHT_HISTORY", arguments: {} },
      ],
    });
  });

  it("rejects a malformed second function call instead of silently dropping it", async () => {
    const { model } = setup(
      response("", [
        functionCall("LOG_BODY_WEIGHT", {
          localDate: "2026-10-06",
          sourceValue: "80",
          sourceUnit: "KG",
        }),
        { ...functionCall("GET_BODY_WEIGHT_HISTORY", {}), arguments: "{bad" },
      ]),
    );
    await expect(
      model.decide(decisionInput("Log and read")),
    ).rejects.toMatchObject({ reason: "INVALID_FUNCTION_ARGUMENTS" });
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
    expect((await model.decide(decisionInput("Remove"))).type).toBe("TOOLS");
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
    const decision = await model.decide(decisionInput("Remove"));
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
      .decide(decisionInput("Log"))
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
    const decision = await model.decide(decisionInput("Remove"));
    expect(decision.type).toBe("TOOLS");
    if (decision.type === "TOOLS") {
      expect(() => parseFoodDayToolCall(decision.calls[0])).toThrow(
        ToolValidationError,
      );
    }
  });

  it("rejects an unoffered function rather than treating it as text", async () => {
    const { model } = setup(response("Text", [functionCall("DELETE_ALL", {})]));
    await expect(model.decide(decisionInput("Hi"))).rejects.toMatchObject({
      reason: "UNSUPPORTED_FUNCTION",
    });
  });

  it("rejects an incomplete provider response as a protocol error", async () => {
    const { model } = setup(response("Partial", [], "incomplete"));
    await expect(model.decide(decisionInput("Hi"))).rejects.toMatchObject({
      reason: "INVALID_RESPONSE",
    });
  });

  it("propagates the original SDK/API error unchanged", async () => {
    const { create, model } = setup();
    const sdkError = new Error("network failure");
    create.mockRejectedValueOnce(sdkError);
    await expect(model.decide(decisionInput("Hi"))).rejects.toBe(sdkError);
  });
});

describe("OpenAI FoodDay finalization binding", () => {
  it("offers only the strict history read during first post-tool finalization", async () => {
    const { create, model } = setup(response("  Logged your weigh-in.  "));
    expect(
      await model.finalizeOrRead(finalizationInput("Log my weight")),
    ).toEqual({
      type: "FINAL",
      text: "Logged your weigh-in.",
    });
    const request = requestAt(create);
    expect(request.tools as { name: string; strict: boolean }[]).toMatchObject([
      { name: "GET_BODY_WEIGHT_HISTORY", strict: true },
    ]);
    expect(request.tool_choice).toBe("auto");
    expect(request.parallel_tool_calls).toBe(false);
    expect(request.store).toBe(false);
    expect(request.instructions).toContain("do not request a redundant read");
  });

  it("parses a strict zero-argument continuation history read", async () => {
    const { model } = setup(
      response("", [functionCall("GET_BODY_WEIGHT_HISTORY", {})]),
    );
    expect(
      await model.finalizeOrRead(finalizationInput("Latest weight?")),
    ).toEqual({
      type: "READ_TOOL",
      call: { name: "GET_BODY_WEIGHT_HISTORY", arguments: {} },
    });
  });

  it("prioritizes a continuation read over incidental response text", async () => {
    const { model } = setup(
      response("Partial answer must not finalize.", [
        functionCall("GET_BODY_WEIGHT_HISTORY", {}),
      ]),
    );
    expect(
      await model.finalizeOrRead(finalizationInput("Latest weight?")),
    ).toEqual({
      type: "READ_TOOL",
      call: { name: "GET_BODY_WEIGHT_HISTORY", arguments: {} },
    });
  });

  it("rejects mutation, extra read arguments, and multiple continuation calls", async () => {
    for (const calls of [
      [functionCall("LOG_BODY_WEIGHT", { sourceValue: "80" })],
      [functionCall("GET_BODY_WEIGHT_HISTORY", { limit: 1 })],
      [functionCall("GET_BODY_WEIGHT_HISTORY", { userId: "other" })],
      [
        functionCall("GET_BODY_WEIGHT_HISTORY", {
          localDate: "2026-10-06",
        }),
      ],
      [functionCall("GET_BODY_WEIGHT_HISTORY", { anything: true })],
      [
        functionCall("GET_BODY_WEIGHT_HISTORY", {}, "call_1"),
        functionCall("GET_BODY_WEIGHT_HISTORY", {}, "call_2"),
      ],
    ]) {
      const { model } = setup(response("", calls));
      await expect(
        model.finalizeOrRead(finalizationInput("Latest weight?")),
      ).rejects.toBeInstanceOf(OpenAIFoodDayModelProtocolError);
    }
  });

  it("offers no tools after a continuation read", async () => {
    const { create, model } = setup(response("80 kg on October 6."));
    await model.finalize(finalizationInput("Latest weight?"));
    expect(requestAt(create)).not.toHaveProperty("tools");
    expect(requestAt(create)).not.toHaveProperty("tool_choice");
    expect(requestAt(create).instructions).toContain(
      "No tools are available in this final step",
    );
  });

  it("finalizes from authoritative tool results without recomputing calendar context", async () => {
    const { create, model } = setup();
    await model.finalize({
      ...finalizationInput("I weighed 80 kg today."),
      calendarContext: { currentLocalDate: "2026-10-06" },
    });
    const input = JSON.parse(requestAt(create).input as string);
    expect(input).not.toHaveProperty("calendarContext");
    expect(input.toolResults).toEqual(toolResults);
  });

  it("makes a new response request with the original STATE, message, and rich tool results", async () => {
    const { create, model } = setup();
    await model.finalize(finalizationInput("Add apple"));
    const request = requestAt(create);
    expect(request.model).toBe("test-model");
    expect(request.instructions).toContain("Tool results are authoritative");
    expect(JSON.parse(request.input as string)).toEqual({
      stateBeforeMutations: state,
      userMessage: "Add apple",
      toolResults,
    });
  });

  it("sends authoritative weight observation fields to tool-free finalization", async () => {
    const { create, model } = setup();
    const weightResult: FoodDayToolResult = {
      name: "LOG_BODY_WEIGHT",
      result: {
        disposition: "CREATED",
        weightEntry: {
          id: "40000000-0000-4000-8000-000000000001",
          localDate: "2026-10-05",
          sourceValue: "178.5",
          sourceUnit: "LB",
          weightKg: "80.966238045",
          createdAt: "2026-10-05T12:00:00Z",
        },
      },
    };
    await model.finalize({
      ...finalizationInput("Log my weight"),
      toolResults: [weightResult],
    });
    const request = requestAt(create);
    expect(request).not.toHaveProperty("tools");
    expect(JSON.parse(request.input as string)).toMatchObject({
      toolResults: [weightResult],
    });
  });

  it("offers no function tools, provider conversation state, or response storage", async () => {
    const { create, model } = setup();
    await model.finalize(finalizationInput("Add apple"));
    const request = requestAt(create);
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("previous_response_id");
    expect(request).not.toHaveProperty("conversation");
    expect(request.store).toBe(false);
  });

  it("uses the same ordered conversational history with authoritative tool context", async () => {
    const { create, model } = setup();
    await model.finalize({
      userMessage: "  Actually 250 g.  ",
      state,
      recentTranscript,
      toolResults,
    });

    const request = requestAt(create);
    expect(request.input).toEqual([
      {
        role: "developer",
        content: JSON.stringify({
          stateBeforeMutations: state,
          toolResults,
        }),
      },
      { role: "user", content: "  I had yogurt.  " },
      { role: "assistant", content: "  Logged yogurt.  " },
      { role: "user", content: "Make it 200 g." },
      { role: "assistant", content: "Updated to 200 g." },
      { role: "user", content: "  Actually 250 g.  " },
    ]);
    expect(request.instructions).toContain(
      "STATE and tool results override it",
    );
    expect(request.instructions).not.toContain("I had yogurt");
  });

  it("returns trimmed provider text only, without metadata", async () => {
    const { model } = setup(response("  Apple recorded.  "));
    expect(await model.finalize(finalizationInput("Add apple"))).toBe(
      "Apple recorded.",
    );
  });

  it("rejects blank final text", async () => {
    const { model } = setup(response("   "));
    await expect(model.finalize(finalizationInput("Hi"))).rejects.toMatchObject(
      {
        reason: "EMPTY_TEXT",
      },
    );
  });

  it("rejects an unexpected finalization function call even if text is present", async () => {
    const { model } = setup(response("Done", [functionCall("LOG_FOOD", {})]));
    await expect(model.finalize(finalizationInput("Hi"))).rejects.toMatchObject(
      {
        reason: "UNEXPECTED_FUNCTION_CALL",
      },
    );
  });

  it("propagates the original finalization SDK/API error unchanged", async () => {
    const { create, model } = setup();
    const sdkError = new Error("provider unavailable");
    create.mockRejectedValueOnce(sdkError);
    await expect(model.finalize(finalizationInput("Hi"))).rejects.toBe(
      sdkError,
    );
  });
});
