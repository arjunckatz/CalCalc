import { createFoodDay, type FoodDayStatus } from "@cal-calc/domain";
import { describe, expect, it, vi } from "vitest";

import {
  FoodDayNotFoundError,
  type PostgresFoodDayRepository,
} from "./postgres/food-day-repository.js";
import { resolveFoodDayTarget } from "./resolve-food-day-target.js";
import type { PersistedFoodDay } from "./types.js";

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const firstDayId = "20000000-0000-4000-8000-000000000001";
const secondDayId = "20000000-0000-4000-8000-000000000002";

describe("resolveFoodDayTarget", () => {
  it.each(["OPEN", "PROVISIONAL", "CLOSED"] as const)(
    "resolves an explicit %s day without looking for implicit candidates",
    async (status) => {
      const foodDay = persistedDay(firstDayId, status);
      const repository = stubRepository(foodDay, [
        persistedDay(secondDayId, "OPEN"),
      ]);

      expect(
        await resolveFoodDayTarget(repository, {
          userId,
          foodDayId: firstDayId,
        }),
      ).toEqual({ disposition: "RESOLVED", reason: "EXPLICIT", foodDay });
      expect(repository.findById).toHaveBeenCalledExactlyOnceWith(
        userId,
        firstDayId,
      );
      expect(repository.findNonClosed).not.toHaveBeenCalled();
    },
  );

  it.each([userId, otherUserId])(
    "rejects an explicit missing or invisible day for user %s without fallback",
    async (attemptUserId) => {
      const repository = stubRepository(null, [
        { ...persistedDay(secondDayId, "OPEN"), userId: attemptUserId },
      ]);

      const result = resolveFoodDayTarget(repository, {
        userId: attemptUserId,
        foodDayId: firstDayId,
      });
      await expect(result).rejects.toBeInstanceOf(FoodDayNotFoundError);
      await expect(result).rejects.toMatchObject({ foodDayId: firstDayId });
      expect(repository.findById).toHaveBeenCalledExactlyOnceWith(
        attemptUserId,
        firstDayId,
      );
      expect(repository.findNonClosed).not.toHaveBeenCalled();
    },
  );

  it.each(["OPEN", "PROVISIONAL"] as const)(
    "resolves a sole %s candidate",
    async (status) => {
      const foodDay = persistedDay(firstDayId, status);
      const repository = stubRepository(null, [foodDay]);

      expect(await resolveFoodDayTarget(repository, { userId })).toEqual({
        disposition: "RESOLVED",
        reason: "SOLE_NON_CLOSED",
        foodDay,
      });
      expect(repository.findNonClosed).toHaveBeenCalledExactlyOnceWith(userId);
      expect(repository.findById).not.toHaveBeenCalled();
    },
  );

  it("returns NONE when there are no non-closed candidates", async () => {
    const repository = stubRepository();

    expect(await resolveFoodDayTarget(repository, { userId })).toEqual({
      disposition: "NONE",
    });
    expect(repository.findNonClosed).toHaveBeenCalledExactlyOnceWith(userId);
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it.each(["PROVISIONAL", "OPEN"] as const)(
    "surfaces OPEN plus %s as ambiguous without choosing the newest or preferring a status",
    async (newerStatus) => {
      const candidates = [
        persistedDay(secondDayId, newerStatus, "2026-09-05"),
        persistedDay(firstDayId, "OPEN", "2026-09-04"),
      ];
      const repository = stubRepository(null, candidates);

      expect(await resolveFoodDayTarget(repository, { userId })).toEqual({
        disposition: "AMBIGUOUS",
        candidates,
      });
      expect(repository.findNonClosed).toHaveBeenCalledExactlyOnceWith(userId);
      expect(repository.findById).not.toHaveBeenCalled();
    },
  );

  it("resolves a sole old-date candidate without using the calendar or timezone", async () => {
    const foodDay = persistedDay(firstDayId, "OPEN", "2001-01-01");
    const repository = stubRepository(null, [foodDay]);

    expect(await resolveFoodDayTarget(repository, { userId })).toEqual({
      disposition: "RESOLVED",
      reason: "SOLE_NON_CLOSED",
      foodDay,
    });
    expect(repository.findNonClosed).toHaveBeenCalledExactlyOnceWith(userId);
    expect(repository.findById).not.toHaveBeenCalled();
  });
});

function stubRepository(
  explicit: PersistedFoodDay | null = null,
  candidates: PersistedFoodDay[] = [],
) {
  return {
    findById: vi
      .fn<PostgresFoodDayRepository["findById"]>()
      .mockResolvedValue(explicit),
    findNonClosed: vi
      .fn<PostgresFoodDayRepository["findNonClosed"]>()
      .mockResolvedValue(candidates),
  };
}

function persistedDay(
  id: string,
  status: FoodDayStatus,
  localDate = "2026-09-05",
): PersistedFoodDay {
  const timestamp = `${localDate}T00:00:00.000Z`;
  return {
    foodDay: createFoodDay({
      id,
      status,
      calorieTarget: "2100.125",
      proteinTarget: "120.005",
    }),
    userId,
    completeness: "UNKNOWN",
    localDate,
    timezone: "Asia/Calcutta",
    openedAt: timestamp,
    ...(status === "CLOSED" ? { closedAt: timestamp } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
