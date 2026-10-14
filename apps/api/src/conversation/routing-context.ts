import { createHash } from "node:crypto";

import type {
  FoodDayStatus,
  FoodEntryStatus,
  Quantity,
} from "@cal-calc/domain";
import {
  MAX_RECENT_RESOLVED_TURNS,
  MAX_ROUTING_DAYS_PER_DATE,
  MAX_ROUTING_ENTRY_REFERENCES,
  type BoundedRows,
  type FoodDayCompleteness,
  type PersistedFoodDay,
  type PersistedFoodEntry,
  type PostgresAccountConversationTurnRepository,
  type PostgresConversationRepository,
  type PostgresFoodDayRepository,
  type PostgresFoodEntryRepository,
} from "@cal-calc/persistence";

import {
  acceptLocalDate,
  deriveCalendarFacts,
  previousCalendarDate,
  type AcceptedCalendarContext,
} from "./calendar-context.js";

export type RoutingDaySource =
  | "ACTIVE_POINTER"
  | "CURRENT_LOCAL_DATE"
  | "PREVIOUS_LOCAL_DATE"
  | "RECENT_COMPLETED_TURN";

export interface ModelSafeRoutingDay {
  readonly token: string;
  readonly localDate: string | null;
  readonly status: FoodDayStatus;
  readonly completeness: FoodDayCompleteness;
  readonly openedAt: string;
  readonly sources: readonly RoutingDaySource[];
}

export interface ModelSafeRoutingEntry {
  readonly token: string;
  readonly dayToken: string;
  readonly displayName: string;
  readonly quantity: Quantity;
  readonly status: FoodEntryStatus;
  readonly revision: number;
}

export interface ModelSafeRoutingContext {
  readonly calendarContext: AcceptedCalendarContext | null;
  /** Continuity hint only, never a selected mutation target. */
  readonly activeDayToken: string | null;
  /** Null means calendar context was unavailable, not that a query found zero. */
  readonly today: {
    readonly dayTokens: readonly string[];
    readonly hasMore: boolean;
  } | null;
  readonly yesterday: {
    readonly dayTokens: readonly string[];
    readonly hasMore: boolean;
  } | null;
  readonly recentDays: {
    readonly dayTokens: readonly string[];
    /** More completed resolved turns exist beyond the scanned window. */
    readonly hasMoreTurns: boolean;
  };
  readonly days: readonly ModelSafeRoutingDay[];
  readonly recentEntryReferences: {
    readonly items: readonly ModelSafeRoutingEntry[];
    readonly hasMore: boolean;
    /** False if any candidate-day source was truncated. Never proves account-wide absence. */
    readonly candidateDayScopeComplete: boolean;
  };
  readonly bounds: {
    readonly daysPerDate: number;
    readonly recentResolvedTurns: number;
    readonly entryReferences: number;
  };
}

export interface CanonicalRoutingDay {
  readonly userId: string;
  readonly foodDayId: string;
}

export interface CanonicalRoutingEntry extends CanonicalRoutingDay {
  readonly entryId: string;
  readonly revision: number;
}

export interface RoutingSnapshot {
  readonly projection: ModelSafeRoutingContext;
  /** Membership is valid only for this snapshot; mutation must recheck ownership/revision. */
  resolveDayToken(token: string): CanonicalRoutingDay;
  resolveEntryToken(token: string): CanonicalRoutingEntry;
}

export interface RoutingRepositories {
  readonly conversations: Pick<PostgresConversationRepository, "findByUser">;
  readonly days: Pick<
    PostgresFoodDayRepository,
    "findById" | "findOwnedByIds" | "listRoutingCandidatesByLocalDate"
  >;
  readonly turns: Pick<
    PostgresAccountConversationTurnRepository,
    "listRecentResolvedTargets"
  >;
  readonly entries: Pick<
    PostgresFoodEntryRepository,
    "listRecentRoutingReferences"
  >;
}

export class RoutingCandidateNotFoundError extends Error {
  override readonly name = "RoutingCandidateNotFoundError";
  constructor() {
    super("Routing candidate token is not in this snapshot.");
  }
}

export class RoutingContextIntegrityError extends Error {
  override readonly name = "RoutingContextIntegrityError";
  constructor() {
    super("Owner-scoped routing references were inconsistent.");
  }
}

/** Explicit-date primitive; the date is already recognized, never parsed from prose. */
export async function listExplicitDateRoutingCandidates(
  days: RoutingRepositories["days"],
  trustedUserId: string,
  localDate: string,
): Promise<BoundedRows<PersistedFoodDay>> {
  return days.listRoutingCandidatesByLocalDate(
    requireTrustedUserId(trustedUserId),
    acceptLocalDate(localDate),
  );
}

/** Read-only canonical assembly followed by a separate ID-free semantic projection. */
export async function buildRoutingContext(
  repositories: RoutingRepositories,
  input: {
    readonly trustedUserId: string;
    readonly calendarContext: AcceptedCalendarContext | null;
  },
): Promise<RoutingSnapshot> {
  const userId = requireTrustedUserId(input.trustedUserId);
  const calendar = input.calendarContext;
  const facts = calendar === null ? null : deriveCalendarFacts(calendar);
  const conversation = await repositories.conversations.findByUser(userId);
  const activeId = conversation?.activeFoodDayId ?? null;
  const today =
    facts === null
      ? null
      : await listExplicitDateRoutingCandidates(
          repositories.days,
          userId,
          facts.localDate,
        );
  const yesterday =
    facts === null
      ? null
      : await listExplicitDateRoutingCandidates(
          repositories.days,
          userId,
          previousCalendarDate(facts.localDate),
        );
  const recentTurns =
    await repositories.turns.listRecentResolvedTargets(userId);

  const days = new Map<
    string,
    { day: PersistedFoodDay; sources: Set<RoutingDaySource> }
  >();
  const add = (day: PersistedFoodDay, source: RoutingDaySource) => {
    if (day.userId !== userId) throw new RoutingContextIntegrityError();
    const id = day.foodDay.id;
    const existing = days.get(id);
    if (existing === undefined)
      days.set(id, { day, sources: new Set([source]) });
    else existing.sources.add(source);
  };

  for (const day of today?.items ?? []) add(day, "CURRENT_LOCAL_DATE");
  for (const day of yesterday?.items ?? []) add(day, "PREVIOUS_LOCAL_DATE");

  const recentIds = [
    ...new Set(recentTurns.items.map((turn) => turn.foodDayId)),
  ];
  const missingRecentIds = recentIds.filter((id) => !days.has(id));
  const recentDays = await repositories.days.findOwnedByIds(
    userId,
    missingRecentIds,
  );
  if (
    recentDays.length !== missingRecentIds.length ||
    new Set(recentDays.map((day) => day.foodDay.id)).size !== recentDays.length
  ) {
    throw new RoutingContextIntegrityError();
  }
  for (const day of recentDays) {
    if (!missingRecentIds.includes(day.foodDay.id))
      throw new RoutingContextIntegrityError();
    add(day, "RECENT_COMPLETED_TURN");
  }
  for (const id of recentIds) {
    const found = days.get(id);
    if (found === undefined) throw new RoutingContextIntegrityError();
    found.sources.add("RECENT_COMPLETED_TURN");
  }

  if (activeId !== null) {
    const active =
      days.get(activeId)?.day ??
      (await repositories.days.findById(userId, activeId));
    if (active === null) throw new RoutingContextIntegrityError();
    add(active, "ACTIVE_POINTER");
  }

  // Stable canonical order is deliberately independent of source priority.
  const orderedDays = [...days.values()].sort((left, right) =>
    compareDay(left.day, right.day),
  );
  const dayIds = orderedDays.map(({ day }) => day.foodDay.id);
  const entryRows = await repositories.entries.listRecentRoutingReferences(
    userId,
    dayIds,
  );
  for (const row of entryRows.items) {
    if (
      row.userId !== userId ||
      !days.has(row.entry.foodDayId) ||
      row.entry.deletedAt !== undefined
    ) {
      throw new RoutingContextIntegrityError();
    }
  }
  const orderedEntries = [...entryRows.items].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.entry.id.localeCompare(left.entry.id),
  );
  return projectCanonicalContext({
    userId,
    calendar,
    activeId,
    today,
    yesterday,
    recentTurns,
    orderedDays,
    orderedEntries,
    entryHasMore: entryRows.hasMore,
  });
}

function projectCanonicalContext(input: {
  userId: string;
  calendar: AcceptedCalendarContext | null;
  activeId: string | null;
  today: BoundedRows<PersistedFoodDay> | null;
  yesterday: BoundedRows<PersistedFoodDay> | null;
  recentTurns: Awaited<
    ReturnType<RoutingRepositories["turns"]["listRecentResolvedTargets"]>
  >;
  orderedDays: readonly {
    day: PersistedFoodDay;
    sources: Set<RoutingDaySource>;
  }[];
  orderedEntries: readonly PersistedFoodEntry[];
  entryHasMore: boolean;
}): RoutingSnapshot {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.userId,
        input.calendar,
        input.activeId,
        input.orderedDays.map(({ day, sources }) => [
          day.foodDay.id,
          day.foodDay.status,
          day.completeness,
          day.localDate ?? null,
          day.openedAt,
          [...sources].sort(),
        ]),
        input.orderedEntries.map(({ entry }) => [
          entry.id,
          entry.foodDayId,
          entry.displayName,
          entry.quantity,
          entry.status,
          entry.revision,
        ]),
        input.today?.items.map((day) => day.foodDay.id) ?? null,
        input.yesterday?.items.map((day) => day.foodDay.id) ?? null,
        input.recentTurns.items.map((turn) => [turn.turnId, turn.foodDayId]),
        input.today?.hasMore ?? null,
        input.yesterday?.hasMore ?? null,
        input.recentTurns.hasMore,
        input.entryHasMore,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  const dayByToken = new Map<string, CanonicalRoutingDay>();
  const entryByToken = new Map<string, CanonicalRoutingEntry>();
  const tokenByDayId = new Map<string, string>();
  const projectedDays = input.orderedDays.map(({ day, sources }, index) => {
    const token = `day_${digest}_${index + 1}`;
    tokenByDayId.set(day.foodDay.id, token);
    dayByToken.set(token, { userId: input.userId, foodDayId: day.foodDay.id });
    return {
      token,
      localDate: day.localDate ?? null,
      status: day.foodDay.status,
      completeness: day.completeness,
      openedAt: day.openedAt,
      sources: [...sources].sort() as RoutingDaySource[],
    };
  });
  const projectedEntries = input.orderedEntries.map((row, index) => {
    const token = `entry_${digest}_${index + 1}`;
    const dayToken = tokenByDayId.get(row.entry.foodDayId);
    if (dayToken === undefined) throw new RoutingContextIntegrityError();
    entryByToken.set(token, {
      userId: input.userId,
      foodDayId: row.entry.foodDayId,
      entryId: row.entry.id,
      revision: row.entry.revision,
    });
    return {
      token,
      dayToken,
      displayName: row.entry.displayName,
      quantity: row.entry.quantity,
      status: row.entry.status,
      revision: row.entry.revision,
    };
  });
  const tokens = (rows: readonly PersistedFoodDay[]) =>
    rows.map((row) => {
      const token = tokenByDayId.get(row.foodDay.id);
      if (token === undefined) throw new RoutingContextIntegrityError();
      return token;
    });
  const recentTokens = [
    ...new Set(
      input.recentTurns.items.map((turn) => {
        const token = tokenByDayId.get(turn.foodDayId);
        if (token === undefined) throw new RoutingContextIntegrityError();
        return token;
      }),
    ),
  ];
  const activeDayToken =
    input.activeId === null ? null : tokenByDayId.get(input.activeId);
  if (activeDayToken === undefined) throw new RoutingContextIntegrityError();
  const projection: ModelSafeRoutingContext = {
    calendarContext: input.calendar,
    activeDayToken,
    today:
      input.today === null
        ? null
        : {
            dayTokens: tokens(input.today.items),
            hasMore: input.today.hasMore,
          },
    yesterday:
      input.yesterday === null
        ? null
        : {
            dayTokens: tokens(input.yesterday.items),
            hasMore: input.yesterday.hasMore,
          },
    recentDays: {
      dayTokens: recentTokens,
      hasMoreTurns: input.recentTurns.hasMore,
    },
    days: projectedDays,
    recentEntryReferences: {
      items: projectedEntries,
      hasMore: input.entryHasMore,
      candidateDayScopeComplete:
        input.calendar !== null &&
        !input.today?.hasMore &&
        !input.yesterday?.hasMore &&
        !input.recentTurns.hasMore,
    },
    bounds: {
      daysPerDate: MAX_ROUTING_DAYS_PER_DATE,
      recentResolvedTurns: MAX_RECENT_RESOLVED_TURNS,
      entryReferences: MAX_ROUTING_ENTRY_REFERENCES,
    },
  };
  return {
    projection,
    resolveDayToken(token) {
      const day = dayByToken.get(token);
      if (day === undefined) throw new RoutingCandidateNotFoundError();
      return day;
    },
    resolveEntryToken(token) {
      const entry = entryByToken.get(token);
      if (entry === undefined) throw new RoutingCandidateNotFoundError();
      return entry;
    },
  };
}

function compareDay(left: PersistedFoodDay, right: PersistedFoodDay): number {
  return (
    (left.localDate ?? "").localeCompare(right.localDate ?? "") ||
    left.openedAt.localeCompare(right.openedAt) ||
    left.foodDay.id.localeCompare(right.foodDay.id)
  );
}

function requireTrustedUserId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new TypeError("Trusted user ID must be a UUID.");
  }
  return value.toLowerCase();
}
