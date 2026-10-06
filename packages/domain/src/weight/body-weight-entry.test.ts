import { describe, expect, it } from "vitest";

import { DomainValidationError } from "../errors.js";
import { multiplyDecimalsExact } from "../nutrition/decimal.js";
import {
  createBodyWeightEntry,
  type BodyWeightUnit,
} from "./body-weight-entry.js";

const base = {
  id: "10000000-0000-4000-8000-000000000001",
  localDate: "2026-10-04",
  sourceValue: "81.200",
  sourceUnit: "KG" as const,
};

describe("canonical body-weight observation", () => {
  it("preserves the source unit and normalizes KG without conversion", () => {
    expect(createBodyWeightEntry(base)).toEqual({
      ...base,
      sourceValue: "81.2",
      weightKg: "81.2",
    });
  });

  it("converts LB through the exact decimal factor without display rounding", () => {
    expect(
      createBodyWeightEntry({
        ...base,
        sourceValue: "180.25",
        sourceUnit: "LB",
      }),
    ).toMatchObject({
      sourceValue: "180.25",
      sourceUnit: "LB",
      weightKg: "81.7600246925",
    });
    expect(
      createBodyWeightEntry({ ...base, sourceValue: "0.1", sourceUnit: "LB" })
        .weightKg,
    ).toBe("0.045359237");
  });

  it("keeps exact multiplication beyond the default 40-digit precision", () => {
    const value = "1234567890123456789012345678901234567890123456789";
    const scaled = (BigInt(value) * 45359237n).toString();
    const expected = `${scaled.slice(0, -8)}.${scaled.slice(-8)}`;
    expect(multiplyDecimalsExact(value, "0.45359237")).toBe(expected);
    expect(
      createBodyWeightEntry({ ...base, sourceValue: value, sourceUnit: "LB" })
        .weightKg,
    ).toBe(expected);
  });

  it.each(["0", "-1", "NaN", "Infinity", "1,000", "", "nope"])(
    "rejects invalid source value %s",
    (sourceValue) => {
      expect(() => createBodyWeightEntry({ ...base, sourceValue })).toThrow(
        DomainValidationError,
      );
    },
  );

  it("rejects invalid units and impossible local dates", () => {
    expect(() =>
      createBodyWeightEntry({
        ...base,
        sourceUnit: "STONE" as BodyWeightUnit,
      }),
    ).toThrow(DomainValidationError);
    expect(() =>
      createBodyWeightEntry({ ...base, localDate: "2026-02-30" }),
    ).toThrow(DomainValidationError);
    expect(() =>
      createBodyWeightEntry({ ...base, localDate: "0000-01-01" }),
    ).toThrow(DomainValidationError);
  });

  it("rejects ignored ownership and persistence fields", () => {
    expect(() =>
      createBodyWeightEntry({ ...base, userId: "someone-else" } as typeof base),
    ).toThrow(DomainValidationError);
  });
});
