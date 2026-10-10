import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { FoodDayToolResult } from "../agent/tools/execute-food-day-tool.js";
import {
  historyEvalScenarios,
  historyEvalState,
} from "./body-weight-history-eval-fixtures.js";

function scenario(id: (typeof historyEvalScenarios)[number]["id"]) {
  const found = historyEvalScenarios.find((item) => item.id === id);
  if (!found) throw new Error(`Missing fixture ${id}.`);
  return found;
}

function historyResult(
  result: FoodDayToolResult,
): Extract<FoodDayToolResult, { name: "GET_BODY_WEIGHT_HISTORY" }>["result"] {
  if (result.name !== "GET_BODY_WEIGHT_HISTORY") {
    throw new Error("Expected a history read result.");
  }
  return result.result;
}

describe("M4D7C opt-in fixture registry", () => {
  it("registers exactly A-H with a mechanically bounded 16-call ceiling", () => {
    expect(historyEvalScenarios.map(({ id }) => id)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
    ]);
    expect(
      historyEvalScenarios.map(({ maxResponsesCalls }) => maxResponsesCalls),
    ).toEqual([2, 2, 2, 2, 2, 3, 1, 2]);
    expect(
      historyEvalScenarios.reduce(
        (total, item) => total + item.maxResponsesCalls,
        0,
      ),
    ).toBe(16);
    expect(
      historyEvalScenarios.map(({ expectedDecision }) => expectedDecision),
    ).toEqual([
      "HISTORY_READ",
      "HISTORY_READ",
      "HISTORY_READ",
      "HISTORY_READ",
      "HISTORY_READ",
      "LOG_THEN_READ",
      "FINAL",
      null,
    ]);
  });

  it("freezes exact messages, the sole transcript, and the sole calendar context", () => {
    expect(historyEvalScenarios.map(({ userMessage }) => userMessage)).toEqual([
      "What's my latest weight?",
      "What's my latest weight?",
      "What's my latest weight?",
      "What weights have I logged recently?",
      "Did I log a weight on 2026-09-01?",
      "I weighed 80 kg today. What's my latest weight?",
      "How much weight have I lost?",
      "I weighed 80 kg today. What's my latest weight?",
    ]);
    expect(scenario("A").recentTranscript).toEqual([
      {
        userMessage: "On 2026-10-05 I weighed 80.4 kg.",
        response: "Logged 80.4 kg for October 5.",
      },
    ]);
    expect(
      historyEvalScenarios.filter((item) => item.recentTranscript),
    ).toHaveLength(1);
    expect(scenario("F").calendarContext).toEqual({
      currentLocalDate: "2026-10-06",
    });
    expect(
      historyEvalScenarios.filter((item) => item.calendarContext),
    ).toHaveLength(1);
    expect(historyEvalState.foodDay.localDate).toBe("2026-10-01");
    expect(JSON.stringify(historyEvalState)).not.toMatch(
      /latestWeight|recentWeights|weightHistory|weightTrend/,
    );
  });

  it("projects A-E through the production history contract without IDs or ingestion time", () => {
    for (const id of ["A", "B", "C", "D", "E"] as const) {
      const results = scenario(id).toolResults;
      expect(results).toHaveLength(1);
      const result = historyResult(results![0]!);
      expect(result).toHaveProperty("recentObservations");
      expect(JSON.stringify(result)).not.toMatch(/"(?:id|userId|createdAt)"/);
    }
    expect(historyResult(scenario("A").toolResults![0]!)).toEqual({
      recentObservations: [],
      recentHistoryMayBeTruncated: false,
      latestMeasurementDate: null,
      latestDateObservationCount: 0,
      latestDateObservations: [],
      latestDateObservationsComplete: true,
    });
    expect(historyResult(scenario("B").toolResults![0]!)).toMatchObject({
      latestMeasurementDate: "2026-10-06",
      latestDateObservationCount: 1,
      latestDateObservations: [{ sourceValue: "79.8", weightKg: "79.8" }],
    });
    expect(historyResult(scenario("C").toolResults![0]!)).toMatchObject({
      latestDateObservationCount: 2,
      latestDateObservationsComplete: true,
      latestDateObservations: [{ sourceValue: "80.2" }, { sourceValue: "81" }],
    });
    expect(
      historyResult(scenario("D").toolResults![0]!).recentObservations.map(
        ({ localDate, sourceValue }) => [localDate, sourceValue],
      ),
    ).toEqual([
      ["2026-10-06", "80"],
      ["2026-10-05", "79.5"],
      ["2026-10-04", "79"],
    ]);
    const bounded = historyResult(scenario("E").toolResults![0]!);
    expect(bounded.recentObservations).toHaveLength(30);
    expect(bounded.recentHistoryMayBeTruncated).toBe(true);
    expect(
      bounded.recentObservations.some(
        ({ localDate }) => localDate === "2026-09-01",
      ),
    ).toBe(false);
    expect(bounded.latestMeasurementDate).toBe("2026-10-06");
    expect(bounded.latestDateObservationCount).toBe(1);
    expect(bounded.latestDateObservationsComplete).toBe(true);
    expect(bounded.latestDateObservations).toEqual([
      bounded.recentObservations[0],
    ]);
    expect(
      bounded.recentObservations.every(({ localDate }) =>
        /^2026-10-0[56]$/.test(localDate),
      ),
    ).toBe(true);
  });

  it("preserves F fresh LOG->GET and H stale GET->LOG->fresh GET result order", () => {
    expect(scenario("F").toolResults?.map(({ name }) => name)).toEqual([
      "LOG_BODY_WEIGHT",
      "GET_BODY_WEIGHT_HISTORY",
    ]);
    expect(scenario("H").toolResults?.map(({ name }) => name)).toEqual([
      "GET_BODY_WEIGHT_HISTORY",
      "LOG_BODY_WEIGHT",
      "GET_BODY_WEIGHT_HISTORY",
    ]);
    const fresh = historyResult(scenario("F").toolResults![1]!);
    const stale = historyResult(scenario("H").toolResults![0]!);
    const refreshed = historyResult(scenario("H").toolResults![2]!);
    expect(fresh.latestDateObservations).toEqual([
      {
        localDate: "2026-10-06",
        sourceValue: "80",
        sourceUnit: "KG",
        weightKg: "80",
      },
    ]);
    expect(stale.latestDateObservations).toEqual([
      {
        localDate: "2026-10-05",
        sourceValue: "79.5",
        sourceUnit: "KG",
        weightKg: "79.5",
      },
    ]);
    expect(refreshed).toEqual(fresh);
    expect(scenario("G").toolResults).toBeUndefined();
    for (const id of ["F", "H"] as const) {
      const log = scenario(id).toolResults?.find(
        (item) => item.name === "LOG_BODY_WEIGHT",
      );
      if (log?.name !== "LOG_BODY_WEIGHT")
        throw new Error("Missing log fixture.");
      expect(Object.keys(log.result)).toEqual(["disposition", "weightEntry"]);
      expect(log.result.disposition).toBe("CREATED");
      expect(log.result.weightEntry).toEqual({
        id: "30000000-0000-4000-8000-000000000001",
        localDate: "2026-10-06",
        sourceValue: "80",
        sourceUnit: "KG",
        weightKg: "80",
        createdAt: "2026-10-07T12:00:00.000Z",
      });
    }
  });

  it("clones model inputs so one case cannot mutate shared fixture data", () => {
    const state = structuredClone(historyEvalState);
    const transcript = structuredClone(scenario("A").recentTranscript);
    const results = structuredClone(scenario("E").toolResults);
    Reflect.set(state.foodDay, "localDate", "2026-10-02");
    Reflect.set(transcript![0]!, "response", "changed");
    if (results?.[0]?.name !== "GET_BODY_WEIGHT_HISTORY") {
      throw new Error("Missing history fixture.");
    }
    Reflect.set(
      results[0].result.recentObservations[0]!,
      "localDate",
      "2026-09-01",
    );
    expect(historyEvalState.foodDay.localDate).toBe("2026-10-01");
    expect(scenario("A").recentTranscript?.[0]?.response).toBe(
      "Logged 80.4 kg for October 5.",
    );
    expect(
      historyResult(scenario("E").toolResults![0]!).recentObservations[0]
        ?.localDate,
    ).toBe("2026-10-06");
  });

  it("selects only this live file and excludes it from ordinary API tests", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(
      packageJson.scripts["eval:openai:body-weight-history-semantics"],
    ).toBe(
      "vitest run src/integration/openai-body-weight-history-semantics.eval.integration.test.ts --retry 0",
    );
    expect(packageJson.scripts.test).toContain(
      "src/integration/**/*.integration.test.ts",
    );
  });
});
