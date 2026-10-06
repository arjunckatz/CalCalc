import { z } from "zod";

import { DomainValidationError } from "../errors.js";
import {
  multiplyDecimalsExact,
  normalizeDecimal,
  type DecimalString,
} from "../nutrition/decimal.js";

export const bodyWeightUnits = ["KG", "LB"] as const;
export type BodyWeightUnit = (typeof bodyWeightUnits)[number];

export interface BodyWeightEntry {
  readonly id: string;
  /** The local calendar date of the observation, not its persistence timestamp. */
  readonly localDate: string;
  readonly sourceValue: DecimalString;
  readonly sourceUnit: BodyWeightUnit;
  readonly weightKg: DecimalString;
}

export interface CreateBodyWeightEntryInput {
  readonly id: string;
  readonly localDate: string;
  readonly sourceValue: string;
  readonly sourceUnit: BodyWeightUnit;
}

const inputSchema = z.strictObject({
  id: z.string().trim().min(1),
  localDate: z.string(),
  sourceValue: z.string(),
  sourceUnit: z.enum(bodyWeightUnits),
});

export function createBodyWeightEntry(
  input: CreateBodyWeightEntryInput,
): BodyWeightEntry {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || !isLocalDate(parsed.data.localDate)) {
    throw new DomainValidationError("Invalid body-weight observation.");
  }
  const sourceValue = normalizeDecimal(parsed.data.sourceValue, {
    label: "body weight source value",
    allowZero: false,
  });
  return {
    id: parsed.data.id,
    localDate: parsed.data.localDate,
    sourceValue,
    sourceUnit: parsed.data.sourceUnit,
    weightKg:
      parsed.data.sourceUnit === "KG"
        ? sourceValue
        : multiplyDecimalsExact(sourceValue, "0.45359237"),
  };
}

function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0)
  );
}
