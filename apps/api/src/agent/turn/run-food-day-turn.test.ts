import { createFoodEntry, DomainValidationError } from "@cal-calc/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseIdempotencyKey,
  type IdempotencyKey,
} from "../../mutations/mutation-identity.js";
import type { FoodDayState } from "../../state/build-food-day-state.js";
import { getFoodDayState } from "../../state/get-food-day-state.js";
import {
  executeFoodDayTool,
  type FoodDayToolResult,
} from "../tools/execute-food-day-tool.js";
import { ToolValidationError } from "../tools/food-day-tools.js";
import type {
  FoodDayModelDecision,
  FoodDayTurnInput,
  FoodDayTurnModel,
} from "./food-day-turn-types.js";
import {
  FoodDayTurnExecutionError,
  FoodDayTurnValidationError,
  MAX_FOOD_DAY_TOOL_CALLS_PER_TURN,
  runFoodDayTurn,
  type RunFoodDayTurnDependencies,
} from "./run-food-day-turn.js";
import { deriveFoodDayToolIdempotencyKey } from "./turn-idempotency.js";

vi.mock("../../state/get-food-day-state.js", () => ({
  getFoodDayState: vi.fn(),
}));
vi.mock("../tools/execute-food-day-tool.js", () => ({
  executeFoodDayTool: vi.fn(),
}));

const stateQuery = vi.mocked(getFoodDayState);
const toolExecutor = vi.mocked(executeFoodDayTool);
const trustedInput: FoodDayTurnInput = {
  trustedUserId: "10000000-0000-4000-8000-000000000001",
  foodDayId: "20000000-0000-4000-8000-000000000001",
  turnIdempotencyKey: parseIdempotencyKey("trusted-turn-key"),
  userMessage: "  Add lunch  ",
};
const initialState: FoodDayState = {
  foodDay: {
    id: trustedInput.foodDayId,
    localDate: "2026-09-18",
    status: "OPEN",
    completeness: "USER_DECLARED_COMPLETE",
    targets: { calories: "2400", protein: "120" },
  },
  totals: {
    confirmed: {
      calories: "0",
      protein: "0",
      hasUnknownProtein: false,
    },
  },
  entries: [],
};
const entry = createFoodEntry({
  id: "30000000-0000-4000-8000-000000000001",
  foodDayId: trustedInput.foodDayId,
  rawUserDescription: "Lunch",
  displayName: "Lunch",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "400", protein: "20" },
  },
  evidenceClass: "EXACT",
  status: "CONFIRMED_CONSUMED",
});
const logResult: FoodDayToolResult = {
  name: "LOG_FOOD",
  result: { disposition: "CREATED", entry },
};
const updateResult: FoodDayToolResult = {
  name: "UPDATE_FOOD_QUANTITY",
  result: {
    disposition: "APPLIED",
    entry: {
      ...entry,
      revision: 2,
      quantity: { amount: "2", unit: "SERVING" },
    },
    appliedRevision: 2,
  },
};
const removeResult: FoodDayToolResult = {
  name: "REMOVE_FOOD",
  result: {
    disposition: "APPLIED",
    entry: { ...entry, revision: 2, deletedAt: "2026-09-18T00:00:00Z" },
    appliedRevision: 2,
  },
};
const logCall = {
  name: "LOG_FOOD",
  arguments: {
    rawUserDescription: "Lunch",
    displayName: "Lunch",
    quantity: { amount: "1", unit: "SERVING" },
    nutritionBasis: {
      amount: "1",
      unit: "SERVING",
      nutrition: { calories: "400", protein: "20" },
    },
    evidenceClass: "EXACT",
  },
};
const updateCall = {
  name: "UPDATE_FOOD_QUANTITY",
  arguments: {
    entryId: entry.id,
    expectedRevision: 1,
    quantity: { amount: "2", unit: "SERVING" },
    overrideAction: { type: "PRESERVE" },
  },
};
const removeCall = {
  name: "REMOVE_FOOD",
  arguments: { entryId: entry.id, expectedRevision: 2 },
};

function setup(decision: unknown = { type: "FINAL", text: "Lunch noted." }) {
  const decide = vi.fn<FoodDayTurnModel["decide"]>();
  const finalize = vi.fn<FoodDayTurnModel["finalize"]>();
  decide.mockResolvedValue(decision as FoodDayModelDecision);
  finalize.mockResolvedValue("Lunch recorded.");
  const dependencies: RunFoodDayTurnDependencies = {
    foodDays: { findById: vi.fn() },
    foodEntries: { listActiveByFoodDay: vi.fn() },
    transactionRunner: { runInTransaction: vi.fn() },
    model: { decide, finalize },
  };
  return { dependencies, decide, finalize };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected turn to reject.");
}

beforeEach(() => {
  vi.resetAllMocks();
  stateQuery.mockResolvedValue(initialState);
  toolExecutor.mockResolvedValue(logResult);
});

describe("runFoodDayTurn input and initial STATE", () => {
  it.each(["", "   ", null, 42])(
    "rejects an empty or non-string user message (%s) before loading STATE",
    async (userMessage) => {
      const { dependencies, decide } = setup();
      await expect(
        runFoodDayTurn(dependencies, {
          ...trustedInput,
          userMessage: userMessage as string,
        }),
      ).rejects.toMatchObject({
        name: "FoodDayTurnValidationError",
        reason: "INVALID_USER_MESSAGE",
      });
      expect(stateQuery).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid trusted root key before loading STATE", async () => {
    const { dependencies } = setup();
    await expect(
      runFoodDayTurn(dependencies, {
        ...trustedInput,
        turnIdempotencyKey: "bad key" as IdempotencyKey,
      }),
    ).rejects.toMatchObject({
      name: "FoodDayTurnValidationError",
      reason: "INVALID_TURN_IDEMPOTENCY_KEY",
    });
    expect(stateQuery).not.toHaveBeenCalled();
  });

  it("loads STATE with only the trusted user and FoodDay identifiers", async () => {
    const { dependencies } = setup();
    await runFoodDayTurn(dependencies, trustedInput);
    expect(stateQuery).toHaveBeenCalledExactlyOnceWith(dependencies, {
      trustedUserId: trustedInput.trustedUserId,
      foodDayId: trustedInput.foodDayId,
    });
  });

  it("loads STATE exactly once before asking the model to decide", async () => {
    const events: string[] = [];
    const { dependencies, decide } = setup();
    stateQuery.mockImplementationOnce(async () => {
      events.push("STATE");
      return initialState;
    });
    decide.mockImplementationOnce(async () => {
      events.push("decide");
      return { type: "FINAL", text: "Done." };
    });
    await runFoodDayTurn(dependencies, trustedInput);
    expect(events).toEqual(["STATE", "decide"]);
    expect(stateQuery).toHaveBeenCalledTimes(1);
  });

  it("trims the user message and passes the same initial STATE object to both model methods", async () => {
    const { dependencies, decide, finalize } = setup({
      type: "TOOLS",
      calls: [logCall],
    });
    await runFoodDayTurn(dependencies, trustedInput);
    expect(decide).toHaveBeenCalledExactlyOnceWith({
      userMessage: "Add lunch",
      state: initialState,
    });
    expect(decide.mock.calls[0]?.[0].state).toBe(initialState);
    expect(finalize.mock.calls[0]?.[0].state).toBe(initialState);
  });
});

describe("runFoodDayTurn decision protocol", () => {
  it("returns a FINAL response with the initial STATE and an empty result list", async () => {
    const { dependencies } = setup({
      type: "FINAL",
      text: "  Nothing to add.  ",
    });
    const result = await runFoodDayTurn(dependencies, trustedInput);
    expect(result).toEqual({
      response: "Nothing to add.",
      state: initialState,
      toolResults: [],
    });
    expect(result.state).toBe(initialState);
  });

  it("executes no tools for FINAL", async () => {
    const { dependencies } = setup();
    await runFoodDayTurn(dependencies, trustedInput);
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it("does not call finalize for FINAL", async () => {
    const { dependencies, finalize } = setup();
    await runFoodDayTurn(dependencies, trustedInput);
    expect(finalize).not.toHaveBeenCalled();
  });

  it.each(["", "  ", null, 12])(
    "rejects invalid FINAL text (%s)",
    async (text) => {
      const { dependencies } = setup({ type: "FINAL", text });
      await expect(
        runFoodDayTurn(dependencies, trustedInput),
      ).rejects.toMatchObject({
        name: "FoodDayTurnValidationError",
        reason: "INVALID_FINAL_TEXT",
      });
      expect(toolExecutor).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown decision type", async () => {
    const { dependencies } = setup({ type: "RETRY", calls: [] });
    await expect(
      runFoodDayTurn(dependencies, trustedInput),
    ).rejects.toMatchObject({
      reason: "INVALID_MODEL_DECISION",
    });
  });

  it("rejects extra decision fields", async () => {
    const { dependencies } = setup({
      type: "FINAL",
      text: "Done.",
      providerRequestId: "not part of the protocol",
    });
    await expect(
      runFoodDayTurn(dependencies, trustedInput),
    ).rejects.toBeInstanceOf(FoodDayTurnValidationError);
  });

  it("rejects accessor-backed model fields without invoking the accessor", async () => {
    const textGetter = vi.fn(() => "Done.");
    const decision = { type: "FINAL" };
    Object.defineProperty(decision, "text", {
      enumerable: true,
      get: textGetter,
    });
    const { dependencies } = setup(decision);
    await expect(
      runFoodDayTurn(dependencies, trustedInput),
    ).rejects.toMatchObject({
      reason: "INVALID_MODEL_DECISION",
    });
    expect(textGetter).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "not an array", {}])(
    "rejects TOOLS without an array (%s)",
    async (calls) => {
      const { dependencies } = setup({ type: "TOOLS", calls });
      await expect(
        runFoodDayTurn(dependencies, trustedInput),
      ).rejects.toMatchObject({
        reason: "INVALID_MODEL_DECISION",
      });
    },
  );

  it("rejects an empty tool batch without finalizing", async () => {
    const { dependencies, finalize } = setup({ type: "TOOLS", calls: [] });
    await expect(
      runFoodDayTurn(dependencies, trustedInput),
    ).rejects.toMatchObject({
      reason: "INVALID_MODEL_DECISION",
    });
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("rejects more than eight tools without silently truncating", async () => {
    const { dependencies } = setup({
      type: "TOOLS",
      calls: Array.from(
        { length: MAX_FOOD_DAY_TOOL_CALLS_PER_TURN + 1 },
        () => logCall,
      ),
    });
    await expect(
      runFoodDayTurn(dependencies, trustedInput),
    ).rejects.toMatchObject({
      reason: "INVALID_MODEL_DECISION",
    });
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it("accepts a batch at the eight-tool limit", async () => {
    const { dependencies, finalize } = setup({
      type: "TOOLS",
      calls: Array.from(
        { length: MAX_FOOD_DAY_TOOL_CALLS_PER_TURN },
        () => logCall,
      ),
    });
    const result = await runFoodDayTurn(dependencies, trustedInput);
    expect(toolExecutor).toHaveBeenCalledTimes(8);
    expect(result.toolResults).toHaveLength(8);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("leaves tool-call schema validation to the M4B1 executor", async () => {
    const invalidCall = {
      name: "LOG_FOOD",
      arguments: { trustedUserId: "attacker" },
    };
    const typedCause = new ToolValidationError();
    toolExecutor.mockRejectedValueOnce(typedCause);
    const { dependencies, finalize } = setup({
      type: "TOOLS",
      calls: [invalidCall],
    });
    await expect(runFoodDayTurn(dependencies, trustedInput)).rejects.toBe(
      typedCause,
    );
    expect(toolExecutor).toHaveBeenCalledWith(
      dependencies,
      expect.any(Object),
      invalidCall,
    );
    expect(finalize).not.toHaveBeenCalled();
  });
});

describe("runFoodDayTurn trusted tool execution", () => {
  it("passes one call with trusted identity, FoodDay, and a derived child key", async () => {
    const { dependencies } = setup({ type: "TOOLS", calls: [logCall] });
    await runFoodDayTurn(dependencies, trustedInput);
    expect(toolExecutor).toHaveBeenCalledExactlyOnceWith(
      dependencies,
      {
        trustedUserId: trustedInput.trustedUserId,
        foodDayId: trustedInput.foodDayId,
        idempotencyKey: deriveFoodDayToolIdempotencyKey(
          trustedInput.turnIdempotencyKey,
          0,
        ),
      },
      logCall,
    );
  });

  it("derives the same canonical child key for the same trusted turn and slot", async () => {
    const { dependencies } = setup({ type: "TOOLS", calls: [logCall] });
    await runFoodDayTurn(dependencies, trustedInput);
    await runFoodDayTurn(dependencies, trustedInput);
    const first = toolExecutor.mock.calls[0]?.[1].idempotencyKey;
    const replay = toolExecutor.mock.calls[1]?.[1].idempotencyKey;
    expect(replay).toBe(first);
    expect(parseIdempotencyKey(first)).toBe(first);
  });

  it("assigns different canonical child keys to different slots", async () => {
    const { dependencies } = setup({
      type: "TOOLS",
      calls: [logCall, updateCall],
    });
    await runFoodDayTurn(dependencies, trustedInput);
    const first = toolExecutor.mock.calls[0]?.[1].idempotencyKey;
    const second = toolExecutor.mock.calls[1]?.[1].idempotencyKey;
    expect(first).not.toBe(second);
    expect(parseIdempotencyKey(second)).toBe(second);
  });

  it("changes the child key when the trusted root turn key changes", async () => {
    const { dependencies } = setup({ type: "TOOLS", calls: [logCall] });
    await runFoodDayTurn(dependencies, trustedInput);
    await runFoodDayTurn(dependencies, {
      ...trustedInput,
      turnIdempotencyKey: parseIdempotencyKey("another-trusted-turn"),
    });
    expect(toolExecutor.mock.calls[0]?.[1].idempotencyKey).not.toBe(
      toolExecutor.mock.calls[1]?.[1].idempotencyKey,
    );
  });

  it("does not use model-generated arguments in the child key for a retried slot", async () => {
    const { dependencies, decide } = setup({ type: "TOOLS", calls: [logCall] });
    await runFoodDayTurn(dependencies, trustedInput);
    decide.mockResolvedValueOnce({
      type: "TOOLS",
      calls: [
        {
          ...logCall,
          arguments: { ...logCall.arguments, displayName: "Changed" },
        },
      ],
    });
    await runFoodDayTurn(dependencies, trustedInput);
    // Changed arguments address the same slot; the application's scoped
    // fingerprint check owns the retry conflict.
    expect(toolExecutor.mock.calls[0]?.[1].idempotencyKey).toBe(
      toolExecutor.mock.calls[1]?.[1].idempotencyKey,
    );
    expect(toolExecutor.mock.calls[0]?.[2]).not.toEqual(
      toolExecutor.mock.calls[1]?.[2],
    );
  });

  it("keeps the child key when a retried slot changes action", async () => {
    const { dependencies, decide } = setup({ type: "TOOLS", calls: [logCall] });
    await runFoodDayTurn(dependencies, trustedInput);
    decide.mockResolvedValueOnce({ type: "TOOLS", calls: [removeCall] });
    await runFoodDayTurn(dependencies, trustedInput);

    expect(toolExecutor.mock.calls[0]?.[2]).toBe(logCall);
    expect(toolExecutor.mock.calls[1]?.[2]).toBe(removeCall);
    expect(toolExecutor.mock.calls[0]?.[1].idempotencyKey).toBe(
      toolExecutor.mock.calls[1]?.[1].idempotencyKey,
    );
  });

  it("executes multiple calls sequentially, waiting for the first result", async () => {
    let resolveFirst!: (result: FoodDayToolResult) => void;
    const firstResult = new Promise<FoodDayToolResult>((resolve) => {
      resolveFirst = resolve;
    });
    toolExecutor
      .mockReturnValueOnce(firstResult)
      .mockResolvedValueOnce(updateResult);
    const { dependencies } = setup({
      type: "TOOLS",
      calls: [logCall, updateCall],
    });
    const turn = runFoodDayTurn(dependencies, trustedInput);
    await vi.waitFor(() => expect(toolExecutor).toHaveBeenCalledTimes(1));
    expect(toolExecutor.mock.calls[0]?.[2]).toBe(logCall);
    resolveFirst(logResult);
    await turn;
    expect(toolExecutor).toHaveBeenCalledTimes(2);
    expect(toolExecutor.mock.calls[1]?.[2]).toBe(updateCall);
  });

  it("preserves the original three-call order", async () => {
    toolExecutor
      .mockResolvedValueOnce(logResult)
      .mockResolvedValueOnce(updateResult)
      .mockResolvedValueOnce(removeResult);
    const { dependencies } = setup({
      type: "TOOLS",
      calls: [logCall, updateCall, removeCall],
    });
    await runFoodDayTurn(dependencies, trustedInput);
    expect(toolExecutor.mock.calls.map(([, , call]) => call)).toEqual([
      logCall,
      updateCall,
      removeCall,
    ]);
  });

  it("does not reload or mutate initial STATE after a tool returns", async () => {
    toolExecutor.mockImplementationOnce(async () => {
      expect(stateQuery).toHaveBeenCalledTimes(1);
      expect(initialState.entries).toEqual([]);
      return logResult;
    });
    const { dependencies, finalize } = setup({
      type: "TOOLS",
      calls: [logCall],
    });
    const result = await runFoodDayTurn(dependencies, trustedInput);
    expect(stateQuery).toHaveBeenCalledTimes(1);
    expect(initialState.entries).toEqual([]);
    expect(result.state).toBe(initialState);
    expect(finalize.mock.calls[0]?.[0].state).toBe(initialState);
  });

  it("passes rich authoritative results and original STATE to one finalization", async () => {
    toolExecutor
      .mockResolvedValueOnce(logResult)
      .mockResolvedValueOnce(updateResult);
    const { dependencies, finalize } = setup({
      type: "TOOLS",
      calls: [logCall, updateCall],
    });
    const result = await runFoodDayTurn(dependencies, trustedInput);
    expect(finalize).toHaveBeenCalledExactlyOnceWith({
      userMessage: "Add lunch",
      state: initialState,
      toolResults: [logResult, updateResult],
    });
    expect(finalize.mock.calls[0]?.[0].toolResults[0]).toBe(logResult);
    expect(result).toEqual({
      response: "Lunch recorded.",
      state: initialState,
      toolResults: [logResult, updateResult],
    });
  });

  it("returns a JSON-friendly successful result without trusted operation keys", async () => {
    const { dependencies } = setup({ type: "TOOLS", calls: [logCall] });
    const result = await runFoodDayTurn(dependencies, trustedInput);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(JSON.stringify(result)).not.toContain(
      trustedInput.turnIdempotencyKey,
    );
    expect(Object.keys(result)).toEqual(["response", "state", "toolResults"]);
  });

  it("rejects empty finalizer text after tools", async () => {
    const { dependencies, finalize } = setup({
      type: "TOOLS",
      calls: [logCall],
    });
    finalize.mockResolvedValueOnce("   ");
    await expect(
      runFoodDayTurn(dependencies, trustedInput),
    ).rejects.toMatchObject({
      reason: "INVALID_FINAL_TEXT",
    });
    expect(toolExecutor).toHaveBeenCalledTimes(1);
  });
});

describe("runFoodDayTurn failure boundaries", () => {
  it("propagates a first-tool typed failure unchanged and runs no later call", async () => {
    const cause = new DomainValidationError("Invalid correction.");
    toolExecutor.mockRejectedValueOnce(cause);
    const { dependencies, finalize } = setup({
      type: "TOOLS",
      calls: [logCall, updateCall],
    });
    await expect(runFoodDayTurn(dependencies, trustedInput)).rejects.toBe(
      cause,
    );
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("wraps a later failure with its index, safe name, prior result, and original cause", async () => {
    const cause = new DomainValidationError("Invalid correction.");
    toolExecutor.mockResolvedValueOnce(logResult).mockRejectedValueOnce(cause);
    const { dependencies } = setup({
      type: "TOOLS",
      calls: [logCall, updateCall],
    });
    const error = await rejected(runFoodDayTurn(dependencies, trustedInput));
    expect(error).toBeInstanceOf(FoodDayTurnExecutionError);
    if (!(error instanceof FoodDayTurnExecutionError)) return;
    expect(error.failedToolIndex).toBe(1);
    expect(error.failedToolName).toBe("UPDATE_FOOD_QUANTITY");
    expect(error.completedToolResults).toEqual([logResult]);
    expect(error.completedToolResults[0]).toBe(logResult);
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain(trustedInput.turnIdempotencyKey);
  });

  it("does not expose an unrecognized model tool name in a partial-failure error", async () => {
    toolExecutor
      .mockResolvedValueOnce(logResult)
      .mockRejectedValueOnce(new ToolValidationError());
    const { dependencies } = setup({
      type: "TOOLS",
      calls: [logCall, { name: "ATTACKER_TOOL", arguments: {} }],
    });
    const error = await rejected(runFoodDayTurn(dependencies, trustedInput));
    expect(error).toMatchObject({
      failedToolIndex: 1,
      failedToolName: undefined,
    });
  });

  it("stops after a later failure and never finalizes the partial batch", async () => {
    toolExecutor
      .mockResolvedValueOnce(logResult)
      .mockRejectedValueOnce(new Error("failed"));
    const { dependencies, finalize } = setup({
      type: "TOOLS",
      calls: [logCall, updateCall, removeCall],
    });
    await expect(
      runFoodDayTurn(dependencies, trustedInput),
    ).rejects.toBeInstanceOf(FoodDayTurnExecutionError);
    expect(toolExecutor).toHaveBeenCalledTimes(2);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("propagates a model decision exception unchanged", async () => {
    const cause = new Error("model unavailable");
    const { dependencies, decide } = setup();
    decide.mockRejectedValueOnce(cause);
    await expect(runFoodDayTurn(dependencies, trustedInput)).rejects.toBe(
      cause,
    );
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it("propagates a model finalization exception unchanged", async () => {
    const cause = new Error("model unavailable");
    const { dependencies, finalize } = setup({
      type: "TOOLS",
      calls: [logCall],
    });
    finalize.mockRejectedValueOnce(cause);
    await expect(runFoodDayTurn(dependencies, trustedInput)).rejects.toBe(
      cause,
    );
    expect(toolExecutor).toHaveBeenCalledTimes(1);
  });
});
