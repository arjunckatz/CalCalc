import type {
  AccountTurnPlan,
  PersistedAccountTurn,
  PersistedAccountTurnStepResult,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeBodyWeightHistoryRead } from "../agent/tools/execute-food-day-tool.js";
import type {
  DurableFoodDayFinalizationInput,
  FoodDayModelFinalizationStep,
} from "../agent/turn/food-day-turn-types.js";
import { getFoodDayState } from "../state/get-food-day-state.js";
import {
  AccountTurnFinalizationNotReadyError,
  finalizeAccountConversationTurn,
  type FinalizeAccountConversationTurnDependencies,
} from "./finalize-account-conversation-turn.js";
import { AccountTurnStepIntegrityError } from "./account-turn-step-result.js";

vi.mock("../state/get-food-day-state.js", () => ({ getFoodDayState: vi.fn() }));
vi.mock("../agent/tools/execute-food-day-tool.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agent/tools/execute-food-day-tool.js")
  >()),
  executeBodyWeightHistoryRead: vi.fn(),
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
const history = {
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
function row(
  ordinal: number,
  action: "LOG_FOOD" | "GET_BODY_WEIGHT_HISTORY" = "LOG_FOOD",
): PersistedAccountTurnStepResult {
  return {
    turnId,
    userId,
    ordinal,
    createdAt: "2026-10-20T00:00:00Z",
    result: {
      schema: "account-turn-step-result-v1",
      action,
      outcome: action === "LOG_FOOD" ? { entryId, revision: 1 } : history,
    },
  };
}
function harness(
  executionPlan: AccountTurnPlan = plan({
    action: "LOG_FOOD",
    command: logCommand,
  }),
  stored: PersistedAccountTurnStepResult[] = [row(0)],
) {
  const turn: PersistedAccountTurn = {
    id: turnId,
    userId,
    turnKey: "key",
    requestFingerprint: "fingerprint",
    userMessage: "  I had oats.  ",
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
  const turns = {
    findCompletionState: vi.fn(async () => ({
      status: turn.status,
      response: turn.response,
    })),
    findById: vi.fn(async () => turn),
    findExecutionCheckpoint: vi.fn(async () => ({
      turnId,
      userId,
      status: turn.status,
      routingResolution: turn.routingResolution,
      resolvedFoodDayId: foodDayId,
      materializedFoodDayId: null,
    })),
    markCompleted: vi.fn(async ({ response }: { response: string }) => {
      if (turn.status === "COMPLETED") return { disposition: "REPLAYED", turn };
      (turn as { status: string }).status = "COMPLETED";
      (turn as { response: string | null }).response = response;
      return { disposition: "COMPLETED", turn };
    }),
  };
  const stepResults = { listForTurn: vi.fn(async () => stored) };
  const model = {
    finalizeDurableOrRead: vi.fn<
      (
        input: DurableFoodDayFinalizationInput,
      ) => Promise<FoodDayModelFinalizationStep>
    >(async () => ({ type: "FINAL", text: "  Done. ✅\n" })),
    finalizeDurable: vi.fn<
      (input: DurableFoodDayFinalizationInput) => Promise<string>
    >(async () => "  Final. ✅\n"),
  };
  const dependencies = {
    turns,
    stepResults,
    model,
  } as unknown as FinalizeAccountConversationTurnDependencies;
  const run = () =>
    finalizeAccountConversationTurn(dependencies, {
      trustedUserId: userId,
      turnId,
    });
  return { run, turn, turns, stepResults, model, stored };
}

beforeEach(() => {
  vi.mocked(getFoodDayState).mockReset();
  vi.mocked(getFoodDayState).mockResolvedValue({
    foodDay: { id: foodDayId },
  } as never);
  vi.mocked(executeBodyWeightHistoryRead).mockReset();
  vi.mocked(executeBodyWeightHistoryRead).mockResolvedValue({
    name: "GET_BODY_WEIGHT_HISTORY",
    result: history,
  });
});

describe("durable account-turn finalization", () => {
  it("replays completed response before plan, results, STATE or model work", async () => {
    const h = harness();
    (h.turn as { status: string }).status = "COMPLETED";
    (h.turn as { response: string | null }).response = "  Saved. ✅\n";
    expect(await h.run()).toEqual({ response: "  Saved. ✅\n" });
    expect(h.turns.findById).not.toHaveBeenCalled();
    expect(h.turns.findExecutionCheckpoint).not.toHaveBeenCalled();
    expect(h.stepResults.listForTurn).not.toHaveBeenCalled();
    expect(getFoodDayState).not.toHaveBeenCalled();
    expect(h.model.finalizeDurableOrRead).not.toHaveBeenCalled();
    expect(h.turns.markCompleted).not.toHaveBeenCalled();
  });

  it("completes an exact durable direct response without model or read", async () => {
    const h = harness(
      plan({
        action: "DIRECT_RESPONSE",
        command: { response: "Exact 🌟\nanswer" },
      }),
      [],
    );
    expect(await h.run()).toEqual({ response: "Exact 🌟\nanswer" });
    expect(h.turn.status).toBe("COMPLETED");
    expect(h.model.finalizeDurableOrRead).not.toHaveBeenCalled();
    expect(getFoodDayState).not.toHaveBeenCalled();
    expect(executeBodyWeightHistoryRead).not.toHaveBeenCalled();
    expect(await h.run()).toEqual({ response: "Exact 🌟\nanswer" });
    expect(h.turns.markCompleted).toHaveBeenCalledTimes(1);
  });

  it("reconstructs ordered durable effects and stores exact accepted final text", async () => {
    const h = harness(
      plan(
        { action: "LOG_FOOD", command: logCommand },
        { action: "GET_BODY_WEIGHT_HISTORY", command: {} },
      ),
      [row(0), row(1, "GET_BODY_WEIGHT_HISTORY")],
    );
    expect(await h.run()).toEqual({ response: "  Done. ✅\n" });
    const input = h.model.finalizeDurableOrRead.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      userMessage: "  I had oats.  ",
      toolResults: [
        { name: "LOG_FOOD", outcome: { entryId, revision: 1 } },
        { name: "GET_BODY_WEIGHT_HISTORY", outcome: history },
      ],
    });
    expect(input).not.toHaveProperty("recentTranscript");
    expect(executeBodyWeightHistoryRead).not.toHaveBeenCalled();
    expect(await h.run()).toEqual({ response: "  Done. ✅\n" });
    expect(h.model.finalizeDurableOrRead).toHaveBeenCalledTimes(1);
  });

  it("allows exactly one read continuation, then a tool-free final model phase", async () => {
    const h = harness();
    h.model.finalizeDurableOrRead.mockResolvedValueOnce({
      type: "READ_TOOL",
      call: { name: "GET_BODY_WEIGHT_HISTORY", arguments: {} },
    } as never);
    expect(await h.run()).toEqual({ response: "  Final. ✅\n" });
    expect(executeBodyWeightHistoryRead).toHaveBeenCalledTimes(1);
    expect(h.model.finalizeDurable).toHaveBeenCalledTimes(1);
    expect(h.model.finalizeDurable.mock.calls[0]?.[0].toolResults).toHaveLength(
      2,
    );
  });

  it("rejects an invalid second-phase result without completing", async () => {
    const h = harness();
    h.model.finalizeDurableOrRead.mockResolvedValueOnce({
      type: "READ_TOOL",
      call: { name: "GET_BODY_WEIGHT_HISTORY", arguments: {} },
    } as never);
    h.model.finalizeDurable.mockResolvedValueOnce({
      type: "READ_TOOL",
    } as never);
    await expect(h.run()).rejects.toThrow();
    expect(h.turn.status).toBe("PENDING");
    expect(h.turns.markCompleted).not.toHaveBeenCalled();
  });

  it("rejects an unoffered first-phase tool without a read or completion", async () => {
    const h = harness();
    h.model.finalizeDurableOrRead.mockResolvedValueOnce({
      type: "READ_TOOL",
      call: { name: "LOG_FOOD", arguments: {} },
    } as never);
    await expect(h.run()).rejects.toThrow();
    expect(executeBodyWeightHistoryRead).not.toHaveBeenCalled();
    expect(h.turns.markCompleted).not.toHaveBeenCalled();
  });

  it("never finalizes a partial prefix or corrupt saved action", async () => {
    const h = harness(
      plan(
        { action: "LOG_FOOD", command: logCommand },
        { action: "GET_BODY_WEIGHT_HISTORY", command: {} },
      ),
      [row(0)],
    );
    await expect(h.run()).rejects.toBeInstanceOf(
      AccountTurnFinalizationNotReadyError,
    );
    expect(h.model.finalizeDurableOrRead).not.toHaveBeenCalled();
    h.stored.push(row(1));
    await expect(h.run()).rejects.toBeInstanceOf(AccountTurnStepIntegrityError);
    expect(h.turns.markCompleted).not.toHaveBeenCalled();
  });

  it("leaves the turn pending after a model or completion failure; retry does not execute tools", async () => {
    const h = harness();
    h.model.finalizeDurableOrRead.mockRejectedValueOnce(
      new Error("provider unavailable"),
    );
    await expect(h.run()).rejects.toThrow("provider unavailable");
    expect(h.turn.status).toBe("PENDING");
    h.turns.markCompleted.mockRejectedValueOnce(new Error("commit lost"));
    await expect(h.run()).rejects.toThrow("commit lost");
    expect(h.turn.status).toBe("PENDING");
    expect(await h.run()).toEqual({ response: "  Done. ✅\n" });
    expect(h.stepResults.listForTurn).toHaveBeenCalledTimes(3);
  });

  it("replays the exact stored response after completion commits but its return is lost", async () => {
    const h = harness();
    h.turns.markCompleted.mockImplementationOnce(async ({ response }) => {
      (h.turn as { status: string }).status = "COMPLETED";
      (h.turn as { response: string | null }).response = response;
      throw new Error("return lost after commit");
    });
    await expect(h.run()).rejects.toThrow("return lost after commit");
    expect(await h.run()).toEqual({ response: "  Done. ✅\n" });
    expect(h.turns.findById).toHaveBeenCalledTimes(1);
    expect(h.stepResults.listForTurn).toHaveBeenCalledTimes(1);
    expect(h.model.finalizeDurableOrRead).toHaveBeenCalledTimes(1);
    expect(h.turns.markCompleted).toHaveBeenCalledTimes(1);
  });

  it("converges two distinct model responses on the stored completion winner", async () => {
    const h = harness();
    h.model.finalizeDurableOrRead.mockResolvedValueOnce({
      type: "FINAL",
      text: "R",
    });
    h.model.finalizeDurableOrRead.mockResolvedValueOnce({
      type: "FINAL",
      text: "Q",
    });
    const [a, b] = await Promise.all([h.run(), h.run()]);
    expect(a).toEqual({ response: "R" });
    expect(b).toEqual({ response: "R" });
    expect(h.turn.response).toBe("R");
  });
});
