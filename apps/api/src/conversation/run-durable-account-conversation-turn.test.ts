import type { AccountTurnPlan } from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseIdempotencyKey } from "../mutations/mutation-identity.js";
import { executeAccountConversationPlan } from "./execute-account-conversation-plan.js";
import { finalizeAccountConversationTurn } from "./finalize-account-conversation-turn.js";
import { runAccountConversationPlanningTurn } from "./run-account-conversation-planning-turn.js";
import {
  runDurableAccountConversationTurn,
  type RunDurableAccountConversationTurnDependencies,
} from "./run-durable-account-conversation-turn.js";

vi.mock("./run-account-conversation-planning-turn.js", () => ({
  runAccountConversationPlanningTurn: vi.fn(),
}));
vi.mock("./execute-account-conversation-plan.js", () => ({
  executeAccountConversationPlan: vi.fn(),
}));
vi.mock("./finalize-account-conversation-turn.js", () => ({
  finalizeAccountConversationTurn: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const turnId = "20000000-0000-4000-8000-000000000001";
const request = {
  trustedUserId: userId,
  idempotencyKey: parseIdempotencyKey("retry-one"),
  userMessage: "  Log oats.  ",
  calendarContext: null,
};
const toolPlan: AccountTurnPlan = {
  schema: "account-turn-plan-v1",
  foodDayId: "30000000-0000-4000-8000-000000000001",
  slots: [
    { index: 0, action: "LOG_FOOD", command: {} },
    { index: 1, action: "GET_BODY_WEIGHT_HISTORY", command: {} },
  ],
};
const directPlan: AccountTurnPlan = {
  ...toolPlan,
  slots: [
    { index: 0, action: "DIRECT_RESPONSE", command: { response: "Exact." } },
  ],
};

function harness(plan: AccountTurnPlan = toolPlan, resultCount = 0) {
  const events: string[] = [];
  const saved = Array.from({ length: resultCount }, (_, ordinal) => ({
    ordinal,
  }));
  const stepResults = {
    listForTurn: vi.fn(async () => {
      events.push("checkpoint-count");
      return saved;
    }),
  };
  const dependencies = {
    planning: {},
    execution: {},
    finalization: { stepResults },
  } as unknown as RunDurableAccountConversationTurnDependencies;
  vi.mocked(runAccountConversationPlanningTurn).mockImplementation(async () => {
    events.push("planning-boundary");
    return { kind: "PLAN_READY", turnId, plan };
  });
  vi.mocked(executeAccountConversationPlan).mockImplementation(async () => {
    events.push("execution-boundary");
    return { kind: "TOOL_SEQUENCE_EXECUTED", plan, orderedStepResults: [] };
  });
  vi.mocked(finalizeAccountConversationTurn).mockImplementation(async () => {
    events.push("finalization-boundary");
    return { response: "  Saved. ✅\n" };
  });
  return {
    run: () => runDurableAccountConversationTurn(dependencies, request),
    dependencies,
    events,
    saved,
    stepResults,
  };
}

beforeEach(() => {
  vi.mocked(runAccountConversationPlanningTurn).mockReset();
  vi.mocked(executeAccountConversationPlan).mockReset();
  vi.mocked(finalizeAccountConversationTurn).mockReset();
});

describe("internal durable account-turn lifecycle", () => {
  it("composes an incomplete food plan through execution and exact completion", async () => {
    const h = harness();
    expect(await h.run()).toEqual({
      kind: "COMPLETED",
      response: "  Saved. ✅\n",
    });
    expect(h.events).toEqual([
      "planning-boundary",
      "checkpoint-count",
      "execution-boundary",
      "finalization-boundary",
    ]);
    expect(h.stepResults.listForTurn).toHaveBeenCalledWith(userId, turnId);
    expect(executeAccountConversationPlan).toHaveBeenCalledWith(
      h.dependencies.execution,
      { trustedUserId: userId, turnId },
    );
    expect(finalizeAccountConversationTurn).toHaveBeenCalledWith(
      h.dependencies.finalization,
      { trustedUserId: userId, turnId },
    );
  });

  it("passes the normalized trusted owner ID to strict saved-result hydration", async () => {
    const h = harness(toolPlan, 2);
    await runDurableAccountConversationTurn(h.dependencies, {
      ...request,
      trustedUserId: userId.toUpperCase(),
    });
    expect(h.stepResults.listForTurn).toHaveBeenCalledWith(userId, turnId);
    expect(finalizeAccountConversationTurn).toHaveBeenCalledWith(
      h.dependencies.finalization,
      { trustedUserId: userId, turnId },
    );
  });

  it("returns completed replay before any checkpoint, execution or finalization", async () => {
    const h = harness();
    vi.mocked(runAccountConversationPlanningTurn).mockResolvedValueOnce({
      kind: "COMPLETED_REPLAY",
      response: "  First winner. ✅\n",
    });
    expect(await h.run()).toEqual({
      kind: "COMPLETED",
      response: "  First winner. ✅\n",
    });
    expect(h.stepResults.listForTurn).not.toHaveBeenCalled();
    expect(executeAccountConversationPlan).not.toHaveBeenCalled();
    expect(finalizeAccountConversationTurn).not.toHaveBeenCalled();
  });

  it("sends a durable direct response straight to completion", async () => {
    const h = harness(directPlan);
    expect(await h.run()).toEqual({
      kind: "COMPLETED",
      response: "  Saved. ✅\n",
    });
    expect(h.events).toEqual(["planning-boundary", "finalization-boundary"]);
  });

  it("skips execution entirely when every step result is durable", async () => {
    const h = harness(toolPlan, 2);
    expect(await h.run()).toMatchObject({ kind: "COMPLETED" });
    expect(h.events).toEqual([
      "planning-boundary",
      "checkpoint-count",
      "finalization-boundary",
    ]);
    expect(executeAccountConversationPlan).not.toHaveBeenCalled();
  });

  it("resumes an incomplete durable prefix without replanning in the runner", async () => {
    const h = harness(toolPlan, 1);
    expect(await h.run()).toMatchObject({ kind: "COMPLETED" });
    expect(executeAccountConversationPlan).toHaveBeenCalledTimes(1);
    expect(runAccountConversationPlanningTurn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: "TARGETS_REQUIRED", localDate: "2026-10-27" },
    { kind: "AMBIGUOUS_EXISTING_DAYS", localDate: "2026-10-27" },
    {
      kind: "ENTRY_REFERENCE_STALE",
      turnId,
      foodDayId: toolPlan.foodDayId!,
      entryId: "40000000-0000-4000-8000-000000000001",
      expectedRevision: 2,
    },
    { kind: "DAYLESS_READY" },
    { kind: "CLARIFICATION_READY", question: "Which day?" },
  ] as const)("preserves terminal pending outcome $kind", async (outcome) => {
    const h = harness();
    vi.mocked(runAccountConversationPlanningTurn).mockResolvedValueOnce(
      outcome,
    );
    expect(await h.run()).toEqual(outcome);
    expect(h.stepResults.listForTurn).not.toHaveBeenCalled();
    expect(executeAccountConversationPlan).not.toHaveBeenCalled();
    expect(finalizeAccountConversationTurn).not.toHaveBeenCalled();
  });

  it("does not finalize after a typed execution conflict", async () => {
    const h = harness();
    const conflict = new Error("frozen revision conflict");
    vi.mocked(executeAccountConversationPlan).mockRejectedValueOnce(conflict);
    await expect(h.run()).rejects.toBe(conflict);
    expect(finalizeAccountConversationTurn).not.toHaveBeenCalled();
  });

  it("passes through a concurrent completed winner from the executor", async () => {
    const h = harness();
    vi.mocked(executeAccountConversationPlan).mockResolvedValueOnce({
      kind: "COMPLETED_REPLAY",
      response: "Other worker's exact answer",
    });
    expect(await h.run()).toEqual({
      kind: "COMPLETED",
      response: "Other worker's exact answer",
    });
    expect(finalizeAccountConversationTurn).not.toHaveBeenCalled();
  });

  it("propagates a changed retry conflict before downstream work", async () => {
    const h = harness();
    const conflict = new Error("typed claim conflict");
    vi.mocked(runAccountConversationPlanningTurn).mockRejectedValueOnce(
      conflict,
    );
    await expect(h.run()).rejects.toBe(conflict);
    expect(h.stepResults.listForTurn).not.toHaveBeenCalled();
    expect(executeAccountConversationPlan).not.toHaveBeenCalled();
    expect(finalizeAccountConversationTurn).not.toHaveBeenCalled();
  });

  it("retries blocked targets through planning and continues after targets exist", async () => {
    const h = harness();
    vi.mocked(runAccountConversationPlanningTurn).mockResolvedValueOnce({
      kind: "TARGETS_REQUIRED",
      localDate: "2026-10-27",
    });
    expect(await h.run()).toEqual({
      kind: "TARGETS_REQUIRED",
      localDate: "2026-10-27",
    });
    expect(await h.run()).toMatchObject({ kind: "COMPLETED" });
    expect(executeAccountConversationPlan).toHaveBeenCalledTimes(1);
  });

  it("resumes after execution failure from the same saved plan", async () => {
    const h = harness();
    vi.mocked(executeAccountConversationPlan).mockRejectedValueOnce(
      new Error("worker stopped"),
    );
    await expect(h.run()).rejects.toThrow("worker stopped");
    expect(finalizeAccountConversationTurn).not.toHaveBeenCalled();
    expect(await h.run()).toMatchObject({ kind: "COMPLETED" });
    expect(executeAccountConversationPlan).toHaveBeenCalledTimes(2);
  });

  it("retries finalization after model failure without executing a completed plan", async () => {
    const h = harness(toolPlan, 2);
    vi.mocked(finalizeAccountConversationTurn).mockRejectedValueOnce(
      new Error("model unavailable"),
    );
    await expect(h.run()).rejects.toThrow("model unavailable");
    expect(await h.run()).toMatchObject({ kind: "COMPLETED" });
    expect(executeAccountConversationPlan).not.toHaveBeenCalled();
    expect(finalizeAccountConversationTurn).toHaveBeenCalledTimes(2);
  });

  it("replays after the completed return is lost without any downstream stages", async () => {
    const h = harness(toolPlan, 2);
    vi.mocked(finalizeAccountConversationTurn).mockRejectedValueOnce(
      new Error("return lost"),
    );
    await expect(h.run()).rejects.toThrow("return lost");
    vi.mocked(runAccountConversationPlanningTurn).mockResolvedValueOnce({
      kind: "COMPLETED_REPLAY",
      response: "  Stored first winner. ✅\n",
    });
    expect(await h.run()).toEqual({
      kind: "COMPLETED",
      response: "  Stored first winner. ✅\n",
    });
    expect(h.stepResults.listForTurn).toHaveBeenCalledTimes(1);
    expect(finalizeAccountConversationTurn).toHaveBeenCalledTimes(1);
  });

  it("concurrent invocations converge on the persisted completion response", async () => {
    const h = harness(toolPlan, 2);
    vi.mocked(finalizeAccountConversationTurn).mockResolvedValue({
      response: "First stored winner",
    });
    expect(await Promise.all([h.run(), h.run()])).toEqual([
      { kind: "COMPLETED", response: "First stored winner" },
      { kind: "COMPLETED", response: "First stored winner" },
    ]);
    expect(executeAccountConversationPlan).not.toHaveBeenCalled();
  });
});
