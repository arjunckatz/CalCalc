import type {
  AccountTurnPlan,
  AccountTurnStepResult,
  PersistedAccountTurn,
  PersistedAccountTurnStepResult,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeFoodDayTool,
  type FoodDayToolResult,
} from "../agent/tools/execute-food-day-tool.js";
import {
  executeAccountConversationPlan,
  AccountTurnPlanNotReadyError,
  type ExecuteAccountConversationPlanDependencies,
} from "./execute-account-conversation-plan.js";
import { AccountTurnStepIntegrityError } from "./account-turn-step-result.js";

vi.mock("../agent/tools/execute-food-day-tool.js", () => ({
  executeFoodDayTool: vi.fn(),
  validateBodyWeightLogEvidence: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const turnId = "20000000-0000-4000-8000-000000000001";
const foodDayId = "30000000-0000-4000-8000-000000000001";
const entryId = "40000000-0000-4000-8000-000000000001";
const logCommand = {
  rawUserDescription: "oats",
  displayName: "Oats",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "100" },
  },
  evidenceClass: "EXACT",
  status: "CONFIRMED_CONSUMED",
};
const readOutcome = {
  recentObservations: [],
  recentHistoryMayBeTruncated: false,
  latestMeasurementDate: null,
  latestDateObservationCount: 0,
  latestDateObservations: [],
  latestDateObservationsComplete: true,
};

function plan(
  ...slots: {
    action: AccountTurnPlan["slots"][number]["action"];
    command: AccountTurnPlan["slots"][number]["command"];
  }[]
): AccountTurnPlan {
  return {
    schema: "account-turn-plan-v1",
    foodDayId,
    slots: slots.map((slot, index) => ({ index, ...slot })),
  };
}

function harness(
  executionPlan: AccountTurnPlan | null = plan({
    action: "LOG_FOOD",
    command: logCommand,
  }),
) {
  const turn: PersistedAccountTurn = {
    id: turnId,
    userId,
    turnKey: "key",
    requestFingerprint: "fingerprint",
    userMessage: "I had oats",
    calendarContext: null,
    status: "PENDING",
    resolvedFoodDayId: foodDayId,
    routingResolution: {
      schema: "account-routing-resolution-v1",
      kind: "EXISTING_DAY",
      foodDayId,
    },
    executionPlan,
    response: null,
    createdAt: "2026-10-20T00:00:00Z",
    completedAt: null,
  };
  const stored: PersistedAccountTurnStepResult[] = [];
  let failCheckpoint = false;
  const turns = {
    findById: vi.fn(async (owner: string) => (owner === userId ? turn : null)),
    findExecutionCheckpoint: vi.fn(async () => ({
      turnId,
      userId,
      status: turn.status,
      routingResolution: turn.routingResolution,
      resolvedFoodDayId: foodDayId,
      materializedFoodDayId: null,
    })),
  };
  const stepResults = {
    listForTurn: vi.fn(async () => [...stored]),
    setOnce: vi.fn(
      async (input: { ordinal: number; result: AccountTurnStepResult }) => {
        if (failCheckpoint) throw new Error("checkpoint unavailable");
        const existing = stored[input.ordinal];
        if (existing !== undefined) return existing;
        const row: PersistedAccountTurnStepResult = {
          turnId,
          userId,
          ordinal: input.ordinal,
          result: input.result,
          createdAt: "2026-10-20T00:00:01Z",
        };
        stored.push(row);
        return row;
      },
    ),
  };
  const dependencies = {
    turns,
    stepResults,
  } as unknown as ExecuteAccountConversationPlanDependencies;
  const run = () =>
    executeAccountConversationPlan(dependencies, {
      trustedUserId: userId,
      turnId,
    });
  return {
    run,
    turn,
    turns,
    stored,
    stepResults,
    failCheckpoint(value: boolean) {
      failCheckpoint = value;
    },
  };
}

const logResult = (): FoodDayToolResult =>
  ({
    name: "LOG_FOOD",
    result: { disposition: "CREATED", entry: { id: entryId } },
  }) as FoodDayToolResult;

beforeEach(() => {
  vi.mocked(executeFoodDayTool).mockReset();
});

describe("durable account plan execution", () => {
  it("returns a completed turn before inspecting plan or executing tools", async () => {
    const h = harness();
    (h.turn as { status: string; response: string | null }).status =
      "COMPLETED";
    (h.turn as { response: string | null }).response = "original";
    expect(await h.run()).toEqual({
      kind: "COMPLETED_REPLAY",
      response: "original",
    });
    expect(h.turns.findExecutionCheckpoint).not.toHaveBeenCalled();
    expect(executeFoodDayTool).not.toHaveBeenCalled();
  });

  it("rejects an unplanned pending turn and never guesses a command", async () => {
    const h = harness(null);
    await expect(h.run()).rejects.toBeInstanceOf(AccountTurnPlanNotReadyError);
    expect(executeFoodDayTool).not.toHaveBeenCalled();
  });

  it("returns an exact durable direct response without a tool or completion write", async () => {
    const h = harness(
      plan({
        action: "DIRECT_RESPONSE",
        command: { response: "  Exact reply.  " },
      }),
    );
    // A durable direct response is already normalized at planning time.
    (h.turn.executionPlan!.slots[0]!.command as { response: string }).response =
      "Exact reply.";
    expect(await h.run()).toEqual({
      kind: "DIRECT_RESPONSE_READY",
      response: "Exact reply.",
    });
    expect(executeFoodDayTool).not.toHaveBeenCalled();
    expect(h.stepResults.setOnce).not.toHaveBeenCalled();
  });

  it("checkpoints one LOG_FOOD effect and skips it entirely on retry", async () => {
    const h = harness();
    vi.mocked(executeFoodDayTool).mockResolvedValue(logResult());
    const first = await h.run();
    const retry = await h.run();
    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      kind: "TOOL_SEQUENCE_EXECUTED",
      orderedStepResults: [
        { action: "LOG_FOOD", outcome: { entryId, revision: 1 } },
      ],
    });
    expect(executeFoodDayTool).toHaveBeenCalledTimes(1);
    expect(h.stored).toHaveLength(1);
  });

  it("recovers a committed mutation after the result checkpoint was lost", async () => {
    const h = harness();
    h.failCheckpoint(true);
    vi.mocked(executeFoodDayTool)
      .mockResolvedValueOnce(logResult())
      .mockResolvedValueOnce({
        ...logResult(),
        result: { ...logResult().result, disposition: "REPLAYED" },
      } as FoodDayToolResult);
    await expect(h.run()).rejects.toThrow("checkpoint unavailable");
    expect(h.stored).toHaveLength(0);
    h.failCheckpoint(false);
    await expect(h.run()).resolves.toMatchObject({
      orderedStepResults: [{ outcome: { entryId, revision: 1 } }],
    });
    expect(executeFoodDayTool).toHaveBeenCalledTimes(2);
    const firstContext = vi.mocked(executeFoodDayTool).mock.calls[0]?.[1];
    const retryContext = vi.mocked(executeFoodDayTool).mock.calls[1]?.[1];
    expect(firstContext?.idempotencyKey).toBe(retryContext?.idempotencyKey);
    expect(firstContext?.operationScope).toBe("ACCOUNT_TURN_PLAN_STEP");
    expect(h.stored).toHaveLength(1);
  });

  it("resumes at the first missing ordinal and preserves plan order", async () => {
    const h = harness(
      plan(
        { action: "GET_BODY_WEIGHT_HISTORY", command: {} },
        { action: "GET_BODY_WEIGHT_HISTORY", command: {} },
        { action: "LOG_FOOD", command: logCommand },
      ),
    );
    for (const ordinal of [0, 1])
      h.stored.push({
        turnId,
        userId,
        ordinal,
        createdAt: "2026-10-20T00:00:00Z",
        result: {
          schema: "account-turn-step-result-v1",
          action: "GET_BODY_WEIGHT_HISTORY",
          outcome: readOutcome,
        },
      });
    vi.mocked(executeFoodDayTool).mockResolvedValue(logResult());
    const result = await h.run();
    expect(result).toMatchObject({
      kind: "TOOL_SEQUENCE_EXECUTED",
      orderedStepResults: [
        { action: "GET_BODY_WEIGHT_HISTORY" },
        { action: "GET_BODY_WEIGHT_HISTORY" },
        { action: "LOG_FOOD" },
      ],
    });
    expect(executeFoodDayTool).toHaveBeenCalledTimes(1);
    expect(h.stepResults.setOnce).toHaveBeenCalledWith(
      expect.objectContaining({ ordinal: 2 }),
    );
  });

  it("rejects a corrupt non-prefix before executing any later step", async () => {
    const h = harness(
      plan(
        { action: "LOG_FOOD", command: logCommand },
        { action: "GET_BODY_WEIGHT_HISTORY", command: {} },
      ),
    );
    h.stored.push({
      turnId,
      userId,
      ordinal: 1,
      createdAt: "2026-10-20T00:00:00Z",
      result: {
        schema: "account-turn-step-result-v1",
        action: "GET_BODY_WEIGHT_HISTORY",
        outcome: readOutcome,
      },
    });
    await expect(h.run()).rejects.toBeInstanceOf(AccountTurnStepIntegrityError);
    expect(executeFoodDayTool).not.toHaveBeenCalled();
  });

  it("does not reread an already-checkpointed weight-history result", async () => {
    const h = harness(plan({ action: "GET_BODY_WEIGHT_HISTORY", command: {} }));
    vi.mocked(executeFoodDayTool).mockResolvedValue({
      name: "GET_BODY_WEIGHT_HISTORY",
      result: readOutcome,
    });
    const first = await h.run();
    vi.mocked(executeFoodDayTool).mockRejectedValue(
      new Error("read must not recur"),
    );
    expect(await h.run()).toEqual(first);
    expect(executeFoodDayTool).toHaveBeenCalledTimes(1);
  });

  it("may repeat a read before checkpoint; first durable read result wins", async () => {
    const h = harness(plan({ action: "GET_BODY_WEIGHT_HISTORY", command: {} }));
    h.failCheckpoint(true);
    vi.mocked(executeFoodDayTool).mockResolvedValueOnce({
      name: "GET_BODY_WEIGHT_HISTORY",
      result: readOutcome,
    });
    await expect(h.run()).rejects.toThrow("checkpoint unavailable");
    h.failCheckpoint(false);
    vi.mocked(executeFoodDayTool).mockResolvedValueOnce({
      name: "GET_BODY_WEIGHT_HISTORY",
      result: { ...readOutcome, latestMeasurementDate: "2026-10-20" },
    });
    const result = await h.run();
    expect(result).toMatchObject({
      orderedStepResults: [
        { outcome: { latestMeasurementDate: "2026-10-20" } },
      ],
    });
  });

  it("does not substitute a frozen entry revision or completeness CAS", async () => {
    const h = harness(
      plan(
        {
          action: "UPDATE_FOOD_QUANTITY",
          command: {
            entryId,
            expectedRevision: 3,
            quantity: { amount: "2", unit: "SERVING" },
            overrideAction: { type: "PRESERVE" },
          },
        },
        {
          action: "SET_FOOD_DAY_COMPLETENESS",
          command: {
            expectedCompleteness: "PARTIAL",
            targetCompleteness: "USER_DECLARED_COMPLETE",
          },
        },
      ),
    );
    vi.mocked(executeFoodDayTool).mockRejectedValue(
      new Error("revision conflict"),
    );
    await expect(h.run()).rejects.toThrow("revision conflict");
    expect(vi.mocked(executeFoodDayTool).mock.calls[0]?.[2]).toMatchObject({
      arguments: { entryId, expectedRevision: 3 },
    });
    expect(h.stored).toHaveLength(0);
    vi.mocked(executeFoodDayTool).mockReset();
    vi.mocked(executeFoodDayTool)
      .mockResolvedValueOnce({
        name: "UPDATE_FOOD_QUANTITY",
        result: {
          disposition: "APPLIED",
          entry: { id: entryId },
          appliedRevision: 4,
        },
      } as FoodDayToolResult)
      .mockRejectedValueOnce(new Error("completeness conflict"));
    await expect(h.run()).rejects.toThrow("completeness conflict");
    expect(
      vi.mocked(executeFoodDayTool).mock.calls[1]?.[1].stateCompleteness,
    ).toBe("PARTIAL");
    expect(h.stored).toHaveLength(1);
  });

  it("returns one winning read checkpoint under concurrent proposals", async () => {
    const h = harness(plan({ action: "GET_BODY_WEIGHT_HISTORY", command: {} }));
    vi.mocked(executeFoodDayTool).mockResolvedValue({
      name: "GET_BODY_WEIGHT_HISTORY",
      result: readOutcome,
    });
    const [left, right] = await Promise.all([h.run(), h.run()]);
    expect(left).toEqual(right);
    expect(h.stored).toHaveLength(1);
  });
});
