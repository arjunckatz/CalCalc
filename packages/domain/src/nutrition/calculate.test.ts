import { describe, expect, it } from "vitest";

import {
  calculateNutrition,
  DomainValidationError,
  IncompatibleUnitError,
  roundDecimalForDisplay,
} from "../index.js";

describe("deterministic nutrition calculation", () => {
  it("calculates fries from a per-100 g basis", () => {
    expect(
      calculateNutrition(
        {
          amount: "100",
          unit: "GRAM",
          nutrition: { calories: "119" },
        },
        { amount: "200", unit: "GRAM" },
      ),
    ).toEqual({ calories: "238" });
  });

  it("preserves exact canonical decimal precision for the fries variant", () => {
    expect(
      calculateNutrition(
        {
          amount: "100",
          unit: "GRAM",
          nutrition: { calories: "119" },
        },
        { amount: "230", unit: "GRAM" },
      ).calories,
    ).toBe("273.7");
  });

  it("calculates servings without requiring grams", () => {
    expect(
      calculateNutrition(
        {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "73" },
        },
        { amount: "4", unit: "SERVING" },
      ).calories,
    ).toBe("292");
  });

  it("calculates label nutrition exactly across calories and protein", () => {
    expect(
      calculateNutrition(
        {
          amount: "100",
          unit: "GRAM",
          nutrition: { calories: "249.13", protein: "14.91" },
        },
        { amount: "275", unit: "GRAM" },
      ),
    ).toEqual({ calories: "685.1075", protein: "41.0025" });
  });

  it("rounds for display without mutating canonical decimal values", () => {
    expect(roundDecimalForDisplay("273.7")).toBe("274");
    expect(roundDecimalForDisplay("685.1075")).toBe("685");
    expect(roundDecimalForDisplay("41.0025")).toBe("41");
  });

  it("rejects malformed and negative decimal inputs", () => {
    expect(() =>
      calculateNutrition(
        {
          amount: "100",
          unit: "GRAM",
          nutrition: { calories: "not-a-number" },
        },
        { amount: "1", unit: "GRAM" },
      ),
    ).toThrow(DomainValidationError);
    expect(() =>
      calculateNutrition(
        {
          amount: "100",
          unit: "GRAM",
          nutrition: { calories: "119" },
        },
        { amount: "-1", unit: "GRAM" },
      ),
    ).toThrow(DomainValidationError);
  });

  it("rejects incompatible measurement units explicitly", () => {
    expect(() =>
      calculateNutrition(
        {
          amount: "100",
          unit: "GRAM",
          nutrition: { calories: "119" },
        },
        { amount: "250", unit: "MILLILITRE" },
      ),
    ).toThrow(IncompatibleUnitError);
  });
});
