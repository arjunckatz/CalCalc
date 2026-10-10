import { createBodyWeightEntry, createFoodDay } from "@cal-calc/domain";

import type { FoodDayToolResult } from "../agent/tools/execute-food-day-tool.js";
import { projectBodyWeightHistory } from "../agent/tools/project-body-weight-history.js";
import type { FoodDayModelDecisionInput } from "../agent/turn/food-day-turn-types.js";
import type { BodyWeightHistoryObservation } from "../queries/get-body-weight-history.js";
import { buildFoodDayState } from "../state/build-food-day-state.js";

const foodDay = createFoodDay({
  id: "10000000-0000-4000-8000-000000000001",
  status: "OPEN",
  calorieTarget: "2200",
  proteinTarget: "120",
});

/** FoodDay.localDate deliberately is not a body-weight history date. */
export const historyEvalState = buildFoodDayState({
  foodDay,
  entries: [],
  completeness: "UNKNOWN",
  localDate: "2026-10-01",
});

export interface HistoryEvalScenario {
  readonly id: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
  readonly name: string;
  readonly userMessage: string;
  readonly recentTranscript?: FoodDayModelDecisionInput["recentTranscript"];
  readonly calendarContext?: FoodDayModelDecisionInput["calendarContext"];
  readonly expectedDecision: "HISTORY_READ" | "LOG_THEN_READ" | "FINAL" | null;
  readonly toolResults?: readonly FoodDayToolResult[];
  readonly maxResponsesCalls: 1 | 2 | 3;
}

function observation(
  index: number,
  localDate: string,
  sourceValue: string,
): BodyWeightHistoryObservation {
  return {
    ...createBodyWeightEntry({
      id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      localDate,
      sourceValue,
      sourceUnit: "KG",
    }),
    createdAt: "2026-10-07T12:00:00.000Z",
  };
}

function history(
  recentObservations: readonly BodyWeightHistoryObservation[],
  latestMeasurementDate: string | null,
  latestDateObservations: readonly BodyWeightHistoryObservation[],
): FoodDayToolResult {
  return {
    name: "GET_BODY_WEIGHT_HISTORY",
    result: projectBodyWeightHistory({
      recentObservations,
      latestMeasurementDate,
      latestDateObservations,
    }),
  };
}

function loggedWeight(localDate: string, value: string): FoodDayToolResult {
  return {
    name: "LOG_BODY_WEIGHT",
    result: {
      disposition: "CREATED",
      weightEntry: {
        ...createBodyWeightEntry({
          id: "30000000-0000-4000-8000-000000000001",
          localDate,
          sourceValue: value,
          sourceUnit: "KG",
        }),
        createdAt: "2026-10-07T12:00:00.000Z",
      },
    },
  };
}

const latestOne = observation(1, "2026-10-06", "79.8");
const latestTwoA = observation(2, "2026-10-06", "80.2");
const latestTwoB = observation(3, "2026-10-06", "81");
const recentSixth = observation(4, "2026-10-06", "80");
const recentFifth = observation(5, "2026-10-05", "79.5");
const recentFourth = observation(6, "2026-10-04", "79");
const boundedRecent = [
  observation(7, "2026-10-06", "80"),
  ...Array.from({ length: 29 }, (_, index) =>
    observation(index + 8, "2026-10-05", "79.5"),
  ),
];

/** Exactly eight opt-in cases; F/H can use one bounded read continuation. */
export const historyEvalScenarios: readonly HistoryEvalScenario[] = [
  {
    id: "A",
    name: "transcript conflict yields to empty canonical history",
    userMessage: "What's my latest weight?",
    recentTranscript: [
      {
        userMessage: "On 2026-10-05 I weighed 80.4 kg.",
        response: "Logged 80.4 kg for October 5.",
      },
    ],
    expectedDecision: "HISTORY_READ",
    toolResults: [history([], null, [])],
    maxResponsesCalls: 2,
  },
  {
    id: "B",
    name: "one canonical latest-date observation",
    userMessage: "What's my latest weight?",
    expectedDecision: "HISTORY_READ",
    toolResults: [history([latestOne], "2026-10-06", [latestOne])],
    maxResponsesCalls: 2,
  },
  {
    id: "C",
    name: "multiple observations on the latest measurement date",
    userMessage: "What's my latest weight?",
    expectedDecision: "HISTORY_READ",
    toolResults: [
      history([latestTwoA, latestTwoB], "2026-10-06", [latestTwoA, latestTwoB]),
    ],
    maxResponsesCalls: 2,
  },
  {
    id: "D",
    name: "raw recent history without arithmetic",
    userMessage: "What weights have I logged recently?",
    expectedDecision: "HISTORY_READ",
    toolResults: [
      history([recentSixth, recentFifth, recentFourth], "2026-10-06", [
        recentSixth,
      ]),
    ],
    maxResponsesCalls: 2,
  },
  {
    id: "E",
    name: "bounded history cannot establish older-date absence",
    userMessage: "Did I log a weight on 2026-09-01?",
    expectedDecision: "HISTORY_READ",
    toolResults: [history(boundedRecent, "2026-10-06", [boundedRecent[0]!])],
    maxResponsesCalls: 2,
  },
  {
    id: "F",
    name: "new weigh-in precedes a fresh canonical history read",
    userMessage: "I weighed 80 kg today. What's my latest weight?",
    calendarContext: { currentLocalDate: "2026-10-06" },
    expectedDecision: "LOG_THEN_READ",
    toolResults: [
      loggedWeight("2026-10-06", "80"),
      history([recentSixth], "2026-10-06", [recentSixth]),
    ],
    maxResponsesCalls: 3,
  },
  {
    id: "G",
    name: "weight-loss math has no deterministic primitive",
    userMessage: "How much weight have I lost?",
    expectedDecision: "FINAL",
    maxResponsesCalls: 1,
  },
  {
    id: "H",
    name: "pre-mutation history is stale after a later weigh-in",
    userMessage: "I weighed 80 kg today. What's my latest weight?",
    expectedDecision: null,
    toolResults: [
      history([recentFifth], "2026-10-05", [recentFifth]),
      loggedWeight("2026-10-06", "80"),
      history([recentSixth], "2026-10-06", [recentSixth]),
    ],
    maxResponsesCalls: 2,
  },
];
