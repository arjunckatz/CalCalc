import type {
  AccountTurnPlan,
  PersistedAccountTurn,
  PersistedAccountTurnStepResult,
  PersistedConversation,
} from "@cal-calc/persistence";
import { describe, expect, it, vi } from "vitest";

import {
  ActiveFoodDayPointerIntegrityError,
  advanceActiveFoodDayFromCompletedTurn,
  type AdvanceActiveFoodDayDependencies,
} from "./advance-active-food-day-from-completed-turn.js";

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

function plan(...slots: AccountTurnPlan["slots"][number][]): AccountTurnPlan {
  return { schema: "account-turn-plan-v1", foodDayId, slots };
}

function harness(
  executionPlan: AccountTurnPlan | null = plan({
    index: 0,
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
    status: "COMPLETED",
    resolvedFoodDayId: foodDayId,
    routingResolution: {
      schema: "account-routing-resolution-v1",
      kind: "EXISTING_DAY",
      foodDayId,
    },
    executionPlan,
    response: "Logged.",
    createdAt: "2026-10-20T00:00:00Z",
    completedAt: "2026-10-20T00:00:01Z",
  };
  const rows: PersistedAccountTurnStepResult[] = [
    {
      turnId,
      userId,
      ordinal: 0,
      result: {
        schema: "account-turn-step-result-v1",
        action: "LOG_FOOD",
        outcome: { entryId, revision: 1 },
      },
      createdAt: "2026-10-20T00:00:01Z",
    },
  ];
  const turns = {
    findById: vi.fn(async () => turn),
    findExecutionCheckpoint: vi.fn(async () => ({
      turnId,
      userId,
      status: turn.status,
      routingResolution: turn.routingResolution,
      resolvedFoodDayId: foodDayId,
      materializedFoodDayId: null,
    })),
  };
  const stepResults = { listForTurn: vi.fn(async () => rows) };
  const conversations = {
    advanceActiveFoodDayFromCompletedTurn: vi.fn(
      async (): Promise<PersistedConversation | null> => ({
        userId,
        activeFoodDayId: foodDayId,
        activeFoodDayTurnId: turnId,
        version: 1,
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-10-20T00:00:01Z",
      }),
    ),
  };
  const dependencies = {
    turns,
    stepResults,
    conversations,
  } satisfies AdvanceActiveFoodDayDependencies;
  const run = () =>
    advanceActiveFoodDayFromCompletedTurn(dependencies, {
      trustedUserId: userId,
      turnId,
    });
  return { run, turn, rows, turns, stepResults, conversations };
}

describe("completed-turn advisory pointer policy", () => {
  it("advances once only after a completed, validated canonical food effect", async () => {
    const h = harness();
    await expect(h.run()).resolves.toBe("ADVANCED");
    expect(
      h.conversations.advanceActiveFoodDayFromCompletedTurn,
    ).toHaveBeenCalledWith({ userId, turnId });
    h.conversations.advanceActiveFoodDayFromCompletedTurn.mockResolvedValueOnce(
      null,
    );
    await expect(h.run()).resolves.toBe("UNCHANGED");
  });

  it("keeps direct, read-only, body-weight, and pending turns pointer-neutral", async () => {
    const cases = [
      plan({
        index: 0,
        action: "DIRECT_RESPONSE",
        command: { response: "Hello." },
      }),
      plan({ index: 0, action: "GET_BODY_WEIGHT_HISTORY", command: {} }),
      plan({ index: 0, action: "LOG_BODY_WEIGHT", command: {} }),
    ];
    for (const candidate of cases) {
      const h = harness(candidate);
      await expect(h.run()).resolves.toBe("INELIGIBLE");
      expect(h.stepResults.listForTurn).not.toHaveBeenCalled();
      expect(
        h.conversations.advanceActiveFoodDayFromCompletedTurn,
      ).not.toHaveBeenCalled();
    }
    const pending = harness();
    pending.turns.findById.mockResolvedValueOnce({
      ...pending.turn,
      status: "PENDING",
      response: null,
      completedAt: null,
    });
    await expect(pending.run()).resolves.toBe("INELIGIBLE");
  });

  it("accepts a mixed food mutation/read plan only with a full successful prefix", async () => {
    const h = harness(
      plan(
        { index: 0, action: "LOG_FOOD", command: logCommand },
        { index: 1, action: "GET_BODY_WEIGHT_HISTORY", command: {} },
      ),
    );
    await expect(h.run()).rejects.toBeInstanceOf(
      ActiveFoodDayPointerIntegrityError,
    );
    expect(
      h.conversations.advanceActiveFoodDayFromCompletedTurn,
    ).not.toHaveBeenCalled();
    h.rows.push({
      turnId,
      userId,
      ordinal: 1,
      result: {
        schema: "account-turn-step-result-v1",
        action: "GET_BODY_WEIGHT_HISTORY",
        outcome: history,
      },
      createdAt: "2026-10-20T00:00:02Z",
    });
    await expect(h.run()).resolves.toBe("ADVANCED");
  });

  it("rejects a malformed qualifying effect or target rather than guessing", async () => {
    const h = harness();
    h.rows[0] = {
      ...h.rows[0]!,
      result: {
        schema: "account-turn-step-result-v1",
        action: "LOG_FOOD",
        outcome: {},
      },
    };
    await expect(h.run()).rejects.toBeInstanceOf(
      ActiveFoodDayPointerIntegrityError,
    );
    const target = harness();
    target.turns.findById.mockResolvedValueOnce({
      ...target.turn,
      resolvedFoodDayId: null,
      routingResolution: {
        schema: "account-routing-resolution-v1",
        kind: "DAYLESS",
      },
    });
    await expect(target.run()).rejects.toBeInstanceOf(
      ActiveFoodDayPointerIntegrityError,
    );
  });
});
