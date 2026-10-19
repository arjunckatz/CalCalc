import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import {
  AccountTurnMaterializationIntegrityError,
  AccountTurnMaterializationIneligibleError,
  AccountTurnIdempotencyConflictError,
  type AccountTurnClaim,
  type AccountTurnRoutingResolution,
  type BoundedRows,
  type ClaimAccountTurnInput,
  type MaterializeAccountTurnFoodDayResult,
  type PersistedAccountTurn,
  type PersistedFoodDay,
  type PersistedFoodEntry,
} from "@cal-calc/persistence";
import { describe, expect, it, vi } from "vitest";

import { parseIdempotencyKey } from "../mutations/mutation-identity.js";
import { acceptCalendarContext } from "./calendar-context.js";
import {
  runAccountConversationTurn,
  type AccountConversationTurnDependencies,
} from "./run-account-conversation-turn.js";

const userId = "10000000-0000-4000-8000-000000000001";
const foodDayId = "20000000-0000-4000-8000-000000000001";
const entryId = "30000000-0000-4000-8000-000000000001";
const calendar = acceptCalendarContext({
  currentLocalDateTime: "2026-10-14T08:00:00+05:30",
  timeZone: "Asia/Kolkata",
});
if (calendar === null) throw new Error("Test calendar was not accepted.");
const schema = "account-routing-resolution-v1";
const request = (
  message = "Today I had oats.",
  key = "retry-one",
  context: typeof calendar | null = calendar,
) => ({
  trustedUserId: userId,
  idempotencyKey: parseIdempotencyKey(key),
  userMessage: message,
  calendarContext: context,
});
const bounded = <T>(items: readonly T[], hasMore = false): BoundedRows<T> => ({
  items,
  hasMore,
});

function day(localDate = "2026-10-14", id = foodDayId): PersistedFoodDay {
  return {
    userId,
    foodDay: createFoodDay({
      id,
      status: "OPEN",
      calorieTarget: "2000",
      proteinTarget: "100",
    }),
    localDate,
    completeness: "UNKNOWN",
    openedAt: "2026-10-14T00:00:00Z",
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
  };
}

function entry(parent: PersistedFoodDay): PersistedFoodEntry {
  return {
    userId,
    entry: {
      ...createFoodEntry({
        id: entryId,
        foodDayId: parent.foodDay.id,
        rawUserDescription: "Roti",
        displayName: "Roti",
        quantity: { amount: "2", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "100" },
        },
        evidenceClass: "EXACT",
        status: "CONFIRMED_CONSUMED",
      }),
      revision: 3,
    },
    reportedAt: "2026-10-14T00:00:00Z",
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
  };
}

class MemoryTurns {
  turn: PersistedAccountTurn | null = null;
  raceWinner: AccountTurnRoutingResolution | null = null;
  raceCompletedResponse: string | null = null;

  claimPending = vi.fn(
    async (input: ClaimAccountTurnInput): Promise<AccountTurnClaim> => {
      if (this.turn !== null) {
        if (
          this.turn.userId !== input.userId ||
          this.turn.turnKey !== input.turnKey ||
          this.turn.requestFingerprint !== input.requestFingerprint ||
          this.turn.userMessage !== input.userMessage ||
          JSON.stringify(this.turn.calendarContext) !==
            JSON.stringify(input.calendarContext)
        )
          throw new AccountTurnIdempotencyConflictError();
        return { disposition: "EXISTING", turn: this.turn };
      }
      this.turn = {
        id: input.id,
        userId: input.userId,
        turnKey: input.turnKey,
        requestFingerprint: input.requestFingerprint,
        userMessage: input.userMessage,
        calendarContext: input.calendarContext,
        status: "PENDING",
        resolvedFoodDayId: null,
        routingResolution: null,
        executionPlan: null,
        response: null,
        createdAt: "2026-10-14T00:00:00Z",
        completedAt: null,
      };
      return { disposition: "CREATED", turn: this.turn };
    },
  );

  setRoutingResolutionOnce = vi.fn(
    async (input: {
      userId: string;
      turnKey: string;
      requestFingerprint: string;
      resolution: AccountTurnRoutingResolution;
    }): Promise<PersistedAccountTurn> => {
      if (
        this.turn === null ||
        this.turn.userId !== input.userId ||
        this.turn.turnKey !== input.turnKey ||
        this.turn.requestFingerprint !== input.requestFingerprint
      )
        throw new Error("Test repository identity mismatch.");
      if (this.raceCompletedResponse !== null) {
        this.turn = {
          ...this.turn,
          status: "COMPLETED",
          response: this.raceCompletedResponse,
          completedAt: "2026-10-14T00:00:01Z",
        };
        return this.turn;
      }
      if (this.turn.routingResolution !== null) return this.turn;
      const winner = this.raceWinner ?? input.resolution;
      this.turn = {
        ...this.turn,
        routingResolution: winner,
        resolvedFoodDayId:
          winner.kind === "EXISTING_DAY" ||
          winner.kind === "EXISTING_ENTRY_REFERENCE"
            ? winner.foodDayId
            : null,
      };
      return this.turn;
    },
  );
}

function harness(
  options: {
    today?: BoundedRows<PersistedFoodDay>;
    yesterday?: BoundedRows<PersistedFoodDay>;
    explicit?: BoundedRows<PersistedFoodDay>;
    entries?: BoundedRows<PersistedFoodEntry>;
    modelDecision?: (
      input: Parameters<
        AccountConversationTurnDependencies["model"]["decide"]
      >[0],
    ) => unknown;
    materialization?: MaterializeAccountTurnFoodDayResult;
  } = {},
) {
  const turns = new MemoryTurns();
  const findByUser = vi.fn(async () => null);
  const listRoutingCandidatesByLocalDate = vi.fn(
    async (_userId: string, localDate: string) =>
      localDate === "2026-10-14"
        ? (options.today ?? bounded([]))
        : localDate === "2026-10-13"
          ? (options.yesterday ?? bounded([]))
          : (options.explicit ?? bounded([])),
  );
  const listRecentResolvedTargets = vi.fn(async () => bounded([]));
  const listRecentRoutingReferences = vi.fn(
    async () => options.entries ?? bounded([]),
  );
  const decide = vi.fn(
    async (
      input: Parameters<
        AccountConversationTurnDependencies["model"]["decide"]
      >[0],
    ) => options.modelDecision?.(input) ?? { kind: "DAYLESS" },
  );
  const materializeFoodDay = vi.fn(
    async (input: {
      trustedUserId: string;
      turnId: string;
    }): Promise<MaterializeAccountTurnFoodDayResult> => {
      expect(input.trustedUserId).toBe(userId);
      return (
        options.materialization ?? {
          kind: "FOOD_DAY_READY",
          foodDayId,
          source: "CREATED",
        }
      );
    },
  );
  const dependencies: AccountConversationTurnDependencies = {
    turns,
    routing: {
      conversations: { findByUser },
      days: {
        findById: vi.fn(async () => null),
        findOwnedByIds: vi.fn(async () => []),
        listRoutingCandidatesByLocalDate,
      },
      turns: { listRecentResolvedTargets },
      entries: { listRecentRoutingReferences },
    },
    model: { decide },
    materializeFoodDay,
  };
  return {
    dependencies,
    turns,
    findByUser,
    listRoutingCandidatesByLocalDate,
    listRecentResolvedTargets,
    listRecentRoutingReferences,
    decide,
    materializeFoodDay,
  };
}

describe("durable account-turn routing coordinator", () => {
  it("claims a new pending turn, routes once, and persists DAYLESS without completing or planning", async () => {
    const test = harness();
    const result = await runAccountConversationTurn(
      test.dependencies,
      request("Hey."),
    );
    expect(result).toEqual({
      kind: "DAYLESS_READY",
    });
    expect(test.turns.claimPending).toHaveBeenCalledTimes(1);
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.turns.setRoutingResolutionOnce).toHaveBeenCalledTimes(1);
    expect(test.materializeFoodDay).not.toHaveBeenCalled();
    expect(test.turns.turn).toMatchObject({
      status: "PENDING",
      resolvedFoodDayId: null,
      executionPlan: null,
      response: null,
    });
    expect(Object.keys(test.dependencies.routing.conversations)).not.toContain(
      "compareAndSetActiveDay",
    );
  });

  it("exactly replays an already completed public response before any routing/model work", async () => {
    const test = harness();
    const original = request("Hey.");
    await runAccountConversationTurn(test.dependencies, original);
    test.turns.turn = {
      ...test.turns.turn!,
      status: "COMPLETED",
      response: "  exact stored public response  ",
      completedAt: "2026-10-14T00:00:01Z",
    };
    test.findByUser.mockClear();
    test.listRoutingCandidatesByLocalDate.mockClear();
    test.listRecentResolvedTargets.mockClear();
    test.listRecentRoutingReferences.mockClear();
    test.decide.mockClear();
    test.turns.setRoutingResolutionOnce.mockClear();
    test.materializeFoodDay.mockClear();
    expect(
      await runAccountConversationTurn(test.dependencies, original),
    ).toEqual({
      kind: "COMPLETED_REPLAY",
      response: "  exact stored public response  ",
    });
    expect(test.findByUser).not.toHaveBeenCalled();
    expect(test.listRoutingCandidatesByLocalDate).not.toHaveBeenCalled();
    expect(test.listRecentResolvedTargets).not.toHaveBeenCalled();
    expect(test.listRecentRoutingReferences).not.toHaveBeenCalled();
    expect(test.decide).not.toHaveBeenCalled();
    expect(test.turns.setRoutingResolutionOnce).not.toHaveBeenCalled();
    expect(test.materializeFoodDay).not.toHaveBeenCalled();
  });

  it.each([
    { schema, kind: "DATE_TARGET", localDate: "2026-10-13" },
    { schema, kind: "CLARIFY", question: "Which day did you mean?" },
  ] as const)(
    "replays persisted pending $kind without rebuilding context",
    async (resolution) => {
      const test = harness();
      const original = request("Yesterday I had pasta.");
      await runAccountConversationTurn(test.dependencies, original);
      test.turns.turn = { ...test.turns.turn!, routingResolution: resolution };
      test.findByUser.mockClear();
      test.listRoutingCandidatesByLocalDate.mockClear();
      test.decide.mockClear();
      test.turns.setRoutingResolutionOnce.mockClear();
      expect(
        await runAccountConversationTurn(test.dependencies, original),
      ).toEqual(
        resolution.kind === "DATE_TARGET"
          ? { kind: "FOOD_DAY_READY", foodDayId, source: "CREATED", resolution }
          : { kind: "CLARIFICATION_READY", question: resolution.question },
      );
      expect(test.findByUser).not.toHaveBeenCalled();
      expect(test.listRoutingCandidatesByLocalDate).not.toHaveBeenCalled();
      expect(test.decide).not.toHaveBeenCalled();
      expect(test.turns.setRoutingResolutionOnce).not.toHaveBeenCalled();
      expect(test.materializeFoodDay).toHaveBeenCalledTimes(
        resolution.kind === "DATE_TARGET" ? 1 : 0,
      );
    },
  );

  it("materializes a freshly persisted DATE_TARGET in the same invocation, after routing persistence", async () => {
    const test = harness({
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-14" }),
    });
    test.materializeFoodDay.mockImplementationOnce(async (input) => {
      expect(input).toEqual({
        trustedUserId: userId,
        turnId: test.turns.turn?.id,
      });
      expect(test.turns.turn?.routingResolution).toEqual({
        schema,
        kind: "DATE_TARGET",
        localDate: "2026-10-14",
      });
      return { kind: "FOOD_DAY_READY", foodDayId, source: "CREATED" };
    });
    expect(
      await runAccountConversationTurn(test.dependencies, request()),
    ).toEqual({
      kind: "FOOD_DAY_READY",
      foodDayId,
      source: "CREATED",
      resolution: { schema, kind: "DATE_TARGET", localDate: "2026-10-14" },
    });
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.turns.setRoutingResolutionOnce).toHaveBeenCalledTimes(1);
    expect(test.materializeFoodDay).toHaveBeenCalledTimes(1);
    expect(test.decide.mock.invocationCallOrder[0]).toBeLessThan(
      test.turns.setRoutingResolutionOnce.mock.invocationCallOrder[0]!,
    );
    expect(
      test.turns.setRoutingResolutionOnce.mock.invocationCallOrder[0],
    ).toBeLessThan(test.materializeFoodDay.mock.invocationCallOrder[0]!);
    expect(test.turns.turn).toMatchObject({
      status: "PENDING",
      resolvedFoodDayId: null,
      executionPlan: null,
      response: null,
    });
  });

  it("recovers a persisted date resolution after a failure before the materializer call", async () => {
    const test = harness({
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-14" }),
    });
    const original = request();
    const persist =
      test.turns.setRoutingResolutionOnce.getMockImplementation()!;
    test.turns.setRoutingResolutionOnce.mockImplementationOnce(
      async (input) => {
        await persist(input);
        throw new Error("process lost after resolution commit");
      },
    );
    await expect(
      runAccountConversationTurn(test.dependencies, original),
    ).rejects.toThrow("process lost after resolution commit");
    expect(test.materializeFoodDay).not.toHaveBeenCalled();
    expect(test.turns.turn?.routingResolution).toEqual({
      schema,
      kind: "DATE_TARGET",
      localDate: "2026-10-14",
    });
    expect(
      await runAccountConversationTurn(test.dependencies, original),
    ).toMatchObject({
      kind: "FOOD_DAY_READY",
      foodDayId,
    });
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.turns.setRoutingResolutionOnce).toHaveBeenCalledTimes(1);
    expect(test.materializeFoodDay).toHaveBeenCalledTimes(1);
  });

  it("returns a committed materialization replay from the dependency after a lost coordinator response", async () => {
    const test = harness({
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-14" }),
    });
    const original = request();
    let committed: MaterializeAccountTurnFoodDayResult | null = null;
    test.materializeFoodDay.mockImplementation(async () => {
      committed ??= { kind: "FOOD_DAY_READY", foodDayId, source: "CREATED" };
      return committed;
    });
    const first = await runAccountConversationTurn(test.dependencies, original);
    // The first result represents a committed M5A7A checkpoint whose response
    // the caller did not receive. The dependency owns the durable replay proof.
    const retry = await runAccountConversationTurn(test.dependencies, original);
    expect(retry).toEqual(first);
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.turns.setRoutingResolutionOnce).toHaveBeenCalledTimes(1);
    expect(test.materializeFoodDay).toHaveBeenCalledTimes(2);
  });

  it("keeps a missing-target date pending and retries materialization after targets are configured", async () => {
    const test = harness({
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-14" }),
    });
    test.materializeFoodDay
      .mockResolvedValueOnce({ kind: "TARGETS_REQUIRED" })
      .mockResolvedValueOnce({
        kind: "FOOD_DAY_READY",
        foodDayId,
        source: "CREATED",
      });
    const original = request();
    expect(
      await runAccountConversationTurn(test.dependencies, original),
    ).toEqual({
      kind: "TARGETS_REQUIRED",
      localDate: "2026-10-14",
    });
    expect(test.turns.turn).toMatchObject({
      status: "PENDING",
      routingResolution: { schema, kind: "DATE_TARGET" },
      resolvedFoodDayId: null,
      executionPlan: null,
      response: null,
    });
    expect(
      await runAccountConversationTurn(test.dependencies, original),
    ).toMatchObject({
      kind: "FOOD_DAY_READY",
      foodDayId,
      source: "CREATED",
    });
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.turns.setRoutingResolutionOnce).toHaveBeenCalledTimes(1);
    expect(test.materializeFoodDay).toHaveBeenCalledTimes(2);
  });

  it("leaves an ambiguous date pending and allows a later canonical materialization retry", async () => {
    const test = harness({
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-14" }),
    });
    test.materializeFoodDay
      .mockResolvedValueOnce({ kind: "AMBIGUOUS_EXISTING_DAYS" })
      .mockResolvedValueOnce({
        kind: "FOOD_DAY_READY",
        foodDayId,
        source: "EXISTING",
      });
    const original = request();
    expect(
      await runAccountConversationTurn(test.dependencies, original),
    ).toEqual({
      kind: "AMBIGUOUS_EXISTING_DAYS",
      localDate: "2026-10-14",
    });
    expect(test.turns.turn).toMatchObject({
      status: "PENDING",
      executionPlan: null,
      response: null,
    });
    expect(
      await runAccountConversationTurn(test.dependencies, original),
    ).toMatchObject({
      kind: "FOOD_DAY_READY",
      foodDayId,
      source: "EXISTING",
    });
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.materializeFoodDay).toHaveBeenCalledTimes(2);
  });

  it.each([
    new AccountTurnMaterializationIntegrityError(),
    new AccountTurnMaterializationIneligibleError("TURN_NOT_FOUND"),
  ])("propagates typed materialization failure %s", async (error) => {
    const test = harness({
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-14" }),
    });
    test.materializeFoodDay.mockRejectedValueOnce(error);
    await expect(
      runAccountConversationTurn(test.dependencies, request()),
    ).rejects.toBe(error);
    expect(test.turns.turn?.routingResolution).toMatchObject({
      kind: "DATE_TARGET",
    });
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.materializeFoodDay).toHaveBeenCalledTimes(1);
  });

  it("replays a concurrent completion returned by resolution persistence without materializing", async () => {
    const test = harness({
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-14" }),
    });
    test.turns.raceCompletedResponse = "  concurrent stored reply  ";
    expect(
      await runAccountConversationTurn(test.dependencies, request()),
    ).toEqual({
      kind: "COMPLETED_REPLAY",
      response: "  concurrent stored reply  ",
    });
    expect(test.materializeFoodDay).not.toHaveBeenCalled();
  });

  it.each([
    {
      resolution: { schema, kind: "EXISTING_DAY", foodDayId },
      expected: {
        kind: "FOOD_DAY_READY",
        foodDayId,
        source: "RESOLVED_EXISTING",
        resolution: { schema, kind: "EXISTING_DAY", foodDayId },
      },
    },
    {
      resolution: {
        schema,
        kind: "EXISTING_ENTRY_REFERENCE",
        foodDayId,
        entryId,
        revision: 3,
      },
      expected: {
        kind: "FOOD_DAY_READY",
        foodDayId,
        source: "RESOLVED_EXISTING",
        resolution: {
          schema,
          kind: "EXISTING_ENTRY_REFERENCE",
          foodDayId,
          entryId,
          revision: 3,
        },
      },
    },
    {
      resolution: { schema, kind: "DAYLESS" },
      expected: { kind: "DAYLESS_READY" },
    },
    {
      resolution: { schema, kind: "CLARIFY", question: "Which day?" },
      expected: { kind: "CLARIFICATION_READY", question: "Which day?" },
    },
  ] as const)(
    "returns a persisted $resolution.kind without routing or materialization",
    async ({ resolution, expected }) => {
      const test = harness();
      const original = request("Hey.");
      await runAccountConversationTurn(test.dependencies, original);
      test.turns.turn = {
        ...test.turns.turn!,
        routingResolution: resolution,
        resolvedFoodDayId:
          resolution.kind === "EXISTING_DAY" ||
          resolution.kind === "EXISTING_ENTRY_REFERENCE"
            ? foodDayId
            : null,
      };
      test.decide.mockClear();
      test.listRoutingCandidatesByLocalDate.mockClear();
      test.turns.setRoutingResolutionOnce.mockClear();
      test.materializeFoodDay.mockClear();
      expect(
        await runAccountConversationTurn(test.dependencies, original),
      ).toEqual(expected);
      expect(test.decide).not.toHaveBeenCalled();
      expect(test.listRoutingCandidatesByLocalDate).not.toHaveBeenCalled();
      expect(test.turns.setRoutingResolutionOnce).not.toHaveBeenCalled();
      expect(test.materializeFoodDay).not.toHaveBeenCalled();
      expect(test.turns.turn).toMatchObject({
        status: "PENDING",
        executionPlan: null,
        response: null,
      });
    },
  );

  it("returns the authoritative first writer when a concurrent proposal differs", async () => {
    const test = harness({ modelDecision: () => ({ kind: "DAYLESS" }) });
    test.turns.raceWinner = { schema, kind: "CLARIFY", question: "Which day?" };
    expect(
      await runAccountConversationTurn(test.dependencies, request("Hey.")),
    ).toEqual({ kind: "CLARIFICATION_READY", question: "Which day?" });
    expect(test.turns.turn?.routingResolution).toEqual(test.turns.raceWinner);
  });

  it("may rerun inference after a failure before resolution persistence", async () => {
    const test = harness();
    test.turns.setRoutingResolutionOnce.mockRejectedValueOnce(
      new Error("simulated persistence failure"),
    );
    const original = request("Hey.");
    await expect(
      runAccountConversationTurn(test.dependencies, original),
    ).rejects.toThrow("simulated persistence failure");
    expect(test.turns.turn?.routingResolution).toBeNull();
    await expect(
      runAccountConversationTurn(test.dependencies, original),
    ).resolves.toEqual({
      kind: "DAYLESS_READY",
    });
    expect(test.decide).toHaveBeenCalledTimes(2);
  });

  it("rejects same-key changed message or accepted context before routing", async () => {
    const test = harness();
    await runAccountConversationTurn(test.dependencies, request("Hey."));
    test.findByUser.mockClear();
    test.decide.mockClear();
    for (const changed of [
      request("Hi."),
      request("Hey.", "retry-one", null),
    ]) {
      await expect(
        runAccountConversationTurn(test.dependencies, changed),
      ).rejects.toBeInstanceOf(AccountTurnIdempotencyConflictError);
    }
    expect(test.findByUser).not.toHaveBeenCalled();
    expect(test.decide).not.toHaveBeenCalled();
    expect(test.materializeFoodDay).not.toHaveBeenCalled();
  });

  it("rejects a changed request against a persisted date before materialization", async () => {
    const test = harness({
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-14" }),
    });
    await runAccountConversationTurn(test.dependencies, request());
    test.materializeFoodDay.mockClear();
    test.decide.mockClear();
    for (const changed of [
      request("Today I had bread."),
      request("Today I had oats.", "retry-one", null),
    ]) {
      await expect(
        runAccountConversationTurn(test.dependencies, changed),
      ).rejects.toBeInstanceOf(AccountTurnIdempotencyConflictError);
    }
    expect(test.decide).not.toHaveBeenCalled();
    expect(test.materializeFoodDay).not.toHaveBeenCalled();
  });

  it("supports null calendar context without date queries or server-clock inference", async () => {
    const test = harness();
    await runAccountConversationTurn(
      test.dependencies,
      request("Hey.", "null", null),
    );
    expect(test.listRoutingCandidatesByLocalDate).not.toHaveBeenCalled();
    expect(test.decide.mock.calls[0]?.[0].calendarContext).toBeNull();
  });

  it.each([
    ["Today I had oats.", "2026-10-14"],
    ["Yesterday I had pasta.", "2026-10-13"],
  ])(
    "preserves an explicit relative %s DATE_TARGET with complete empty buckets",
    async (message, localDate) => {
      const test = harness({
        modelDecision: () => ({ kind: "DATE_TARGET", localDate }),
      });
      expect(
        await runAccountConversationTurn(test.dependencies, request(message)),
      ).toEqual({
        kind: "FOOD_DAY_READY",
        foodDayId,
        source: "CREATED",
        resolution: { schema, kind: "DATE_TARGET", localDate },
      });
      expect(
        test.listRoutingCandidatesByLocalDate.mock.calls.map((call) => call[1]),
      ).toEqual(["2026-10-14", "2026-10-13"]);
      expect(test.turns.turn?.resolvedFoodDayId).toBeNull();
      expect(test.materializeFoodDay).toHaveBeenCalledTimes(1);
      expect(test.materializeFoodDay).toHaveBeenCalledWith({
        trustedUserId: userId,
        turnId: test.turns.turn?.id,
      });
    },
  );

  it("queries one literal ISO date and persists a trusted existing day, not a token", async () => {
    const older = day("2026-10-10");
    const test = harness({
      explicit: bounded([older]),
      modelDecision: (input) => ({
        kind: "EXISTING_DAY",
        dayToken: input.routing.explicitDate?.dayTokens[0],
      }),
    });
    const result = await runAccountConversationTurn(
      test.dependencies,
      request("On 2026-10-10 I had pasta."),
    );
    expect(result).toEqual({
      kind: "FOOD_DAY_READY",
      foodDayId,
      source: "RESOLVED_EXISTING",
      resolution: { schema, kind: "EXISTING_DAY", foodDayId },
    });
    expect(
      test.listRoutingCandidatesByLocalDate.mock.calls.map((call) => call[1]),
    ).toEqual(["2026-10-14", "2026-10-13", "2026-10-10"]);
    expect(test.turns.turn?.resolvedFoodDayId).toBe(foodDayId);
    expect(JSON.stringify(test.turns.turn?.routingResolution)).not.toContain(
      "day_",
    );
    expect(test.materializeFoodDay).not.toHaveBeenCalled();
  });

  it("materializes the exact persisted literal ISO date without reparsing it", async () => {
    const test = harness({
      explicit: bounded([]),
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-10" }),
    });
    expect(
      await runAccountConversationTurn(
        test.dependencies,
        request("On 2026-10-10 I had pasta."),
      ),
    ).toEqual({
      kind: "FOOD_DAY_READY",
      foodDayId,
      source: "CREATED",
      resolution: { schema, kind: "DATE_TARGET", localDate: "2026-10-10" },
    });
    expect(test.turns.turn?.routingResolution).toEqual({
      schema,
      kind: "DATE_TARGET",
      localDate: "2026-10-10",
    });
    expect(test.materializeFoodDay).toHaveBeenCalledTimes(1);
    expect(test.materializeFoodDay).toHaveBeenCalledWith({
      trustedUserId: userId,
      turnId: test.turns.turn?.id,
    });
  });

  it("persists a truncated explicit-date ambiguity instead of trusting DATE_TARGET", async () => {
    const test = harness({
      explicit: bounded([], true),
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-10" }),
    });
    const result = await runAccountConversationTurn(
      test.dependencies,
      request("On 2026-10-10 I had pasta."),
    );
    expect(result).toMatchObject({
      kind: "CLARIFICATION_READY",
    });
    expect(test.turns.turn?.resolvedFoodDayId).toBeNull();
  });

  it("clarifies same-date plurality instead of selecting a FoodDay by date alone", async () => {
    const test = harness({
      explicit: bounded([
        day("2026-10-10"),
        day("2026-10-10", "20000000-0000-4000-8000-000000000002"),
      ]),
      modelDecision: () => ({ kind: "DATE_TARGET", localDate: "2026-10-10" }),
    });
    expect(
      await runAccountConversationTurn(
        test.dependencies,
        request("On 2026-10-10 I had pasta."),
      ),
    ).toMatchObject({
      kind: "CLARIFICATION_READY",
    });
    expect(test.turns.turn?.resolvedFoodDayId).toBeNull();
  });

  it("persists a canonical entry reference with its parent and snapshot revision", async () => {
    const parent = day();
    const test = harness({
      today: bounded([parent]),
      entries: bounded([entry(parent)]),
      modelDecision: (input) => ({
        kind: "EXISTING_ENTRY_REFERENCE",
        entryToken: input.routing.recentEntryReferences.items[0]?.token,
      }),
    });
    expect(
      await runAccountConversationTurn(
        test.dependencies,
        request("Actually I only ate one of those rotis."),
      ),
    ).toEqual({
      kind: "FOOD_DAY_READY",
      foodDayId,
      source: "RESOLVED_EXISTING",
      resolution: {
        schema,
        kind: "EXISTING_ENTRY_REFERENCE",
        foodDayId,
        entryId,
        revision: 3,
      },
    });
    expect(test.turns.turn?.resolvedFoodDayId).toBe(foodDayId);
    expect(test.turns.turn?.status).toBe("PENDING");
    expect(test.materializeFoodDay).not.toHaveBeenCalled();
  });

  it("clarifies multiple distinct literal ISO dates before choosing a bucket", async () => {
    const test = harness();
    const result = await runAccountConversationTurn(
      test.dependencies,
      request("On 2026-10-10 or 2026-10-11 I had pasta."),
    );
    expect(result).toEqual({
      kind: "CLARIFICATION_READY",
      question: "Which date did you mean?",
    });
    expect(test.listRoutingCandidatesByLocalDate).not.toHaveBeenCalled();
    expect(test.decide).not.toHaveBeenCalled();
  });
});
