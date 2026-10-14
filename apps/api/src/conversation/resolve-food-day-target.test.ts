import { describe, expect, it, vi } from "vitest";

import { acceptCalendarContext } from "./calendar-context.js";
import {
  FoodDayTargetResolutionError,
  resolveFoodDayTarget,
  validateFoodDayTargetDecision,
} from "./resolve-food-day-target.js";
import {
  RoutingCandidateNotFoundError,
  type RoutingSnapshot,
} from "./routing-context.js";

const userId = "10000000-0000-4000-8000-000000000001";
const dayId = "20000000-0000-4000-8000-000000000001";
const entryId = "30000000-0000-4000-8000-000000000001";
const calendar = acceptCalendarContext({
  currentLocalDateTime: "2026-10-14T00:30:00+05:30",
  timeZone: "Asia/Kolkata",
});
if (calendar === null) throw new Error("Test calendar missing.");

function snapshot(suffix = "a", hasMore = false): RoutingSnapshot {
  const dayToken = `day_${suffix}_1`;
  const entryToken = `entry_${suffix}_1`;
  return {
    projection: {
      calendarContext: calendar,
      activeDayToken: dayToken,
      today: { dayTokens: [dayToken], hasMore },
      yesterday: { dayTokens: [], hasMore: false },
      explicitDate: null,
      recentDays: { dayTokens: [dayToken], hasMoreTurns: hasMore },
      days: [
        {
          token: dayToken,
          localDate: "2026-10-14",
          status: "OPEN",
          completeness: "UNKNOWN",
          openedAt: "2026-10-13T19:00:00Z",
          sources: ["ACTIVE_POINTER", "CURRENT_LOCAL_DATE"],
        },
      ],
      recentEntryReferences: {
        items: [
          {
            token: entryToken,
            dayToken,
            displayName: "Roti",
            quantity: { amount: "2", unit: "SERVING" },
            status: "CONFIRMED_CONSUMED",
            revision: 3,
          },
        ],
        hasMore,
        candidateDayScopeComplete: !hasMore,
      },
      bounds: { daysPerDate: 8, recentResolvedTurns: 8, entryReferences: 16 },
    },
    resolveDayToken(token) {
      if (token !== dayToken) throw new RoutingCandidateNotFoundError();
      return { userId, foodDayId: dayId };
    },
    resolveEntryToken(token) {
      if (token !== entryToken) throw new RoutingCandidateNotFoundError();
      return { userId, foodDayId: dayId, entryId, revision: 3 };
    },
  };
}

const input = (
  route = snapshot(),
  message = "Actually make that one roti.",
) => ({
  message,
  calendarContext: calendar,
  snapshot: route,
});

function reason(action: () => unknown, expected: string) {
  try {
    action();
    throw new Error("Expected rejection.");
  } catch (error) {
    expect(error).toBeInstanceOf(FoodDayTargetResolutionError);
    expect((error as FoodDayTargetResolutionError).reason).toBe(expected);
  }
}

describe("snapshot-bound decision validation", () => {
  it("resolves a supplied day token and rejects unknown or raw IDs", () => {
    expect(
      validateFoodDayTargetDecision(
        { kind: "EXISTING_DAY", dayToken: "day_a_1" },
        input(),
      ),
    ).toEqual({ kind: "EXISTING_DAY", foodDayId: dayId });
    for (const token of ["day_other_1", dayId])
      reason(
        () =>
          validateFoodDayTargetDecision(
            { kind: "EXISTING_DAY", dayToken: token },
            input(),
          ),
        "UNKNOWN_DAY_TOKEN",
      );
  });

  it("derives the trusted parent and revision from the entry map, not model text", () => {
    expect(
      validateFoodDayTargetDecision(
        { kind: "EXISTING_ENTRY_REFERENCE", entryToken: "entry_a_1" },
        input(),
      ),
    ).toEqual({
      kind: "EXISTING_ENTRY_REFERENCE",
      foodDayId: dayId,
      entryId,
      revision: 3,
    });
    reason(
      () =>
        validateFoodDayTargetDecision(
          {
            kind: "EXISTING_ENTRY_REFERENCE",
            entryToken: "entry_a_1",
            foodDayId: "wrong",
          },
          input(),
        ),
      "INVALID_DECISION",
    );
    for (const token of ["entry_other_1", entryId])
      reason(
        () =>
          validateFoodDayTargetDecision(
            { kind: "EXISTING_ENTRY_REFERENCE", entryToken: token },
            input(),
          ),
        "UNKNOWN_ENTRY_TOKEN",
      );
  });

  it("binds tokens to the exact supplied snapshot", () => {
    reason(
      () =>
        validateFoodDayTargetDecision(
          { kind: "EXISTING_DAY", dayToken: "day_a_1" },
          input(snapshot("b")),
        ),
      "UNKNOWN_DAY_TOKEN",
    );
    reason(
      () =>
        validateFoodDayTargetDecision(
          { kind: "EXISTING_ENTRY_REFERENCE", entryToken: "entry_a_1" },
          input(snapshot("b")),
        ),
      "UNKNOWN_ENTRY_TOKEN",
    );
  });

  it("accepts an explicit Gregorian date and context-derived today/yesterday only", () => {
    expect(
      validateFoodDayTargetDecision(
        { kind: "DATE_TARGET", localDate: "2026-10-10" },
        input(snapshot(), "On 2026-10-10 I had pasta."),
      ),
    ).toEqual({ kind: "DATE_TARGET", localDate: "2026-10-10" });
    expect(
      validateFoodDayTargetDecision(
        { kind: "DATE_TARGET", localDate: "2026-10-13" },
        input(snapshot(), "Yesterday I had dinner."),
      ),
    ).toEqual({ kind: "DATE_TARGET", localDate: "2026-10-13" });
    for (const date of ["2026-02-30", "today", "10/13/2026", "2026-10-11"])
      reason(
        () =>
          validateFoodDayTargetDecision(
            { kind: "DATE_TARGET", localDate: date },
            input(snapshot(), "On 2026-10-10 I had pasta."),
          ),
        "INVALID_DATE_TARGET",
      );
    expect(
      validateFoodDayTargetDecision(
        { kind: "DATE_TARGET", localDate: "2026-10-14" },
        input(snapshot(), "Today I had oats."),
      ),
    ).toEqual({
      kind: "CLARIFY",
      question: "Which day log should I use for that date?",
    });
  });

  it("requires accepted context for relative date output", () => {
    const noCalendar = {
      ...snapshot(),
      projection: {
        ...snapshot().projection,
        calendarContext: null,
        today: null,
        yesterday: null,
      },
    };
    reason(
      () =>
        validateFoodDayTargetDecision(
          { kind: "DATE_TARGET", localDate: "2026-10-14" },
          {
            message: "Today I had oats.",
            calendarContext: null,
            snapshot: noCalendar,
          },
        ),
      "INVALID_DATE_TARGET",
    );
  });

  it("permits today only as the accepted civil date when no canonical day is visible", () => {
    const empty = {
      ...snapshot(),
      projection: {
        ...snapshot().projection,
        activeDayToken: null,
        today: { dayTokens: [], hasMore: false },
        recentDays: { dayTokens: [], hasMoreTurns: false },
        days: [],
      },
    };
    expect(
      validateFoodDayTargetDecision(
        { kind: "DATE_TARGET", localDate: "2026-10-14" },
        input(empty, "Today I had oats."),
      ),
    ).toEqual({ kind: "DATE_TARGET", localDate: "2026-10-14" });
  });

  it("accepts dayless and concise clarify; rejects empty, huge or ID-leaking questions", () => {
    expect(validateFoodDayTargetDecision({ kind: "DAYLESS" }, input())).toEqual(
      { kind: "DAYLESS" },
    );
    expect(
      validateFoodDayTargetDecision(
        { kind: "CLARIFY", question: "  Which day did you mean?  " },
        input(),
      ),
    ).toEqual({ kind: "CLARIFY", question: "Which day did you mean?" });
    for (const question of [
      "  ",
      "x".repeat(241),
      `Is it ${dayId}?`,
      "Is it day_a_1?",
    ])
      reason(
        () =>
          validateFoodDayTargetDecision({ kind: "CLARIFY", question }, input()),
        "INVALID_CLARIFICATION",
      );
  });

  it("rejects malformed union variants and extra fields", () => {
    for (const raw of [
      null,
      [],
      { kind: "OTHER" },
      { kind: "DAYLESS", entryId },
      { kind: "EXISTING_DAY" },
      { kind: "DATE_TARGET", localDate: "2026-10-10", action: "CREATE" },
    ])
      reason(
        () => validateFoodDayTargetDecision(raw, input()),
        "INVALID_DECISION",
      );
  });
});

describe("deterministic canonical ambiguity backstop", () => {
  const clarification = {
    kind: "CLARIFY",
    question: "Which day log should I use for that date?",
  };

  function dateOnly(route = snapshot("a", true)): RoutingSnapshot {
    return {
      ...route,
      projection: {
        ...route.projection,
        activeDayToken: null,
        recentDays: { dayTokens: [], hasMoreTurns: false },
        days: route.projection.days.map((day) => ({
          ...day,
          sources: ["CURRENT_LOCAL_DATE" as const],
        })),
      },
    };
  }

  it("normalizes the live L DATE_TARGET failure with one model call", async () => {
    const model = {
      decide: vi.fn(async () => ({
        kind: "DATE_TARGET",
        localDate: "2026-10-14",
      })),
    };
    expect(
      await resolveFoodDayTarget(
        model,
        input(snapshot("a", true), "Today I had pasta."),
      ),
    ).toEqual(clarification);
    expect(model.decide).toHaveBeenCalledTimes(1);
  });

  it("clarifies DATE_TARGET when the matching bucket is truncated even with no visible day", () => {
    const base = snapshot("a", true);
    const incomplete: RoutingSnapshot = {
      ...base,
      projection: {
        ...base.projection,
        activeDayToken: null,
        today: { dayTokens: [], hasMore: true },
        days: [],
      },
    };
    expect(
      validateFoodDayTargetDecision(
        { kind: "DATE_TARGET", localDate: "2026-10-14" },
        input(incomplete, "Today I had pasta."),
      ),
    ).toEqual(clarification);
  });

  it("clarifies a visible date-only day from an incomplete bucket", () => {
    expect(
      validateFoodDayTargetDecision(
        { kind: "EXISTING_DAY", dayToken: "day_a_1" },
        input(dateOnly(), "Today I had pasta."),
      ),
    ).toEqual(clarification);
    expect(
      validateFoodDayTargetDecision(
        { kind: "EXISTING_DAY", dayToken: "day_a_1" },
        input(dateOnly(snapshot()), "Today I had pasta."),
      ),
    ).toEqual({ kind: "EXISTING_DAY", foodDayId: dayId });
  });

  it("preserves selected active-day continuity without a date cue, but not date-only intent", () => {
    const route = snapshot("a", true);
    expect(
      validateFoodDayTargetDecision(
        { kind: "EXISTING_DAY", dayToken: "day_a_1" },
        input(route, "Actually keep logging there."),
      ),
    ).toEqual({ kind: "EXISTING_DAY", foodDayId: dayId });
    expect(
      validateFoodDayTargetDecision(
        { kind: "EXISTING_DAY", dayToken: "day_a_1" },
        input(route, "Today I had pasta."),
      ),
    ).toEqual(clarification);
  });

  it("retains a trusted entry reference and its parent/revision despite date truncation", () => {
    expect(
      validateFoodDayTargetDecision(
        { kind: "EXISTING_ENTRY_REFERENCE", entryToken: "entry_a_1" },
        input(dateOnly(), "Actually I only ate one of those rotis."),
      ),
    ).toEqual({
      kind: "EXISTING_ENTRY_REFERENCE",
      foodDayId: dayId,
      entryId,
      revision: 3,
    });
  });

  it("preserves a valid model clarification and still rejects invalid decisions", () => {
    const route = dateOnly();
    expect(
      validateFoodDayTargetDecision(
        { kind: "CLARIFY", question: "  Which log did you mean?  " },
        input(route, "Today I had pasta."),
      ),
    ).toEqual({ kind: "CLARIFY", question: "Which log did you mean?" });
    reason(
      () =>
        validateFoodDayTargetDecision(
          { kind: "DATE_TARGET", localDate: "2026-02-30" },
          input(route, "Today I had pasta."),
        ),
      "INVALID_DATE_TARGET",
    );
    reason(
      () =>
        validateFoodDayTargetDecision(
          { kind: "EXISTING_DAY", dayToken: "day_other_1" },
          input(route, "Today I had pasta."),
        ),
      "UNKNOWN_DAY_TOKEN",
    );
  });

  it("keeps DATE_TARGET for a supported date with a complete empty bucket", () => {
    const base = snapshot();
    const empty: RoutingSnapshot = {
      ...base,
      projection: {
        ...base.projection,
        activeDayToken: null,
        today: { dayTokens: [], hasMore: false },
        recentDays: { dayTokens: [], hasMoreTurns: false },
        days: [],
      },
    };
    expect(
      validateFoodDayTargetDecision(
        { kind: "DATE_TARGET", localDate: "2026-10-14" },
        input(empty, "Today I had pasta."),
      ),
    ).toEqual({ kind: "DATE_TARGET", localDate: "2026-10-14" });
  });

  it("does not trust an explicit-date target when its canonical lookup is truncated", () => {
    const base = snapshot();
    const route: RoutingSnapshot = {
      ...base,
      projection: {
        ...base.projection,
        explicitDate: {
          localDate: "2026-10-10",
          dayTokens: [],
          hasMore: true,
        },
      },
    };
    expect(
      validateFoodDayTargetDecision(
        { kind: "DATE_TARGET", localDate: "2026-10-10" },
        input(route, "On 2026-10-10 I had pasta."),
      ),
    ).toEqual(clarification);
  });

  it("clarifies complete same-date multiplicity unless selection has conversational provenance", () => {
    const base = snapshot();
    const secondToken = "day_a_2";
    const secondId = "20000000-0000-4000-8000-000000000002";
    const first = base.projection.days[0]!;
    const multiple: RoutingSnapshot = {
      ...base,
      projection: {
        ...base.projection,
        activeDayToken: null,
        today: { dayTokens: [first.token, secondToken], hasMore: false },
        recentDays: { dayTokens: [], hasMoreTurns: false },
        days: [
          { ...first, sources: ["CURRENT_LOCAL_DATE"] },
          {
            ...first,
            token: secondToken,
            openedAt: "2026-10-13T20:00:00Z",
            sources: ["CURRENT_LOCAL_DATE"],
          },
        ],
      },
      resolveDayToken(token) {
        if (token === secondToken) return { userId, foodDayId: secondId };
        return base.resolveDayToken(token);
      },
    };
    expect(
      validateFoodDayTargetDecision(
        { kind: "DATE_TARGET", localDate: "2026-10-14" },
        input(multiple, "Today I had pasta."),
      ),
    ).toEqual(clarification);
    expect(
      validateFoodDayTargetDecision(
        { kind: "EXISTING_DAY", dayToken: first.token },
        input(multiple, "Today I had pasta."),
      ),
    ).toEqual(clarification);
    const referenced: RoutingSnapshot = {
      ...multiple,
      projection: {
        ...multiple.projection,
        recentDays: { dayTokens: [first.token], hasMoreTurns: false },
        days: [
          {
            ...first,
            sources: ["CURRENT_LOCAL_DATE", "RECENT_COMPLETED_TURN"],
          },
          multiple.projection.days[1]!,
        ],
      },
    };
    expect(
      validateFoodDayTargetDecision(
        { kind: "EXISTING_DAY", dayToken: first.token },
        input(referenced, "Actually continue that day."),
      ),
    ).toEqual({ kind: "EXISTING_DAY", foodDayId: dayId });
  });
});

it("makes exactly one model call with exact text and ID-free bounded projection; has no side-effect dependency", async () => {
  const route = snapshot("a", true);
  const model = { decide: vi.fn(async () => ({ kind: "DAYLESS" })) };
  const message = "  Hey.  ";
  expect(await resolveFoodDayTarget(model, input(route, message))).toEqual({
    kind: "DAYLESS",
  });
  expect(model.decide).toHaveBeenCalledExactlyOnceWith({
    message,
    calendarContext: calendar,
    routing: route.projection,
  });
  const serialized = JSON.stringify(model.decide.mock.calls[0]);
  expect(serialized).not.toContain(dayId);
  expect(serialized).not.toContain(entryId);
  expect(serialized).toContain('"hasMore":true');
  expect(serialized).toContain('"candidateDayScopeComplete":false');
  expect(serialized).toContain('"hasMoreTurns":true');
});

it("rejects inconsistent calendar input before a model call", async () => {
  const model = { decide: vi.fn() };
  await expect(
    resolveFoodDayTarget(model, {
      message: "Today",
      calendarContext: null,
      snapshot: snapshot(),
    }),
  ).rejects.toMatchObject({ reason: "INVALID_INPUT" });
  expect(model.decide).not.toHaveBeenCalled();
});
