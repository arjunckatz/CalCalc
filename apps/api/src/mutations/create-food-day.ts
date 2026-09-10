import { randomUUID } from "node:crypto";

import {
  createFoodDay,
  DomainValidationError,
  normalizeDecimal,
} from "@cal-calc/domain";
import {
  createFoodDayExactlyOnce,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";

import { toFoodDayDto, type FoodDayDto } from "../http/food-day-dto.js";
import {
  deriveMutationIdentity,
  type IdempotencyKey,
} from "./mutation-identity.js";

export interface CreateFoodDayCommand {
  readonly calorieTarget: string;
  readonly proteinTarget: string;
  readonly localDate: string | null;
  readonly timezone: string | null;
}

export class InvalidCreateFoodDayCommandError extends Error {
  override readonly name = "InvalidCreateFoodDayCommandError";
  constructor() {
    super("Invalid FoodDay creation command.");
  }
}

/** Strict transport-independent command parsing, before any identity derivation. */
export function parseCreateFoodDayCommand(
  value: unknown,
): CreateFoodDayCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidCreateFoodDayCommandError();
  }
  const fields = new Set([
    "calorieTarget",
    "proteinTarget",
    "localDate",
    "timezone",
  ]);
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !fields.has(key))
      throw new InvalidCreateFoodDayCommandError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor))
      throw new InvalidCreateFoodDayCommandError();
    record[key] = descriptor.value;
  }
  const localDate = record.localDate ?? null;
  if (localDate !== null && !isLocalDate(localDate))
    throw new InvalidCreateFoodDayCommandError();
  const timezone = record.timezone ?? null;
  if (timezone !== null) {
    if (
      typeof timezone !== "string" ||
      timezone.length > 128 ||
      !/^[A-Za-z0-9_+\-/]+$/.test(timezone)
    ) {
      throw new InvalidCreateFoodDayCommandError();
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      throw new InvalidCreateFoodDayCommandError();
    }
  }
  return {
    calorieTarget: parseTarget(record.calorieTarget),
    proteinTarget: parseTarget(record.proteinTarget),
    localDate,
    timezone,
  };
}

export interface CreateFoodDayMutationInput {
  /** Must be the verified identity.userId, never transport-supplied ownership. */
  readonly trustedUserId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly command: CreateFoodDayCommand;
}

export interface CreateFoodDayMutationResult {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly foodDay: FoodDayDto;
}

export async function createFoodDayMutation(
  dependencies: { readonly transactionRunner: PostgresTransactionRunner },
  input: CreateFoodDayMutationInput,
): Promise<CreateFoodDayMutationResult> {
  // Revalidate internal callers too; never fingerprint an unchecked command.
  const command = parseCreateFoodDayCommand(input.command);
  const identity = deriveMutationIdentity({
    trustedUserId: input.trustedUserId,
    action: "CREATE_FOOD_DAY",
    idempotencyKey: input.idempotencyKey,
    semanticPayload: { ...command, status: "OPEN", completeness: "UNKNOWN" },
  });
  const result = await createFoodDayExactlyOnce(
    dependencies.transactionRunner,
    {
      userId: input.trustedUserId,
      operationId: randomUUID(),
      ...identity,
      foodDay: createFoodDay({
        id: randomUUID(),
        status: "OPEN",
        calorieTarget: command.calorieTarget,
        proteinTarget: command.proteinTarget,
      }),
      completeness: "UNKNOWN",
      ...(command.localDate === null ? {} : { localDate: command.localDate }),
      ...(command.timezone === null ? {} : { timezone: command.timezone }),
    },
  );
  return {
    disposition: result.disposition,
    foodDay: toFoodDayDto(result.foodDay),
  };
}

function parseTarget(value: unknown): string {
  // Bound plain decimal text before normalization; exponent expansion is not an HTTP feature.
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^\d+(?:\.\d+)?$/.test(value.trim())
  ) {
    throw new InvalidCreateFoodDayCommandError();
  }
  try {
    return normalizeDecimal(value);
  } catch (error) {
    if (error instanceof DomainValidationError)
      throw new InvalidCreateFoodDayCommandError();
    throw error;
  }
}

function isLocalDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length !== 10 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  )
    return false;
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
