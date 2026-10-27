import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import type {
  BoundedRows,
  PersistedFoodDay,
  PersistedFoodEntry,
  ResolvedTurnReference,
} from "@cal-calc/persistence";
import { describe, expect, it, vi } from "vitest";

import { acceptCalendarContext } from "./calendar-context.js";
import {
  buildRoutingContext,
  listExplicitDateRoutingCandidates,
  RoutingCandidateNotFoundError,
  RoutingContextIntegrityError,
  type RoutingRepositories,
} from "./routing-context.js";

const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const id = (number: number) =>
  `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const calendar = acceptCalendarContext({
  currentLocalDateTime: "2026-01-01T00:05:00+00:00",
  timeZone: "UTC",
});
if (calendar === null) throw new Error("Test calendar was not accepted.");

function day(
  number: number,
  localDate: string | null,
  options: {
    userId?: string;
    status?: "OPEN" | "CLOSED";
    completeness?: "UNKNOWN" | "USER_DECLARED_COMPLETE";
  } = {},
): PersistedFoodDay {
  return {
    userId: options.userId ?? userId,
    foodDay: createFoodDay({
      id: id(number),
      status: options.status ?? "OPEN",
      calorieTarget: "2000",
      proteinTarget: "100",
    }),
    completeness: options.completeness ?? "UNKNOWN",
    ...(localDate === null ? {} : { localDate }),
    openedAt: `2026-01-01T00:00:${String(number % 60).padStart(2, "0")}.000Z`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function entry(
  number: number,
  parent: PersistedFoodDay,
  options: {
    userId?: string;
    revision?: number;
    status?: "PLANNED" | "DISCARDED";
  } = {},
): PersistedFoodEntry {
  return {
    userId: options.userId ?? userId,
    entry: {
      ...createFoodEntry({
        id: id(number + 100),
        foodDayId: parent.foodDay.id,
        rawUserDescription: `food ${number}`,
        displayName: `Food ${number}`,
        quantity: { amount: "2", unit: "GRAM" },
        nutritionBasis: {
          amount: "1",
          unit: "GRAM",
          nutrition: { calories: "10" },
        },
        evidenceClass: "EXACT",
        status: options.status ?? "PLANNED",
      }),
      revision: options.revision ?? 1,
    },
    reportedAt: "2026-01-01T00:00:00.000Z",
    createdAt: `2026-01-01T00:00:${String(number % 60).padStart(2, "0")}.000Z`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function bounded<Row>(
  items: readonly Row[],
  hasMore = false,
): BoundedRows<Row> {
  return { items, hasMore };
}

function fixtures(
  options: {
    active?: PersistedFoodDay;
    today?: BoundedRows<PersistedFoodDay>;
    yesterday?: BoundedRows<PersistedFoodDay>;
    explicit?: BoundedRows<PersistedFoodDay>;
    recent?: BoundedRows<ResolvedTurnReference>;
    otherDays?: readonly PersistedFoodDay[];
    entries?: BoundedRows<PersistedFoodEntry>;
  } = {},
) {
  const allDays = [
    ...(options.active === undefined ? [] : [options.active]),
    ...(options.today?.items ?? []),
    ...(options.yesterday?.items ?? []),
    ...(options.explicit?.items ?? []),
    ...(options.otherDays ?? []),
  ];
  const find = (foodDayId: string) =>
    allDays.find((item) => item.foodDay.id === foodDayId) ?? null;
  const findByUser = vi.fn(async () =>
    options.active === undefined
      ? null
      : {
          userId,
          activeFoodDayId: options.active.foodDay.id,
          activeFoodDayTurnId: null,
          version: 1,
          createdAt: "",
          updatedAt: "",
        },
  );
  const listRoutingCandidatesByLocalDate = vi.fn(
    async (_userId: string, localDate: string) =>
      localDate === "2026-01-01"
        ? (options.today ?? bounded([]))
        : localDate === "2025-12-31"
          ? (options.yesterday ?? bounded([]))
          : (options.explicit ?? bounded([])),
  );
  const findById = vi.fn(async (_userId: string, foodDayId: string) =>
    find(foodDayId),
  );
  const findOwnedByIds = vi.fn(
    async (_userId: string, foodDayIds: readonly string[]) =>
      foodDayIds
        .map(find)
        .filter((item): item is PersistedFoodDay => item !== null),
  );
  const listRecentResolvedTargets = vi.fn(
    async () => options.recent ?? bounded([]),
  );
  const listRecentRoutingReferences = vi.fn(
    async () => options.entries ?? bounded([]),
  );
  const repositories: RoutingRepositories = {
    conversations: { findByUser },
    days: { findById, findOwnedByIds, listRoutingCandidatesByLocalDate },
    turns: { listRecentResolvedTargets },
    entries: { listRecentRoutingReferences },
  };
  return {
    repositories,
    findByUser,
    findById,
    findOwnedByIds,
    listRoutingCandidatesByLocalDate,
    listRecentResolvedTargets,
    listRecentRoutingReferences,
  };
}

const recentRef = (
  number: number,
  parent: PersistedFoodDay,
): ResolvedTurnReference => ({
  turnId: id(number + 300),
  foodDayId: parent.foodDay.id,
  createdAt: `2026-01-01T01:00:${String(number % 60).padStart(2, "0")}.000Z`,
});

describe("canonical account routing context", () => {
  it("represents absent calendar and pointer without date queries, creation, or writes", async () => {
    const data = fixtures();
    const snapshot = await buildRoutingContext(data.repositories, {
      trustedUserId: userId,
      calendarContext: null,
    });
    expect(snapshot.projection).toMatchObject({
      calendarContext: null,
      activeDayToken: null,
      today: null,
      yesterday: null,
      explicitDate: null,
      days: [],
      recentEntryReferences: {
        items: [],
        hasMore: false,
        candidateDayScopeComplete: false,
      },
    });
    expect(data.listRoutingCandidatesByLocalDate).not.toHaveBeenCalled();
    expect(data.listRecentRoutingReferences).toHaveBeenCalledWith(userId, []);
    expect(data.findById).not.toHaveBeenCalled();
    expect(Object.keys(data.repositories.days)).not.toContain("create");
    expect(Object.keys(data.repositories.conversations)).not.toContain(
      "compareAndSetActiveDay",
    );
  });

  it("retains a stale active pointer and recent canonical references without calendar context", async () => {
    const active = day(5, "2025-12-20", { status: "CLOSED" });
    const referenced = day(6, "2025-12-19");
    const data = fixtures({
      active,
      otherDays: [referenced],
      recent: bounded([recentRef(1, referenced)]),
      entries: bounded([entry(1, referenced)]),
    });
    const snapshot = await buildRoutingContext(data.repositories, {
      trustedUserId: userId,
      calendarContext: null,
    });
    expect(data.listRoutingCandidatesByLocalDate).not.toHaveBeenCalled();
    expect(snapshot.projection.today).toBeNull();
    expect(snapshot.projection.yesterday).toBeNull();
    expect(snapshot.projection.days).toHaveLength(2);
    expect(
      snapshot.resolveDayToken(snapshot.projection.activeDayToken!),
    ).toMatchObject({
      foodDayId: active.foodDay.id,
    });
    expect(snapshot.projection.recentDays.dayTokens).toHaveLength(1);
    expect(snapshot.projection.recentEntryReferences.items).toHaveLength(1);
    expect(
      snapshot.projection.recentEntryReferences.candidateDayScopeComplete,
    ).toBe(false);
  });

  it("queries both civil dates, keeps same-date multiplicity, and deduplicates overlapping sources", async () => {
    const first = day(1, "2026-01-01");
    const second = day(2, "2026-01-01", {
      status: "CLOSED",
      completeness: "USER_DECLARED_COMPLETE",
    });
    const prior = day(3, "2025-12-31");
    const data = fixtures({
      active: first,
      today: bounded([first, second]),
      yesterday: bounded([prior]),
      recent: bounded([
        recentRef(2, second),
        recentRef(1, first),
        recentRef(3, second),
      ]),
    });
    const snapshot = await buildRoutingContext(data.repositories, {
      trustedUserId: userId,
      calendarContext: calendar,
    });
    const model = snapshot.projection;
    expect(
      data.listRoutingCandidatesByLocalDate.mock.calls.map((call) => call[1]),
    ).toEqual(["2026-01-01", "2025-12-31"]);
    expect(model.today?.dayTokens).toHaveLength(2);
    expect(model.yesterday?.dayTokens).toHaveLength(1);
    expect(model.days).toHaveLength(3);
    expect(model.recentDays.dayTokens).toHaveLength(2);
    expect(
      model.days.find((item) => item.token === model.activeDayToken)?.sources,
    ).toEqual([
      "ACTIVE_POINTER",
      "CURRENT_LOCAL_DATE",
      "RECENT_COMPLETED_TURN",
    ]);
    expect(model.days.find((item) => item.status === "CLOSED")).toMatchObject({
      completeness: "USER_DECLARED_COMPLETE",
      sources: ["CURRENT_LOCAL_DATE", "RECENT_COMPLETED_TURN"],
    });
    expect(snapshot.resolveDayToken(model.today!.dayTokens[0]!)).toEqual({
      userId,
      foodDayId: first.foodDay.id,
    });
    expect(JSON.stringify(model)).not.toContain(first.foodDay.id);
    expect(JSON.stringify(model)).not.toContain(second.foodDay.id);
    expect(() => snapshot.resolveDayToken(first.foodDay.id)).toThrow(
      RoutingCandidateNotFoundError,
    );
    expect(() => snapshot.resolveDayToken("day_forged_1")).toThrow(
      RoutingCandidateNotFoundError,
    );
    const again = await buildRoutingContext(data.repositories, {
      trustedUserId: userId,
      calendarContext: calendar,
    });
    expect(again.projection).toEqual(model);
  });

  it("keeps today/yesterday zero distinct from unavailable and exposes date overflow", async () => {
    const only = day(4, "2025-12-31");
    const data = fixtures({
      today: bounded([], true),
      yesterday: bounded([only], true),
    });
    const model = (
      await buildRoutingContext(data.repositories, {
        trustedUserId: userId,
        calendarContext: calendar,
      })
    ).projection;
    expect(model.today).toEqual({ dayTokens: [], hasMore: true });
    expect(model.yesterday?.dayTokens).toHaveLength(1);
    expect(model.yesterday?.hasMore).toBe(true);
    expect(model.recentEntryReferences.candidateDayScopeComplete).toBe(false);
    expect("selectedDayToken" in model).toBe(false);
  });

  it("validates explicit local dates before the owner-scoped query", async () => {
    const first = day(1, "2026-01-01");
    const second = day(2, "2026-01-01");
    const data = fixtures({ today: bounded([first, second], true) });
    expect(
      await listExplicitDateRoutingCandidates(
        data.repositories.days,
        userId,
        "2026-01-01",
      ),
    ).toEqual(bounded([first, second], true));
    expect(data.listRoutingCandidatesByLocalDate).toHaveBeenCalledWith(
      userId,
      "2026-01-01",
    );
    await expect(
      listExplicitDateRoutingCandidates(
        data.repositories.days,
        userId,
        "2026-02-30",
      ),
    ).rejects.toThrow();
    expect(data.listRoutingCandidatesByLocalDate).toHaveBeenCalledTimes(1);
  });

  it("includes a bounded explicit ISO-date bucket before semantic resolution", async () => {
    const first = day(7, "2025-12-30");
    const second = day(8, "2025-12-30");
    const data = fixtures({ explicit: bounded([first, second], true) });
    const snapshot = await buildRoutingContext(data.repositories, {
      trustedUserId: userId,
      calendarContext: calendar,
      explicitLocalDate: "2025-12-30",
    });
    expect(
      data.listRoutingCandidatesByLocalDate.mock.calls.map((call) => call[1]),
    ).toEqual(["2026-01-01", "2025-12-31", "2025-12-30"]);
    expect(snapshot.projection.explicitDate).toMatchObject({
      localDate: "2025-12-30",
      hasMore: true,
      dayTokens: expect.any(Array),
    });
    expect(snapshot.projection.explicitDate?.dayTokens).toHaveLength(2);
    expect(snapshot.projection.days).toHaveLength(2);
    expect(snapshot.projection.days[0]?.sources).toContain(
      "EXPLICIT_LOCAL_DATE",
    );
    expect(JSON.stringify(snapshot.projection)).not.toContain(first.foodDay.id);
    expect(
      snapshot.projection.recentEntryReferences.candidateDayScopeComplete,
    ).toBe(false);
    const priorCount = data.listRoutingCandidatesByLocalDate.mock.calls.length;
    await expect(
      buildRoutingContext(data.repositories, {
        trustedUserId: userId,
        calendarContext: calendar,
        explicitLocalDate: "2026-02-30",
      }),
    ).rejects.toThrow();
    expect(data.listRoutingCandidatesByLocalDate).toHaveBeenCalledTimes(
      priorCount,
    );
  });

  it("links bounded canonical entry references to day tokens, preserving revision and status", async () => {
    const first = day(1, "2026-01-01");
    const older = entry(1, first, { revision: 3 });
    const newer = entry(2, first, { revision: 4, status: "DISCARDED" });
    const data = fixtures({
      today: bounded([first]),
      entries: bounded([older, newer], true),
    });
    const snapshot = await buildRoutingContext(data.repositories, {
      trustedUserId: userId,
      calendarContext: calendar,
    });
    const model = snapshot.projection;
    expect(data.listRecentRoutingReferences).toHaveBeenCalledWith(userId, [
      first.foodDay.id,
    ]);
    expect(model.recentEntryReferences).toMatchObject({
      hasMore: true,
      candidateDayScopeComplete: true,
      items: [
        { displayName: "Food 2", revision: 4, status: "DISCARDED" },
        { displayName: "Food 1", revision: 3, status: "PLANNED" },
      ],
    });
    const token = model.recentEntryReferences.items[0]!.token;
    expect(model.recentEntryReferences.items[0]?.dayToken).toBe(
      model.today?.dayTokens[0],
    );
    expect(snapshot.resolveEntryToken(token)).toEqual({
      userId,
      foodDayId: first.foodDay.id,
      entryId: newer.entry.id,
      revision: 4,
    });
    expect(JSON.stringify(model)).not.toContain(newer.entry.id);
    expect(() => snapshot.resolveEntryToken(newer.entry.id)).toThrow(
      RoutingCandidateNotFoundError,
    );
    const changed = fixtures({
      today: bounded([first]),
      entries: bounded([entry(3, first)]),
    });
    const otherSnapshot = await buildRoutingContext(changed.repositories, {
      trustedUserId: userId,
      calendarContext: calendar,
    });
    expect(() => otherSnapshot.resolveEntryToken(token)).toThrow(
      RoutingCandidateNotFoundError,
    );
  });

  it("rejects owner-inconsistent referenced days and entries rather than projecting them", async () => {
    const foreign = day(5, "2026-01-01", { userId: otherUserId });
    const badDay = fixtures({ today: bounded([foreign]) });
    await expect(
      buildRoutingContext(badDay.repositories, {
        trustedUserId: userId,
        calendarContext: calendar,
      }),
    ).rejects.toBeInstanceOf(RoutingContextIntegrityError);
    const owned = day(6, "2026-01-01");
    const badEntry = fixtures({
      today: bounded([owned]),
      entries: bounded([entry(1, owned, { userId: otherUserId })]),
    });
    await expect(
      buildRoutingContext(badEntry.repositories, {
        trustedUserId: userId,
        calendarContext: calendar,
      }),
    ).rejects.toBeInstanceOf(RoutingContextIntegrityError);
  });
});
