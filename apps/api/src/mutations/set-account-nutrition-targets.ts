import { randomUUID } from "node:crypto";

import { DomainValidationError, normalizeDecimal } from "@cal-calc/domain";
import {
  setAccountNutritionTargetsExactlyOnce,
  type AccountNutritionTargets,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";

import {
  deriveMutationIdentity,
  type IdempotencyKey,
} from "./mutation-identity.js";

export interface SetAccountNutritionTargetsCommand {
  /** Null requires no existing row; otherwise the current version must match. */
  readonly expectedVersion: number | null;
  readonly calorieTarget: string;
  readonly proteinTarget: string;
}

export interface SetAccountNutritionTargetsMutationInput {
  readonly trustedUserId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly command: SetAccountNutritionTargetsCommand;
}

export interface SetAccountNutritionTargetsMutationResult {
  readonly disposition: "APPLIED" | "REPLAYED";
  /** Stable result of this operation, even after later target changes. */
  readonly targets: AccountNutritionTargets;
}

export class InvalidSetAccountNutritionTargetsCommandError extends Error {
  override readonly name = "InvalidSetAccountNutritionTargetsCommandError";

  constructor() {
    super("Invalid account nutrition target command.");
  }
}

/** Explicit account configuration; never sourced from a FoodDay or conversation. */
export async function setAccountNutritionTargetsMutation(
  dependencies: { readonly transactionRunner: PostgresTransactionRunner },
  input: SetAccountNutritionTargetsMutationInput,
): Promise<SetAccountNutritionTargetsMutationResult> {
  const command = parseSetAccountNutritionTargetsCommand(input.command);
  const identity = deriveMutationIdentity({
    trustedUserId: input.trustedUserId,
    action: "SET_ACCOUNT_NUTRITION_TARGETS",
    idempotencyKey: input.idempotencyKey,
    semanticPayload: {
      expectedVersion: command.expectedVersion,
      calorieTarget: command.calorieTarget,
      proteinTarget: command.proteinTarget,
    },
  });
  const result = await setAccountNutritionTargetsExactlyOnce(
    dependencies.transactionRunner,
    {
      userId: input.trustedUserId,
      operationId: randomUUID(),
      ...identity,
      ...command,
    },
  );
  return { disposition: result.disposition, targets: result.targets };
}

/** Strict application boundary and the same plain-decimal acceptance as FoodDay create. */
export function parseSetAccountNutritionTargetsCommand(
  value: unknown,
): SetAccountNutritionTargetsCommand {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== 3
  ) {
    throw new InvalidSetAccountNutritionTargetsCommandError();
  }
  const fields = ["expectedVersion", "calorieTarget", "proteinTarget"];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !fields.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new InvalidSetAccountNutritionTargetsCommandError();
    }
  }
  const command = value as Record<string, unknown>;
  if (
    command.expectedVersion !== null &&
    (!Number.isSafeInteger(command.expectedVersion) ||
      (command.expectedVersion as number) < 0 ||
      (command.expectedVersion as number) > 2_147_483_647)
  ) {
    throw new InvalidSetAccountNutritionTargetsCommandError();
  }
  return {
    expectedVersion: command.expectedVersion as number | null,
    calorieTarget: parseTarget(command.calorieTarget),
    proteinTarget: parseTarget(command.proteinTarget),
  };
}

function parseTarget(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^\d+(?:\.\d+)?$/.test(value.trim())
  ) {
    throw new InvalidSetAccountNutritionTargetsCommandError();
  }
  try {
    return normalizeDecimal(value);
  } catch (error) {
    if (error instanceof DomainValidationError)
      throw new InvalidSetAccountNutritionTargetsCommandError();
    throw error;
  }
}
