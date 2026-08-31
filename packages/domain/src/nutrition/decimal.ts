import { Decimal } from "decimal.js";
import { z } from "zod";

import { DomainValidationError } from "../errors.js";

const DomainDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -100,
  toExpPos: 100,
});

export type DecimalString = string;

const decimalTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      return new DomainDecimal(value).isFinite();
    } catch {
      return false;
    }
  }, "Expected a finite decimal string.");

function validationError(
  label: string,
  message: string,
): DomainValidationError {
  return new DomainValidationError(`${label}: ${message}`);
}

export function normalizeDecimal(
  value: string,
  options: {
    readonly label?: string;
    readonly allowNegative?: boolean;
    readonly allowZero?: boolean;
  } = {},
): DecimalString {
  const label = options.label ?? "decimal";
  const parsed = decimalTextSchema.safeParse(value);

  if (!parsed.success) {
    throw validationError(label, "must be a finite decimal string");
  }

  const decimal = new DomainDecimal(parsed.data);
  if (!(options.allowNegative ?? false) && decimal.isNegative()) {
    throw validationError(label, "must not be negative");
  }
  if (!(options.allowZero ?? true) && decimal.isZero()) {
    throw validationError(label, "must be greater than zero");
  }

  return decimal.isZero() ? "0" : decimal.toFixed();
}

export function addDecimals(
  left: DecimalString,
  right: DecimalString,
): DecimalString {
  return new DomainDecimal(left).plus(right).toFixed();
}

export function subtractDecimals(
  left: DecimalString,
  right: DecimalString,
): DecimalString {
  return new DomainDecimal(left).minus(right).toFixed();
}

export function scaleDecimal(
  value: DecimalString,
  multiplier: DecimalString,
  divisor: DecimalString,
): DecimalString {
  return new DomainDecimal(value)
    .times(multiplier)
    .dividedBy(divisor)
    .toFixed();
}

export function compareDecimals(
  left: DecimalString,
  right: DecimalString,
): -1 | 0 | 1 {
  const comparison = new DomainDecimal(left).comparedTo(right);
  return comparison === 0 ? 0 : comparison < 0 ? -1 : 1;
}

/** Conventional half-up rounding for display only; canonical values are unchanged. */
export function roundDecimalForDisplay(value: DecimalString): string {
  const normalized = normalizeDecimal(value, {
    allowNegative: true,
    label: "display value",
  });
  return new DomainDecimal(normalized).toDecimalPlaces(0).toFixed(0);
}
