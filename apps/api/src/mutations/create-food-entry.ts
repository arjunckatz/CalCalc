import { randomUUID } from "node:crypto";

import {
  createFoodEntry,
  DomainValidationError,
  type EvidenceClass,
  type FoodEntry,
  type NutritionBasis,
  type Quantity,
} from "@cal-calc/domain";
import {
  createFoodEntryExactlyOnce,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";

import {
  deriveMutationIdentity,
  type IdempotencyKey,
} from "./mutation-identity.js";

export interface CreateFoodEntryCommand {
  readonly foodDayId: string;
  readonly rawUserDescription: string;
  readonly displayName: string;
  readonly quantity: Quantity;
  readonly nutritionBasis: NutritionBasis;
  readonly evidenceClass: EvidenceClass;
}

export interface CreateFoodEntryMutationInput {
  /** Verified application identity, never request-supplied ownership. */
  readonly trustedUserId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly command: CreateFoodEntryCommand;
}

export interface CreateFoodEntryMutationResult {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly entry: FoodEntry;
}

export async function createFoodEntryMutation(
  dependencies: { readonly transactionRunner: PostgresTransactionRunner },
  input: CreateFoodEntryMutationInput,
): Promise<CreateFoodEntryMutationResult> {
  const command = input.command;
  // Reject ignored caller fields; domain helpers own validation and normalization.
  checkFields(command, [
    "foodDayId",
    "rawUserDescription",
    "displayName",
    "quantity",
    "nutritionBasis",
    "evidenceClass",
  ]);
  checkFields(command.quantity, ["amount", "unit"]);
  checkFields(command.nutritionBasis, ["amount", "unit", "nutrition"]);
  checkFields(command.nutritionBasis.nutrition, [
    "calories",
    "protein",
    "carbs",
    "fat",
    "fibre",
    "sodium",
  ]);
  const entry = createFoodEntry({
    id: randomUUID(),
    foodDayId: command.foodDayId,
    rawUserDescription: command.rawUserDescription,
    displayName: command.displayName,
    quantity: command.quantity,
    nutritionBasis: command.nutritionBasis,
    evidenceClass: command.evidenceClass,
    status: "CONFIRMED_CONSUMED",
  });
  const identity = deriveMutationIdentity({
    trustedUserId: input.trustedUserId,
    action: "CREATE_FOOD_ENTRY",
    idempotencyKey: input.idempotencyKey,
    semanticPayload: {
      foodDayId: entry.foodDayId,
      rawUserDescription: entry.rawUserDescription,
      displayName: entry.displayName,
      quantity: { ...entry.quantity },
      nutritionBasis: {
        amount: entry.nutritionBasis.amount,
        unit: entry.nutritionBasis.unit,
        nutrition: { ...entry.nutritionBasis.nutrition },
      },
      evidenceClass: entry.evidenceClass,
      status: entry.status,
    },
  });
  const result = await createFoodEntryExactlyOnce(
    dependencies.transactionRunner,
    {
      userId: input.trustedUserId,
      operationId: randomUUID(),
      ...identity,
      entry,
    },
  );
  return { disposition: result.disposition, entry: result.entry.entry };
}

function checkFields(value: unknown, allowed: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new DomainValidationError("Invalid FoodEntry creation command.");
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new DomainValidationError("Invalid FoodEntry creation command.");
    }
  }
}
