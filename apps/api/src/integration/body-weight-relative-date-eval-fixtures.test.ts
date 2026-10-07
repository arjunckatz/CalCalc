import { describe, expect, it } from "vitest";

import {
  relativeDateScenarios,
  relativeDateState,
} from "./body-weight-relative-date-eval-fixtures.js";

describe("relative-date live eval fixture registry", () => {
  it("registers exactly the six reviewed decision-only scenarios", () => {
    expect(relativeDateScenarios).toHaveLength(6);
    expect(
      relativeDateScenarios.map((scenario) => ({
        id: scenario.id,
        name: scenario.name,
        userMessage: scenario.userMessage,
        expected: scenario.expected,
        currentLocalDate: scenario.calendarContext?.currentLocalDate,
      })),
    ).toEqual([
      {
        id: "A",
        name: "clean today",
        userMessage: "I weighed 80 kg today.",
        expected: "TOOLS",
        currentLocalDate: "2026-10-06",
      },
      {
        id: "B",
        name: "clean yesterday",
        userMessage: "Yesterday I was 178 lb.",
        expected: "TOOLS",
        currentLocalDate: "2026-10-06",
      },
      {
        id: "C",
        name: "unrelated yesterday and actual today",
        userMessage: "My appointment was yesterday, but I weighed 80 kg today.",
        expected: "TOOLS",
        currentLocalDate: "2026-10-06",
      },
      {
        id: "D",
        name: "relative-date correction is not a new observation",
        userMessage:
          "Correction: yesterday's weigh-in was 79.8 kg, not 80.8 kg.",
        expected: "FINAL",
        currentLocalDate: "2026-10-06",
      },
      {
        id: "E",
        name: "yesterday without calendar context needs a date",
        userMessage: "Yesterday I was 178 lb.",
        expected: "FINAL",
        currentLocalDate: undefined,
      },
      {
        id: "F",
        name: "omitted measurement date is not inferred",
        userMessage: "I weigh 80 kg.",
        expected: "FINAL",
        currentLocalDate: "2026-10-06",
      },
    ]);
    expect(Object.hasOwn(relativeDateScenarios[4]!, "calendarContext")).toBe(
      false,
    );
    for (const scenario of relativeDateScenarios) {
      if (scenario.calendarContext !== undefined) {
        expect(Object.isFrozen(scenario.calendarContext)).toBe(true);
      }
    }
  });

  it("keeps exact tool arguments and prose checks fixed", () => {
    expect(
      relativeDateScenarios.map((scenario) =>
        scenario.expected === "TOOLS"
          ? scenario.arguments
          : scenario.answerCheck,
      ),
    ).toEqual([
      { localDate: "2026-10-06", sourceValue: "80", sourceUnit: "KG" },
      { localDate: "2026-10-05", sourceValue: "178", sourceUnit: "LB" },
      { localDate: "2026-10-06", sourceValue: "80", sourceUnit: "KG" },
      "CORRECTION_UNAVAILABLE",
      "DATE_CLARIFICATION",
      "DATE_CLARIFICATION",
    ]);
  });

  it("uses production-built STATE with an unrelated logical FoodDay date", () => {
    expect(relativeDateState.foodDay.localDate).toBe("2026-10-01");
    expect(relativeDateState.foodDay).not.toHaveProperty("currentLocalDate");
    expect(relativeDateState).not.toHaveProperty("calendarContext");
  });
});
