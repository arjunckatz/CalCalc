import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import {
  AccountTurnIdempotencyConflictError,
  type AccountTurnClaim,
  type AccountTurnRoutingResolution,
  type BoundedRows,
  type ClaimAccountTurnInput,
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
  };
  return {
    dependencies,
    turns,
    findByUser,
    listRoutingCandidatesByLocalDate,
    listRecentResolvedTargets,
    listRecentRoutingReferences,
    decide,
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
      kind: "RESOLUTION_READY",
      resolution: { schema, kind: "DAYLESS" },
    });
    expect(test.turns.claimPending).toHaveBeenCalledTimes(1);
    expect(test.decide).toHaveBeenCalledTimes(1);
    expect(test.turns.setRoutingResolutionOnce).toHaveBeenCalledTimes(1);
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
      ).toEqual({
        kind: "RESOLUTION_READY",
        resolution,
      });
      expect(test.findByUser).not.toHaveBeenCalled();
      expect(test.listRoutingCandidatesByLocalDate).not.toHaveBeenCalled();
      expect(test.decide).not.toHaveBeenCalled();
      expect(test.turns.setRoutingResolutionOnce).not.toHaveBeenCalled();
    },
  );

  it("returns the authoritative first writer when a concurrent proposal differs", async () => {
    const test = harness({ modelDecision: () => ({ kind: "DAYLESS" }) });
    test.turns.raceWinner = { schema, kind: "CLARIFY", question: "Which day?" };
    expect(
      await runAccountConversationTurn(test.dependencies, request("Hey.")),
    ).toEqual({
      kind: "RESOLUTION_READY",
      resolution: test.turns.raceWinner,
    });
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
      kind: "RESOLUTION_READY",
      resolution: { schema, kind: "DAYLESS" },
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
        kind: "RESOLUTION_READY",
        resolution: { schema, kind: "DATE_TARGET", localDate },
      });
      expect(
        test.listRoutingCandidatesByLocalDate.mock.calls.map((call) => call[1]),
      ).toEqual(["2026-10-14", "2026-10-13"]);
      expect(test.turns.turn?.resolvedFoodDayId).toBeNull();
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
      kind: "RESOLUTION_READY",
      resolution: { schema, kind: "EXISTING_DAY", foodDayId },
    });
    expect(
      test.listRoutingCandidatesByLocalDate.mock.calls.map((call) => call[1]),
    ).toEqual(["2026-10-14", "2026-10-13", "2026-10-10"]);
    expect(test.turns.turn?.resolvedFoodDayId).toBe(foodDayId);
    expect(JSON.stringify(test.turns.turn?.routingResolution)).not.toContain(
      "day_",
    );
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
      kind: "RESOLUTION_READY",
      resolution: { schema, kind: "CLARIFY" },
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
      kind: "RESOLUTION_READY",
      resolution: { schema, kind: "CLARIFY" },
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
      kind: "RESOLUTION_READY",
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
  });

  it("clarifies multiple distinct literal ISO dates before choosing a bucket", async () => {
    const test = harness();
    const result = await runAccountConversationTurn(
      test.dependencies,
      request("On 2026-10-10 or 2026-10-11 I had pasta."),
    );
    expect(result).toEqual({
      kind: "RESOLUTION_READY",
      resolution: {
        schema,
        kind: "CLARIFY",
        question: "Which date did you mean?",
      },
    });
    expect(test.listRoutingCandidatesByLocalDate).not.toHaveBeenCalled();
    expect(test.decide).not.toHaveBeenCalled();
  });
});
