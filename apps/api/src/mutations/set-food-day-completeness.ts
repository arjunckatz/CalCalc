import { randomUUID } from "node:crypto";

import { DomainValidationError } from "@cal-calc/domain";
import {
  foodDayCompletenessValues,
  setFoodDayCompletenessExactlyOnce,
  type FoodDayCompleteness,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";

import {
  deriveMutationIdentity,
  type IdempotencyKey,
  type MutationOperationScope,
} from "./mutation-identity.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SetFoodDayCompletenessCommand {
  readonly expectedCompleteness: FoodDayCompleteness;
  readonly targetCompleteness: FoodDayCompleteness;
}

export interface SetFoodDayCompletenessMutationInput {
  readonly trustedUserId: string;
  readonly trustedFoodDayId: string;
  readonly idempotencyKey: IdempotencyKey;
  /** Trusted application context, not part of the command. */
  readonly operationScope?: MutationOperationScope;
  readonly command: SetFoodDayCompletenessCommand;
}

export interface SetFoodDayCompletenessMutationResult {
  readonly disposition: "APPLIED" | "REPLAYED";
  readonly foodDayId: string;
  /** Current canonical value, including on replay after later changes. */
  readonly completeness: FoodDayCompleteness;
}

/** Provider-neutral command; the expected value is a concurrency precondition. */
export async function setFoodDayCompletenessMutation(
  dependencies: { readonly transactionRunner: PostgresTransactionRunner },
  input: SetFoodDayCompletenessMutationInput,
): Promise<SetFoodDayCompletenessMutationResult> {
  const command = parseCommand(input.command);
  if (
    typeof input.trustedFoodDayId !== "string" ||
    !uuidPattern.test(input.trustedFoodDayId)
  ) {
    throw new DomainValidationError("Invalid trusted FoodDay scope.");
  }
  const foodDayId = input.trustedFoodDayId.toLowerCase();
  const identity = deriveMutationIdentity({
    trustedUserId: input.trustedUserId,
    action: "SET_FOOD_DAY_COMPLETENESS",
    idempotencyKey: input.idempotencyKey,
    ...(input.operationScope === undefined
      ? {}
      : { operationScope: input.operationScope }),
    semanticPayload: { foodDayId, ...command },
  });
  const result = await setFoodDayCompletenessExactlyOnce(
    dependencies.transactionRunner,
    {
      userId: input.trustedUserId,
      foodDayId,
      ...command,
      operationId: randomUUID(),
      ...identity,
    },
  );
  return {
    disposition: result.disposition,
    foodDayId: result.foodDay.foodDay.id,
    completeness: result.foodDay.completeness,
  };
}

function parseCommand(value: unknown): SetFoodDayCompletenessCommand {
  if (
    value === null ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidCommand();
  }
  const fields = ["expectedCompleteness", "targetCompleteness"];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !fields.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidCommand();
    }
  }
  const command = value as Record<string, unknown>;
  if (
    !isCompleteness(command.expectedCompleteness) ||
    !isCompleteness(command.targetCompleteness)
  ) {
    throw invalidCommand();
  }
  return {
    expectedCompleteness: command.expectedCompleteness,
    targetCompleteness: command.targetCompleteness,
  };
}

function isCompleteness(value: unknown): value is FoodDayCompleteness {
  return (
    typeof value === "string" &&
    foodDayCompletenessValues.includes(value as FoodDayCompleteness)
  );
}

function invalidCommand(): DomainValidationError {
  return new DomainValidationError("Invalid FoodDay completeness command.");
}
