import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import {
  type AccountTurnExecutionCheckpoint,
  type PersistedFoodEntry,
} from "@cal-calc/persistence";
import { describe, expect, it, vi } from "vitest";

import { buildFoodDayState } from "../state/build-food-day-state.js";
import {
  AccountTurnExecutionTargetIneligibleError,
  AccountTurnExecutionTargetIntegrityError,
  prepareAccountTurnFoodDayExecution,
} from "./prepare-account-turn-food-day-execution.js";
import type { AccountConversationTurnResult } from "./run-account-conversation-turn.js";

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const turnId = "20000000-0000-4000-8000-000000000001";
const foodDayId = "30000000-0000-4000-8000-000000000001";
const otherDayId = "30000000-0000-4000-8000-000000000002";
const entryId = "40000000-0000-4000-8000-000000000001";
const schema = "account-routing-resolution-v1";

const dateResolution = {
  schema,
  kind: "DATE_TARGET",
  localDate: "2026-10-18",
} as const;
const existingResolution = { schema, kind: "EXISTING_DAY", foodDayId } as const;
const entryResolution = {
  schema,
  kind: "EXISTING_ENTRY_REFERENCE",
  foodDayId,
  entryId,
  revision: 3,
} as const;
type Ready = Extract<AccountConversationTurnResult, { kind: "FOOD_DAY_READY" }>;

function ready(resolution: Ready["resolution"] = dateResolution): Ready {
  if (resolution.kind === "DATE_TARGET")
    return {
      kind: "FOOD_DAY_READY",
      turnId,
      foodDayId,
      source: "CREATED",
      resolution,
    };
  return {
    kind: "FOOD_DAY_READY",
    turnId,
    foodDayId,
    source: "RESOLVED_EXISTING",
    resolution,
  };
}

function harness(resolution: Ready["resolution"] = dateResolution) {
  let checkpoint: AccountTurnExecutionCheckpoint = {
    turnId,
    userId,
    status: "PENDING",
    routingResolution: resolution,
    resolvedFoodDayId: resolution.kind === "DATE_TARGET" ? null : foodDayId,
    materializedFoodDayId: resolution.kind === "DATE_TARGET" ? foodDayId : null,
  };
  let foodDay = createFoodDay({
    id: foodDayId,
    status: "OPEN",
    calorieTarget: "685.1075",
    proteinTarget: "41.0025",
  });
  let completeness = "UNKNOWN" as "UNKNOWN" | "USER_DECLARED_COMPLETE";
  let entries = [
    {
      ...createFoodEntry({
        id: entryId,
        foodDayId,
        rawUserDescription: "Lunch",
        displayName: "Lunch",
        quantity: { amount: "1", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "249.13", protein: "14.91" },
        },
        evidenceClass: "EXACT",
        status: "CONFIRMED_CONSUMED",
      }),
      revision: 3,
    },
  ];
  let persistedEntry: PersistedFoodEntry | null = {
    userId,
    entry: entries[0]!,
    reportedAt: "2026-10-18T00:00:00.000Z",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
  const dependencies = {
    turns: {
      findExecutionCheckpoint: vi.fn(async () => checkpoint),
    },
    foodDays: {
      findById: vi.fn(async () => ({
        userId,
        foodDay,
        localDate: "2026-10-18",
        completeness,
        openedAt: "2026-10-18T00:00:00.000Z",
        createdAt: "2026-10-18T00:00:00.000Z",
        updatedAt: "2026-10-18T00:00:00.000Z",
      })),
    },
    foodEntries: {
      listActiveByFoodDay: vi.fn(async () =>
        entries.filter((entry) => entry.deletedAt === undefined),
      ),
      findById: vi.fn(async () => persistedEntry),
    },
  };
  return {
    dependencies,
    setCheckpoint: (value: AccountTurnExecutionCheckpoint) => {
      checkpoint = value;
    },
    checkpoint: () => checkpoint,
    setDay: (value: typeof foodDay) => {
      foodDay = value;
    },
    setCompleteness: (value: typeof completeness) => {
      completeness = value;
    },
    setEntries: (value: typeof entries) => {
      entries = value;
    },
    setPersistedEntry: (value: PersistedFoodEntry | null) => {
      persistedEntry = value;
    },
    persistedEntry: () => persistedEntry,
    entries: () => entries,
    day: () => foodDay,
    completeness: () => completeness,
  };
}

describe("prepareAccountTurnFoodDayExecution", () => {
  it("validates an EXISTING_DAY and reuses the deterministic canonical STATE builder", async () => {
    const test = harness(existingResolution);
    const result = await prepareAccountTurnFoodDayExecution(test.dependencies, {
      trustedUserId: userId,
      ready: ready(existingResolution),
    });
    expect(result).toEqual({
      kind: "EXECUTION_CONTEXT_READY",
      turnId,
      foodDayId,
      routingKind: "EXISTING_DAY",
      state: buildFoodDayState({
        foodDay: test.day(),
        entries: test.entries(),
        completeness: test.completeness(),
        localDate: "2026-10-18",
      }),
    });
    if (result.kind !== "EXECUTION_CONTEXT_READY")
      throw new Error("Test preparation unexpectedly returned stale.");
    expect(result.state.totals.confirmed).toEqual({
      calories: "249.13",
      protein: "14.91",
      hasUnknownProtein: false,
    });
    expect(result.state.targetProgress).toEqual({
      calories: { remainingToTarget: "435.9775", overTargetBy: "0" },
      protein: { remainingToTarget: "26.0925", overTargetBy: "0" },
    });
    expect(
      test.dependencies.turns.findExecutionCheckpoint,
    ).toHaveBeenCalledWith(userId, turnId);
    expect(test.dependencies.foodDays.findById).toHaveBeenCalledWith(
      userId,
      foodDayId,
    );
    expect(
      test.dependencies.foodEntries.listActiveByFoodDay,
    ).toHaveBeenCalledWith(userId, foodDayId);
    expect(test.dependencies.foodEntries.findById).not.toHaveBeenCalled();
  });

  it("uses the exact materialized DATE_TARGET link and does not search by date", async () => {
    const test = harness();
    const result = await prepareAccountTurnFoodDayExecution(test.dependencies, {
      trustedUserId: userId,
      ready: ready(),
    });
    expect(result).toMatchObject({
      kind: "EXECUTION_CONTEXT_READY",
      turnId,
      foodDayId,
      routingKind: "DATE_TARGET",
    });
    expect(
      test.dependencies.turns.findExecutionCheckpoint,
    ).toHaveBeenCalledTimes(1);
    expect(test.dependencies.foodDays.findById).toHaveBeenCalledTimes(1);
    expect(
      test.dependencies.foodEntries.listActiveByFoodDay,
    ).toHaveBeenCalledTimes(1);
    expect(Object.keys(test.dependencies.foodDays)).toEqual(["findById"]);
  });

  it("retains a valid entry reference with its exact snapshot revision", async () => {
    const test = harness(entryResolution);
    expect(
      await prepareAccountTurnFoodDayExecution(test.dependencies, {
        trustedUserId: userId,
        ready: ready(entryResolution),
      }),
    ).toMatchObject({
      kind: "EXECUTION_CONTEXT_READY",
      turnId,
      foodDayId,
      routingKind: "EXISTING_ENTRY_REFERENCE",
      entryReference: { entryId, expectedRevision: 3 },
      state: { entries: [{ id: entryId, revision: 3 }] },
    });
    expect(test.dependencies.foodEntries.findById).toHaveBeenCalledWith(
      userId,
      entryId,
    );
  });

  it("returns stale when a referenced entry revision changed, without substituting it", async () => {
    const test = harness(entryResolution);
    test.setPersistedEntry({
      ...test.persistedEntry()!,
      entry: { ...test.persistedEntry()!.entry, revision: 4 },
    });
    expect(
      await prepareAccountTurnFoodDayExecution(test.dependencies, {
        trustedUserId: userId,
        ready: ready(entryResolution),
      }),
    ).toEqual({
      kind: "ENTRY_REFERENCE_STALE",
      turnId,
      foodDayId,
      entryId,
      expectedRevision: 3,
    });
  });

  it("returns stale when fresh STATE changed after an earlier entry read", async () => {
    const test = harness(entryResolution);
    test.setEntries([{ ...test.entries()[0]!, revision: 4 }]);
    expect(
      await prepareAccountTurnFoodDayExecution(test.dependencies, {
        trustedUserId: userId,
        ready: ready(entryResolution),
      }),
    ).toEqual({
      kind: "ENTRY_REFERENCE_STALE",
      turnId,
      foodDayId,
      entryId,
      expectedRevision: 3,
    });
  });

  it.each(["deleted", "missing"] as const)(
    "returns stale when the referenced entry is %s",
    async (condition) => {
      const test = harness(entryResolution);
      if (condition === "deleted") {
        test.setPersistedEntry({
          ...test.persistedEntry()!,
          entry: {
            ...test.persistedEntry()!.entry,
            revision: 4,
            deletedAt: "2026-10-18T09:00:00.000Z",
          },
        });
        test.setEntries([]);
      } else {
        test.setPersistedEntry(null);
        test.setEntries([]);
      }
      expect(
        await prepareAccountTurnFoodDayExecution(test.dependencies, {
          trustedUserId: userId,
          ready: ready(entryResolution),
        }),
      ).toMatchObject({ kind: "ENTRY_REFERENCE_STALE", expectedRevision: 3 });
    },
  );

  it("rejects an impossible referenced-entry parent or owner mismatch", async () => {
    const test = harness(entryResolution);
    const original = test.persistedEntry()!;
    for (const entry of [
      { ...original.entry, foodDayId: otherDayId },
      { ...original.entry },
    ]) {
      test.setPersistedEntry({
        ...original,
        userId: entry.foodDayId === otherDayId ? userId : otherUserId,
        entry,
      });
      await expect(
        prepareAccountTurnFoodDayExecution(test.dependencies, {
          trustedUserId: userId,
          ready: ready(entryResolution),
        }),
      ).rejects.toBeInstanceOf(AccountTurnExecutionTargetIntegrityError);
    }
  });

  it("rejects a mismatched durable DATE_TARGET link before loading STATE", async () => {
    const test = harness();
    test.setCheckpoint({
      ...test.checkpoint(),
      materializedFoodDayId: otherDayId,
    });
    await expect(
      prepareAccountTurnFoodDayExecution(test.dependencies, {
        trustedUserId: userId,
        ready: ready(),
      }),
    ).rejects.toBeInstanceOf(AccountTurnExecutionTargetIntegrityError);
    expect(test.dependencies.foodDays.findById).not.toHaveBeenCalled();
  });

  it("rejects a completed turn before STATE or entry reads", async () => {
    const test = harness();
    test.setCheckpoint({ ...test.checkpoint(), status: "COMPLETED" });
    await expect(
      prepareAccountTurnFoodDayExecution(test.dependencies, {
        trustedUserId: userId,
        ready: ready(),
      }),
    ).rejects.toBeInstanceOf(AccountTurnExecutionTargetIneligibleError);
    expect(test.dependencies.foodDays.findById).not.toHaveBeenCalled();
    expect(test.dependencies.foodEntries.findById).not.toHaveBeenCalled();
  });

  it("loads a CLOSED and user-declared-complete FoodDay without judging future mutation legality", async () => {
    const test = harness();
    test.setDay({ ...test.day(), status: "CLOSED" });
    test.setCompleteness("USER_DECLARED_COMPLETE");
    expect(
      await prepareAccountTurnFoodDayExecution(test.dependencies, {
        trustedUserId: userId,
        ready: {
          kind: "FOOD_DAY_READY",
          turnId,
          foodDayId,
          source: "EXISTING",
          resolution: dateResolution,
        },
      }),
    ).toMatchObject({
      kind: "EXECUTION_CONTEXT_READY",
      state: {
        foodDay: { status: "CLOSED", completeness: "USER_DECLARED_COMPLETE" },
      },
    });
  });

  it("reads new canonical entry values rather than a routing-time snapshot", async () => {
    const test = harness(existingResolution);
    test.setEntries([
      {
        ...test.entries()[0]!,
        revision: 4,
        workingNutrition: { calories: "300", protein: "20" },
      },
    ]);
    const result = await prepareAccountTurnFoodDayExecution(test.dependencies, {
      trustedUserId: userId,
      ready: ready(existingResolution),
    });
    expect(result).toMatchObject({
      kind: "EXECUTION_CONTEXT_READY",
      state: {
        entries: [
          { id: entryId, revision: 4, workingNutrition: { calories: "300" } },
        ],
        totals: { confirmed: { calories: "300", protein: "20" } },
      },
    });
  });

  it("rejects a missing or cross-owner execution target instead of choosing another day", async () => {
    const test = harness();
    test.dependencies.foodDays.findById.mockResolvedValueOnce(null as never);
    await expect(
      prepareAccountTurnFoodDayExecution(test.dependencies, {
        trustedUserId: userId,
        ready: ready(),
      }),
    ).rejects.toBeInstanceOf(AccountTurnExecutionTargetIntegrityError);
    expect(
      test.dependencies.foodEntries.listActiveByFoodDay,
    ).not.toHaveBeenCalled();
  });

  it("rejects a checkpoint for another owner or a different trusted resolution", async () => {
    const test = harness();
    for (const checkpoint of [
      { ...test.checkpoint(), userId: otherUserId },
      {
        ...test.checkpoint(),
        routingResolution: { ...dateResolution, localDate: "2026-10-17" },
      },
    ]) {
      test.setCheckpoint(checkpoint);
      await expect(
        prepareAccountTurnFoodDayExecution(test.dependencies, {
          trustedUserId: userId,
          ready: ready(),
        }),
      ).rejects.toBeInstanceOf(AccountTurnExecutionTargetIntegrityError);
    }
    expect(test.dependencies.foodDays.findById).not.toHaveBeenCalled();
  });

  it("maps malformed durable checkpoint hydration to integrity while preserving unrelated DB failures", async () => {
    const test = harness();
    test.dependencies.turns.findExecutionCheckpoint.mockRejectedValueOnce(
      new TypeError("invalid checkpoint row"),
    );
    await expect(
      prepareAccountTurnFoodDayExecution(test.dependencies, {
        trustedUserId: userId,
        ready: ready(),
      }),
    ).rejects.toBeInstanceOf(AccountTurnExecutionTargetIntegrityError);
    const databaseError = new Error("database unavailable");
    test.dependencies.turns.findExecutionCheckpoint.mockRejectedValueOnce(
      databaseError,
    );
    await expect(
      prepareAccountTurnFoodDayExecution(test.dependencies, {
        trustedUserId: userId,
        ready: ready(),
      }),
    ).rejects.toBe(databaseError);
    expect(test.dependencies.foodDays.findById).not.toHaveBeenCalled();
  });

  it("rejects a non-food outcome at runtime before any read", async () => {
    const test = harness();
    await expect(
      prepareAccountTurnFoodDayExecution(test.dependencies, {
        trustedUserId: userId,
        ready: { kind: "DAYLESS_READY" } as never,
      }),
    ).rejects.toBeInstanceOf(AccountTurnExecutionTargetIneligibleError);
    expect(
      test.dependencies.turns.findExecutionCheckpoint,
    ).not.toHaveBeenCalled();
  });
});
