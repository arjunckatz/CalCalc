import { createFoodDay } from "@cal-calc/domain";

import type { FoodDayCalendarContext } from "../agent/turn/food-day-turn-types.js";
import { buildFoodDayState } from "../state/build-food-day-state.js";
import type { ExpectedWeightArguments } from "./body-weight-semantics-eval-assertions.js";

type RelativeDateScenarioBase = {
  readonly id: "A" | "B" | "C" | "D" | "E" | "F";
  readonly name: string;
  readonly userMessage: string;
  readonly calendarContext?: FoodDayCalendarContext;
};

export type RelativeDateScenario = RelativeDateScenarioBase &
  (
    | {
        readonly expected: "TOOLS";
        readonly arguments: ExpectedWeightArguments;
      }
    | {
        readonly expected: "FINAL";
        readonly answerCheck: "CORRECTION_UNAVAILABLE" | "DATE_CLARIFICATION";
      }
  );

const foodDay = createFoodDay({
  id: "10000000-0000-4000-8000-000000000001",
  status: "OPEN",
  calorieTarget: "2200",
  proteinTarget: "120",
});

export const relativeDateState = buildFoodDayState({
  foodDay,
  entries: [],
  completeness: "UNKNOWN",
  localDate: "2026-10-01", // Logical FoodDay date, not conversational today.
});

const currentCalendarContext = Object.freeze({
  currentLocalDate: "2026-10-06",
} as const);

export const relativeDateScenarios: readonly RelativeDateScenario[] = [
  {
    id: "A",
    name: "clean today",
    userMessage: "I weighed 80 kg today.",
    calendarContext: currentCalendarContext,
    expected: "TOOLS",
    arguments: {
      localDate: "2026-10-06",
      sourceValue: "80",
      sourceUnit: "KG",
    },
  },
  {
    id: "B",
    name: "clean yesterday",
    userMessage: "Yesterday I was 178 lb.",
    calendarContext: currentCalendarContext,
    expected: "TOOLS",
    arguments: {
      localDate: "2026-10-05",
      sourceValue: "178",
      sourceUnit: "LB",
    },
  },
  {
    id: "C",
    name: "unrelated yesterday and actual today",
    userMessage: "My appointment was yesterday, but I weighed 80 kg today.",
    calendarContext: currentCalendarContext,
    expected: "TOOLS",
    arguments: {
      localDate: "2026-10-06",
      sourceValue: "80",
      sourceUnit: "KG",
    },
  },
  {
    id: "D",
    name: "relative-date correction is not a new observation",
    userMessage: "Correction: yesterday's weigh-in was 79.8 kg, not 80.8 kg.",
    calendarContext: currentCalendarContext,
    expected: "FINAL",
    answerCheck: "CORRECTION_UNAVAILABLE",
  },
  {
    id: "E",
    name: "yesterday without calendar context needs a date",
    userMessage: "Yesterday I was 178 lb.",
    expected: "FINAL",
    answerCheck: "DATE_CLARIFICATION",
  },
  {
    id: "F",
    name: "omitted measurement date is not inferred",
    userMessage: "I weigh 80 kg.",
    calendarContext: currentCalendarContext,
    expected: "FINAL",
    answerCheck: "DATE_CLARIFICATION",
  },
];
