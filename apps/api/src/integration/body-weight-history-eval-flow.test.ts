import { describe, expect, it, vi } from "vitest";

import type { FoodDayTurnModel } from "../agent/turn/food-day-turn-types.js";
import {
  historyEvalScenarios,
  historyEvalState,
} from "./body-weight-history-eval-fixtures.js";
import { completeHistoryEvalTurn } from "./body-weight-history-eval-flow.js";

function scenario(id: "B" | "F" | "H") {
  const found = historyEvalScenarios.find((item) => item.id === id);
  if (!found) throw new Error("Missing eval fixture.");
  return found;
}

function setup() {
  const finalizeOrRead = vi.fn<FoodDayTurnModel["finalizeOrRead"]>();
  const finalize = vi.fn<FoodDayTurnModel["finalize"]>();
  finalize.mockResolvedValue("Logged 80 kg. Latest is 80 kg on Oct 6.");
  return {
    model: { finalizeOrRead, finalize },
    finalizeOrRead,
    finalize,
    input: {
      state: historyEvalState,
      recentTranscript: [],
      userMessage: scenario("F").userMessage,
    },
  };
}

const readStep = {
  type: "READ_TOOL" as const,
  call: { name: "GET_BODY_WEIGHT_HISTORY" as const, arguments: {} },
};

describe("continuation-aware live-eval flow, offline", () => {
  it("keeps an unchanged direct history case to one post-tool FINAL", async () => {
    const { model, finalizeOrRead, finalize, input } = setup();
    finalizeOrRead.mockResolvedValue({ type: "FINAL", text: "History read." });
    const result = await completeHistoryEvalTurn(
      model,
      scenario("B"),
      input,
      false,
    );
    expect(result).toEqual({ answer: "History read.", modelCalls: 1 });
    expect(
      finalizeOrRead.mock.calls[0]?.[0].toolResults.map(({ name }) => name),
    ).toEqual(["GET_BODY_WEIGHT_HISTORY"]);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("requires a post-log canonical read for F's LOG-only recovery path", async () => {
    const { model, finalizeOrRead, finalize, input } = setup();
    finalizeOrRead.mockResolvedValue(readStep);
    const phases: string[] = [];
    const result = await completeHistoryEvalTurn(
      model,
      scenario("F"),
      input,
      true,
      (phase) => phases.push(phase),
    );
    expect(result.modelCalls).toBe(2);
    expect(phases).toEqual(["POST_TOOL", "FINAL_FINALIZATION"]);
    expect(
      finalizeOrRead.mock.calls[0]?.[0].toolResults.map(({ name }) => name),
    ).toEqual(["LOG_BODY_WEIGHT"]);
    expect(
      finalize.mock.calls[0]?.[0].toolResults.map(({ name }) => name),
    ).toEqual(["LOG_BODY_WEIGHT", "GET_BODY_WEIGHT_HISTORY"]);
  });

  it("accepts F's ideal initial LOG/GET batch without another read", async () => {
    const { model, finalizeOrRead, finalize, input } = setup();
    finalizeOrRead.mockResolvedValue({ type: "FINAL", text: "Fresh result." });
    const result = await completeHistoryEvalTurn(
      model,
      scenario("F"),
      input,
      false,
    );
    expect(result).toEqual({ answer: "Fresh result.", modelCalls: 1 });
    expect(
      finalizeOrRead.mock.calls[0]?.[0].toolResults.map(({ name }) => name),
    ).toEqual(["LOG_BODY_WEIGHT", "GET_BODY_WEIGHT_HISTORY"]);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("requires a fresh GET after H's stale GET/LOG results", async () => {
    const { model, finalizeOrRead, finalize, input } = setup();
    finalizeOrRead.mockResolvedValue(readStep);
    const phases: string[] = [];
    const result = await completeHistoryEvalTurn(
      model,
      scenario("H"),
      input,
      false,
      (phase) => phases.push(phase),
    );
    expect(result.modelCalls).toBe(2);
    expect(phases).toEqual(["POST_TOOL", "FINAL_FINALIZATION"]);
    expect(
      finalizeOrRead.mock.calls[0]?.[0].toolResults.map(({ name }) => name),
    ).toEqual(["GET_BODY_WEIGHT_HISTORY", "LOG_BODY_WEIGHT"]);
    expect(
      finalize.mock.calls[0]?.[0].toolResults.map(({ name }) => name),
    ).toEqual([
      "GET_BODY_WEIGHT_HISTORY",
      "LOG_BODY_WEIGHT",
      "GET_BODY_WEIGHT_HISTORY",
    ]);
  });

  it("rejects a LOG-only final answer and a malformed continuation read", async () => {
    const { model, finalizeOrRead, finalize, input } = setup();
    finalizeOrRead.mockResolvedValueOnce({
      type: "FINAL",
      text: "Latest is 80 kg.",
    });
    await expect(
      completeHistoryEvalTurn(model, scenario("F"), input, true),
    ).rejects.toMatchObject({
      name: "HistoryEvalFlowMismatch",
      expectedStep: "GET_BODY_WEIGHT_HISTORY({})",
      actualStep: { type: "FINAL" },
    });
    finalizeOrRead.mockResolvedValueOnce({
      type: "READ_TOOL",
      call: { name: "GET_BODY_WEIGHT_HISTORY", arguments: { limit: 1 } },
    } as never);
    await expect(
      completeHistoryEvalTurn(model, scenario("F"), input, true),
    ).rejects.toMatchObject({
      name: "HistoryEvalFlowMismatch",
      expectedStep: "GET_BODY_WEIGHT_HISTORY({})",
      actualStep: {
        type: "READ_TOOL",
        tool: "GET_BODY_WEIGHT_HISTORY",
        argumentCount: 1,
        recognizedArgumentKeys: ["limit"],
      },
    });
    expect(finalize).not.toHaveBeenCalled();
  });

  it("rejects a redundant read when the initial batch already contains a fresh GET", async () => {
    const { model, finalizeOrRead, finalize, input } = setup();
    finalizeOrRead.mockResolvedValue(readStep);
    await expect(
      completeHistoryEvalTurn(model, scenario("F"), input, false),
    ).rejects.toMatchObject({
      name: "HistoryEvalFlowMismatch",
      expectedStep: "FINAL",
      actualStep: {
        type: "READ_TOOL",
        tool: "GET_BODY_WEIGHT_HISTORY",
        argumentCount: 0,
      },
    });
    expect(finalize).not.toHaveBeenCalled();
  });

  it("rejects a mutation-shaped post-tool step without executing it", async () => {
    const { model, finalizeOrRead, finalize, input } = setup();
    finalizeOrRead.mockResolvedValue({
      type: "READ_TOOL",
      call: { name: "LOG_BODY_WEIGHT", arguments: {} },
    } as never);
    await expect(
      completeHistoryEvalTurn(model, scenario("F"), input, true),
    ).rejects.toMatchObject({
      name: "HistoryEvalFlowMismatch",
      expectedStep: "GET_BODY_WEIGHT_HISTORY({})",
      actualStep: { type: "READ_TOOL", tool: "LOG_BODY_WEIGHT" },
    });
    expect(finalize).not.toHaveBeenCalled();
  });
});
