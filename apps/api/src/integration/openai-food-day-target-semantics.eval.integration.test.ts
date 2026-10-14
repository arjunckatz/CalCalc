import OpenAI from "openai";
import { it } from "vitest";

import { acceptCalendarContext } from "../conversation/calendar-context.js";
import { createOpenAIFoodDayTargetModel } from "../conversation/providers/openai/openai-food-day-target-model.js";
import {
  FoodDayTargetResolutionError,
  resolveFoodDayTarget,
  type FoodDayTargetResolutionModel,
  type ValidatedFoodDayTarget,
} from "../conversation/resolve-food-day-target.js";
import {
  RoutingCandidateNotFoundError,
  type ModelSafeRoutingDay,
  type ModelSafeRoutingEntry,
  type RoutingSnapshot,
} from "../conversation/routing-context.js";

const current = "2026-10-14";
const prior = "2026-10-13";
const tokenDigest = "aaaaaaaaaaaaaaaaaaaaaaaa";
const dayId = (ordinal: number) =>
  `20000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const entryId = (ordinal: number) =>
  `30000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const userId = "10000000-0000-4000-8000-000000000001";

interface DayFixture {
  readonly token: string;
  readonly date: string;
  readonly active?: boolean;
  readonly completeness?: "UNKNOWN" | "USER_DECLARED_COMPLETE";
}
interface EntryFixture {
  readonly token: string;
  readonly dayToken: string;
  readonly name: string;
  readonly revision?: number;
}
interface Scenario {
  readonly name: string;
  readonly message: string;
  readonly days: readonly DayFixture[];
  readonly entries?: readonly EntryFixture[];
  readonly time?: string;
  readonly todayHasMore?: boolean;
  readonly expected: {
    readonly kind: ValidatedFoodDayTarget["kind"];
    readonly token?: string;
    readonly date?: string;
  };
}

const todayDay: DayFixture = {
  token: `day_${tokenDigest}_1`,
  date: current,
  active: true,
};
const priorDay: DayFixture = { token: `day_${tokenDigest}_2`, date: prior };
const roti: EntryFixture = {
  token: `entry_${tokenDigest}_1`,
  dayToken: todayDay.token,
  name: "Roti",
};
const bars: EntryFixture = {
  token: `entry_${tokenDigest}_2`,
  dayToken: priorDay.token,
  name: "Protein bars",
  revision: 2,
};

const scenarios: readonly Scenario[] = [
  {
    name: "A active-day continuation",
    message: "Actually make that one roti.",
    days: [todayDay],
    entries: [roti],
    expected: { kind: "EXISTING_ENTRY_REFERENCE", token: roti.token },
  },
  {
    name: "B explicit today",
    message: "Today I had oats.",
    days: [todayDay],
    expected: { kind: "EXISTING_DAY", token: todayDay.token },
  },
  {
    name: "C explicit yesterday with no candidate",
    message: "Yesterday I forgot to log dinner.",
    days: [],
    expected: { kind: "DATE_TARGET", date: prior },
  },
  {
    name: "D explicit ISO date",
    message: "On 2026-10-10 I had pasta.",
    days: [],
    expected: { kind: "DATE_TARGET", date: "2026-10-10" },
  },
  {
    name: "E ambiguous midnight",
    message: "I just had pizza.",
    days: [
      { ...priorDay, active: true },
      { ...todayDay, active: false },
    ],
    time: "00:30:00",
    expected: { kind: "CLARIFY" },
  },
  {
    name: "F same-date plurality",
    message: "Yesterday I had pasta.",
    days: [priorDay, { token: `day_${tokenDigest}_3`, date: prior }],
    expected: { kind: "CLARIFY" },
  },
  {
    name: "G cross-day correction",
    message: "Actually I only ate one of those bars.",
    days: [priorDay, todayDay],
    entries: [bars],
    expected: { kind: "EXISTING_ENTRY_REFERENCE", token: bars.token },
  },
  {
    name: "H weight-only",
    message: "I weighed 80 kg today.",
    days: [todayDay],
    expected: { kind: "DAYLESS" },
  },
  {
    name: "I latest weight",
    message: "What's my latest weight?",
    days: [todayDay],
    expected: { kind: "DAYLESS" },
  },
  {
    name: "J food read",
    message: "How am I doing today?",
    days: [todayDay],
    expected: { kind: "EXISTING_DAY", token: todayDay.token },
  },
  {
    name: "K greeting",
    message: "Hey.",
    days: [todayDay],
    expected: { kind: "DAYLESS" },
  },
  {
    name: "L truncated today",
    message: "Today I had pasta.",
    days: [todayDay],
    todayHasMore: true,
    expected: { kind: "CLARIFY" },
  },
];

function fixture(scenario: Scenario) {
  const calendar = acceptCalendarContext({
    currentLocalDateTime: `2026-10-14T${scenario.time ?? "08:00:00"}+05:30`,
    timeZone: "Asia/Kolkata",
  });
  if (calendar === null) throw new Error("Eval calendar fixture invalid.");
  const days: ModelSafeRoutingDay[] = scenario.days.map((day, index) => ({
    token: day.token,
    localDate: day.date,
    status: "OPEN",
    completeness: day.completeness ?? "UNKNOWN",
    openedAt: `2026-10-13T${String(index).padStart(2, "0")}:00:00Z`,
    sources: [
      ...(day.active ? ["ACTIVE_POINTER" as const] : []),
      day.date === current
        ? ("CURRENT_LOCAL_DATE" as const)
        : ("PREVIOUS_LOCAL_DATE" as const),
    ],
  }));
  const entries: ModelSafeRoutingEntry[] = (scenario.entries ?? []).map(
    (entry) => ({
      token: entry.token,
      dayToken: entry.dayToken,
      displayName: entry.name,
      quantity: { amount: "2", unit: "SERVING" },
      status: "CONFIRMED_CONSUMED",
      revision: entry.revision ?? 1,
    }),
  );
  const today = days
    .filter((day) => day.localDate === current)
    .map((day) => day.token);
  const yesterday = days
    .filter((day) => day.localDate === prior)
    .map((day) => day.token);
  const route: RoutingSnapshot = {
    projection: {
      calendarContext: calendar,
      activeDayToken: scenario.days.find((day) => day.active)?.token ?? null,
      today: { dayTokens: today, hasMore: scenario.todayHasMore ?? false },
      yesterday: { dayTokens: yesterday, hasMore: false },
      recentDays: { dayTokens: [], hasMoreTurns: false },
      days,
      recentEntryReferences: {
        items: entries,
        hasMore: false,
        candidateDayScopeComplete: !scenario.todayHasMore,
      },
      bounds: { daysPerDate: 8, recentResolvedTurns: 8, entryReferences: 16 },
    },
    resolveDayToken(token) {
      const index = scenario.days.findIndex((day) => day.token === token);
      if (index < 0) throw new RoutingCandidateNotFoundError();
      return { userId, foodDayId: dayId(index + 1) };
    },
    resolveEntryToken(token) {
      const index = (scenario.entries ?? []).findIndex(
        (entry) => entry.token === token,
      );
      if (index < 0) throw new RoutingCandidateNotFoundError();
      const entry = scenario.entries![index]!;
      const dayIndex = scenario.days.findIndex(
        (day) => day.token === entry.dayToken,
      );
      return {
        userId,
        foodDayId: dayId(dayIndex + 1),
        entryId: entryId(index + 1),
        revision: entry.revision ?? 1,
      };
    },
  };
  return { calendar, route };
}

function requiredEnvironment(name: "OPENAI_API_KEY" | "OPENAI_MODEL"): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} is required for the opt-in target semantic eval.`);
  return value;
}

it.each(scenarios)(
  "$name",
  async (scenario) => {
    const client = new OpenAI({
      apiKey: requiredEnvironment("OPENAI_API_KEY"),
      maxRetries: 0,
      timeout: 30_000,
    });
    const model = createOpenAIFoodDayTargetModel({
      client,
      model: requiredEnvironment("OPENAI_MODEL"),
    });
    const { calendar, route } = fixture(scenario);
    let actual: ValidatedFoodDayTarget;
    let modelKind = "NO_DECISION";
    const observedModel: FoodDayTargetResolutionModel = {
      async decide(input) {
        const decision = await model.decide(input);
        if (
          decision !== null &&
          typeof decision === "object" &&
          "kind" in decision
        ) {
          const kind: unknown = decision.kind;
          modelKind =
            kind === "EXISTING_DAY" ||
            kind === "EXISTING_ENTRY_REFERENCE" ||
            kind === "DATE_TARGET" ||
            kind === "DAYLESS" ||
            kind === "CLARIFY"
              ? kind
              : "UNRECOGNIZED";
        }
        return decision;
      },
    };
    try {
      actual = await resolveFoodDayTarget(observedModel, {
        message: scenario.message,
        calendarContext: calendar,
        snapshot: route,
      });
    } catch (error) {
      // Never print provider payloads, messages, keys, or SDK error causes.
      const kind = error instanceof Error ? error.name : "UnknownError";
      const reason =
        error instanceof FoodDayTargetResolutionError
          ? error.reason
          : "UNCLASSIFIED";
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `${scenario.name}: resolution failed (${kind}/${reason}; modelKind=${modelKind}).`,
      );
    }
    if (actual.kind !== scenario.expected.kind)
      throw new Error(
        `${scenario.name}: expected ${scenario.expected.kind}, got ${actual.kind}.`,
      );
    if (scenario.expected.token !== undefined) {
      const expectedDay = route.resolveDayToken(
        actual.kind === "EXISTING_DAY"
          ? scenario.expected.token
          : (scenario.entries?.find(
              (entry) => entry.token === scenario.expected.token,
            )?.dayToken ?? ""),
      );
      if (
        actual.kind !== "EXISTING_DAY" &&
        actual.kind !== "EXISTING_ENTRY_REFERENCE"
      )
        throw new Error(`${scenario.name}: expected canonical token target.`);
      if (actual.foodDayId !== expectedDay.foodDayId)
        throw new Error(`${scenario.name}: wrong canonical parent day.`);
      if (
        actual.kind === "EXISTING_ENTRY_REFERENCE" &&
        actual.entryId !==
          route.resolveEntryToken(scenario.expected.token).entryId
      )
        throw new Error(`${scenario.name}: wrong canonical entry.`);
    }
    if (
      scenario.expected.date !== undefined &&
      (actual.kind !== "DATE_TARGET" ||
        actual.localDate !== scenario.expected.date)
    )
      throw new Error(`${scenario.name}: wrong date target.`);
    const detail =
      actual.kind === "CLARIFY"
        ? `question=${JSON.stringify(actual.question)}`
        : actual.kind === "DATE_TARGET"
          ? `date=${actual.localDate}`
          : actual.kind === "EXISTING_DAY"
            ? "tokenClass=day"
            : actual.kind === "EXISTING_ENTRY_REFERENCE"
              ? "tokenClass=entry"
              : "no FoodDay target";
    // Opt-in eval only: print validated semantics, never canonical IDs or provider payloads.
    console.info(
      `${scenario.name}: expected=${scenario.expected.kind}; raw=${modelKind}; trusted=${actual.kind}; ${detail}; PASS`,
    );
  },
  45_000,
);
