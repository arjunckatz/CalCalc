import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import {
  AccountTurnIdempotencyConflictError,
  type AccountTurnPlan,
  type AccountTurnRoutingResolution,
  type PersistedAccountTurn,
} from "@cal-calc/persistence";
import { describe, expect, it, vi } from "vitest";

import { parseIdempotencyKey } from "../mutations/mutation-identity.js";
import { deriveAccountTurnIdentity } from "./account-turn.js";
import { acceptCalendarContext } from "./calendar-context.js";
import {
  AccountTurnPlanIntegrityError,
  runAccountConversationPlanningTurn,
} from "./run-account-conversation-planning-turn.js";

const userId = "10000000-0000-4000-8000-000000000001";
const turnId = "20000000-0000-4000-8000-000000000001";
const foodDayId = "30000000-0000-4000-8000-000000000001";
const entryId = "40000000-0000-4000-8000-000000000001";
const schema = "account-routing-resolution-v1";
const existing = { schema, kind: "EXISTING_DAY", foodDayId } as const;
const reference = {
  schema,
  kind: "EXISTING_ENTRY_REFERENCE",
  foodDayId,
  entryId,
  revision: 3,
} as const;
const date = { schema, kind: "DATE_TARGET", localDate: "2026-10-19" } as const;
const acceptedCalendar = acceptCalendarContext({
  currentLocalDateTime: "2026-10-19T08:00:00+05:30",
  timeZone: "Asia/Kolkata",
});
if (acceptedCalendar === null)
  throw new Error("Calendar fixture was not accepted.");
const request = (
  message = "Please update the oats.",
  calendarContext: typeof acceptedCalendar | null = null,
) => ({
  trustedUserId: userId,
  idempotencyKey: parseIdempotencyKey("one-turn"),
  userMessage: message,
  calendarContext,
});

function harness(
  resolution: AccountTurnRoutingResolution = existing,
  message = "Please update the oats.",
  calendarContext: typeof acceptedCalendar | null = null,
) {
  const identity = deriveAccountTurnIdentity({
    ...request(message, calendarContext),
    calendarContext:
      calendarContext === null
        ? null
        : {
            currentLocalDateTime: calendarContext.currentLocalDateTime,
            timeZone: calendarContext.timeZone,
          },
  });
  let row: PersistedAccountTurn = {
    id: turnId,
    userId,
    turnKey: identity.turnKey,
    requestFingerprint: identity.requestFingerprint,
    userMessage: message,
    calendarContext,
    status: "PENDING",
    routingResolution: resolution,
    resolvedFoodDayId:
      resolution.kind === "EXISTING_DAY" ||
      resolution.kind === "EXISTING_ENTRY_REFERENCE"
        ? foodDayId
        : null,
    executionPlan: null,
    response: null,
    createdAt: "2026-10-19T00:00:00Z",
    completedAt: null,
  };
  const day = createFoodDay({
    id: foodDayId,
    status: "OPEN",
    calorieTarget: "2000",
    proteinTarget: "100",
  });
  let entry = {
    ...createFoodEntry({
      id: entryId,
      foodDayId,
      rawUserDescription: "oats",
      displayName: "Oats",
      quantity: { amount: "1", unit: "SERVING" },
      nutritionBasis: {
        amount: "1",
        unit: "SERVING",
        nutrition: { calories: "100", protein: "10" },
      },
      evidenceClass: "EXACT",
      status: "CONFIRMED_CONSUMED",
    }),
    revision: 3,
  };
  const turns = {
    claimPending: vi.fn(async (input: typeof identity & { id: string }) => {
      if (
        input.requestFingerprint !== row.requestFingerprint ||
        input.turnKey !== row.turnKey
      )
        throw new AccountTurnIdempotencyConflictError();
      return { disposition: "EXISTING" as const, turn: row };
    }),
    findByKey: vi.fn(async () => row),
    findExecutionCheckpoint: vi.fn(async () => ({
      turnId,
      userId,
      status: row.status,
      routingResolution: row.routingResolution,
      resolvedFoodDayId: row.resolvedFoodDayId,
      materializedFoodDayId:
        resolution.kind === "DATE_TARGET" ? foodDayId : null,
    })),
    setRoutingResolutionOnce: vi.fn(async () => {
      throw new Error("No routing write expected.");
    }),
    setPlanOnce: vi.fn(async (input: { plan: AccountTurnPlan }) => {
      if (row.executionPlan === null)
        row = { ...row, executionPlan: input.plan };
      return row;
    }),
    listRecentCompleted: vi.fn(async () => [
      { userMessage: "Earlier", response: "Earlier answer" },
    ]),
  };
  const foodDays = {
    findById: vi.fn(async () => ({
      userId,
      foodDay: day,
      localDate: "2026-10-19",
      completeness: "PARTIAL" as const,
      openedAt: "2026-10-19T00:00:00Z",
      createdAt: "2026-10-19T00:00:00Z",
      updatedAt: "2026-10-19T00:00:00Z",
    })),
  };
  const foodEntries = {
    listActiveByFoodDay: vi.fn(async () => [entry]),
    findById: vi.fn(async () => ({
      userId,
      entry,
      reportedAt: "2026-10-19T00:00:00Z",
      createdAt: "2026-10-19T00:00:00Z",
      updatedAt: "2026-10-19T00:00:00Z",
    })),
  };
  const decide = vi.fn(async () => ({ type: "FINAL" as const, text: "Done." }));
  const materializeFoodDay = vi.fn(async () => ({
    kind: "FOOD_DAY_READY" as const,
    foodDayId,
    source: "EXISTING" as const,
  }));
  const dependencies = {
    turns,
    routing: {} as never,
    model: {
      decide: vi.fn(async () => {
        throw new Error("No routing call expected.");
      }),
    },
    materializeFoodDay,
    foodDays,
    foodEntries,
    foodDayModel: { decide },
  };
  return {
    dependencies,
    turns,
    foodDays,
    foodEntries,
    decide,
    materializeFoodDay,
    getRow: () => row,
    setRow: (value: PersistedAccountTurn) => {
      row = value;
    },
    setEntryRevision: (revision: number) => {
      entry = { ...entry, revision };
    },
  };
}

describe("durable account FoodDay planning coordinator", () => {
  it("uses exact durable message and accepted calendar date rather than server time", async () => {
    const message = "  I weighed 80 kg today.  ";
    const test = harness(existing, message, acceptedCalendar);
    await runAccountConversationPlanningTurn(
      test.dependencies,
      request(message, acceptedCalendar),
    );
    expect(test.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: message,
        calendarContext: { currentLocalDate: "2026-10-19" },
      }),
    );
    expect(test.getRow().userMessage).toBe(message);
  });

  it("persists a direct response while pending, then retries with no preparation or model", async () => {
    const test = harness();
    test.decide.mockResolvedValue({ type: "FINAL", text: "  Hello.  " });
    const first = await runAccountConversationPlanningTurn(
      test.dependencies,
      request(),
    );
    expect(first).toMatchObject({
      kind: "PLAN_READY",
      turnId,
      plan: {
        foodDayId,
        slots: [
          {
            index: 0,
            action: "DIRECT_RESPONSE",
            command: { response: "Hello." },
          },
        ],
      },
    });
    expect(test.getRow().status).toBe("PENDING");
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: request().userMessage,
        recentTranscript: [
          { userMessage: "Earlier", response: "Earlier answer" },
        ],
      }),
    );
    expect(test.turns.listRecentCompleted).toHaveBeenCalledWith(userId);
    test.foodDays.findById.mockClear();
    test.turns.listRecentCompleted.mockClear();
    expect(
      await runAccountConversationPlanningTurn(test.dependencies, request()),
    ).toEqual(first);
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.foodDays.findById).not.toHaveBeenCalled();
    expect(test.turns.listRecentCompleted).not.toHaveBeenCalled();
    expect(test.turns.setPlanOnce).toHaveBeenCalledTimes(1);
  });

  it("freezes entry revision and completeness in ordered slots without executing tools", async () => {
    const test = harness();
    test.decide.mockResolvedValue({
      type: "TOOLS",
      calls: [
        {
          name: "UPDATE_FOOD_QUANTITY",
          arguments: {
            entryId,
            expectedRevision: 3,
            quantity: { amount: "2", unit: "SERVING" },
            overrideAction: { type: "PRESERVE" },
          },
        },
        {
          name: "SET_FOOD_DAY_COMPLETENESS",
          arguments: { targetCompleteness: "USER_DECLARED_COMPLETE" },
        },
        { name: "GET_BODY_WEIGHT_HISTORY", arguments: {} },
      ],
    } as never);
    const first = await runAccountConversationPlanningTurn(
      test.dependencies,
      request(),
    );
    expect(first).toMatchObject({
      kind: "PLAN_READY",
      plan: {
        slots: [
          {
            index: 0,
            action: "UPDATE_FOOD_QUANTITY",
            command: { entryId, expectedRevision: 3 },
          },
          {
            index: 1,
            action: "SET_FOOD_DAY_COMPLETENESS",
            command: { expectedCompleteness: "PARTIAL" },
          },
          { index: 2, action: "GET_BODY_WEIGHT_HISTORY", command: {} },
        ],
      },
    });
    test.setEntryRevision(4);
    expect(
      await runAccountConversationPlanningTurn(test.dependencies, request()),
    ).toEqual(first);
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.foodDays.findById).toHaveBeenCalledTimes(1);
  });

  it("passes durable entry grounding to the model and stops on pre-plan staleness", async () => {
    const test = harness(reference);
    await runAccountConversationPlanningTurn(test.dependencies, request());
    expect(test.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        entryReference: { entryId, expectedRevision: 3 },
      }),
    );
    const stale = harness(reference);
    stale.setEntryRevision(4);
    expect(
      await runAccountConversationPlanningTurn(stale.dependencies, request()),
    ).toEqual({
      kind: "ENTRY_REFERENCE_STALE",
      turnId,
      foodDayId,
      entryId,
      expectedRevision: 3,
    });
    expect(stale.decide).not.toHaveBeenCalled();
    expect(stale.turns.setPlanOnce).not.toHaveBeenCalled();
  });

  it("replays the frozen plan before reference staleness after a later revision change", async () => {
    const test = harness(reference);
    test.decide.mockResolvedValue({
      type: "TOOLS",
      calls: [
        { name: "REMOVE_FOOD", arguments: { entryId, expectedRevision: 3 } },
      ],
    } as never);
    const first = await runAccountConversationPlanningTurn(
      test.dependencies,
      request(),
    );
    test.setEntryRevision(4);
    test.foodEntries.findById.mockClear();
    test.foodDays.findById.mockClear();
    expect(
      await runAccountConversationPlanningTurn(test.dependencies, request()),
    ).toEqual(first);
    expect(test.foodEntries.findById).not.toHaveBeenCalled();
    expect(test.foodDays.findById).not.toHaveBeenCalled();
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      kind: "PLAN_READY",
      plan: { slots: [{ command: { entryId, expectedRevision: 3 } }] },
    });
  });

  it("replays a DATE_TARGET plan before materialization, even if its target later changes", async () => {
    const test = harness(date);
    const first = await runAccountConversationPlanningTurn(
      test.dependencies,
      request(),
    );
    expect(test.materializeFoodDay).toHaveBeenCalledTimes(1);
    test.materializeFoodDay.mockClear();
    test.foodDays.findById.mockClear();
    expect(
      await runAccountConversationPlanningTurn(test.dependencies, request()),
    ).toEqual(first);
    expect(test.materializeFoodDay).not.toHaveBeenCalled();
    expect(test.foodDays.findById).not.toHaveBeenCalled();
  });

  it("converges different concurrent decisions on the stored first writer", async () => {
    const test = harness();
    let call = 0;
    test.decide.mockImplementation(async () => ({
      type: "FINAL",
      text: ++call === 1 ? "First." : "Second.",
    }));
    const [left, right] = await Promise.all([
      runAccountConversationPlanningTurn(test.dependencies, request()),
      runAccountConversationPlanningTurn(test.dependencies, request()),
    ]);
    expect(left).toEqual(right);
    expect(left).toMatchObject({
      plan: { slots: [{ command: { response: "First." } }] },
    });
    expect(test.turns.setPlanOnce).toHaveBeenCalledTimes(2);
  });

  it("permits replanning only when persistence failed before the checkpoint", async () => {
    const test = harness();
    test.turns.setPlanOnce.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      runAccountConversationPlanningTurn(test.dependencies, request()),
    ).rejects.toThrow("write failed");
    expect(test.getRow().executionPlan).toBeNull();
    await expect(
      runAccountConversationPlanningTurn(test.dependencies, request()),
    ).resolves.toMatchObject({ kind: "PLAN_READY" });
    expect(test.decide).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid model output without saving a plan", async () => {
    const test = harness();
    test.decide.mockResolvedValue({
      type: "TOOLS",
      calls: [
        { name: "REMOVE_FOOD", arguments: { entryId, expectedRevision: 99 } },
      ],
    } as never);
    await expect(
      runAccountConversationPlanningTurn(test.dependencies, request()),
    ).rejects.toThrow();
    expect(test.turns.setPlanOnce).not.toHaveBeenCalled();
    expect(test.getRow().executionPlan).toBeNull();
  });

  it("returns completed replay before inspecting a stored plan or any other work", async () => {
    const test = harness();
    test.setRow({
      ...test.getRow(),
      status: "COMPLETED",
      response: "Exact answer",
      completedAt: "2026-10-19T00:01:00Z",
      executionPlan: {
        schema: "account-turn-plan-v1",
        foodDayId,
        slots: [
          {
            index: 0,
            action: "DIRECT_RESPONSE",
            command: { response: "Earlier." },
          },
        ],
      },
    });
    expect(
      await runAccountConversationPlanningTurn(test.dependencies, request()),
    ).toEqual({ kind: "COMPLETED_REPLAY", response: "Exact answer" });
    expect(test.turns.findExecutionCheckpoint).not.toHaveBeenCalled();
    expect(test.decide).not.toHaveBeenCalled();
    expect(test.materializeFoodDay).not.toHaveBeenCalled();
  });

  it("rejects a persisted plan bound to a different FoodDay before STATE or model", async () => {
    const test = harness();
    test.setRow({
      ...test.getRow(),
      executionPlan: {
        schema: "account-turn-plan-v1",
        foodDayId: entryId,
        slots: [
          {
            index: 0,
            action: "DIRECT_RESPONSE",
            command: { response: "Wrong target" },
          },
        ],
      },
    });
    await expect(
      runAccountConversationPlanningTurn(test.dependencies, request()),
    ).rejects.toBeInstanceOf(AccountTurnPlanIntegrityError);
    expect(test.foodDays.findById).not.toHaveBeenCalled();
    expect(test.decide).not.toHaveBeenCalled();
  });

  it("leaves DAYLESS outside FoodDay planning and preserves key conflicts", async () => {
    const test = harness({ schema, kind: "DAYLESS" });
    expect(
      await runAccountConversationPlanningTurn(test.dependencies, request()),
    ).toEqual({ kind: "DAYLESS_READY" });
    expect(test.decide).not.toHaveBeenCalled();
    await expect(
      runAccountConversationPlanningTurn(
        test.dependencies,
        request("Changed message"),
      ),
    ).rejects.toBeInstanceOf(AccountTurnIdempotencyConflictError);
  });

  it("does not plan a persisted clarification", async () => {
    const test = harness({ schema, kind: "CLARIFY", question: "Which day?" });
    expect(
      await runAccountConversationPlanningTurn(test.dependencies, request()),
    ).toEqual({
      kind: "CLARIFICATION_READY",
      question: "Which day?",
    });
    expect(test.decide).not.toHaveBeenCalled();
    expect(test.turns.listRecentCompleted).not.toHaveBeenCalled();
  });

  it.each([
    ["TARGETS_REQUIRED", "TARGETS_REQUIRED"],
    ["AMBIGUOUS_EXISTING_DAYS", "AMBIGUOUS_EXISTING_DAYS"],
  ] as const)("does not plan %s", async (materializedKind, expectedKind) => {
    const test = harness(date);
    test.materializeFoodDay.mockResolvedValueOnce({
      kind: materializedKind,
    } as never);
    expect(
      await runAccountConversationPlanningTurn(test.dependencies, request()),
    ).toMatchObject({
      kind: expectedKind,
      localDate: date.localDate,
    });
    expect(test.decide).not.toHaveBeenCalled();
    expect(test.turns.listRecentCompleted).not.toHaveBeenCalled();
  });

  it("does not overwrite a completed turn that overtakes plan persistence", async () => {
    const test = harness();
    test.turns.setPlanOnce.mockImplementationOnce(async () => {
      test.setRow({
        ...test.getRow(),
        status: "COMPLETED",
        response: "Stored answer",
        completedAt: "2026-10-19T00:02:00Z",
      });
      throw new Error("completion won");
    });
    expect(
      await runAccountConversationPlanningTurn(test.dependencies, request()),
    ).toEqual({
      kind: "COMPLETED_REPLAY",
      response: "Stored answer",
    });
  });
});
