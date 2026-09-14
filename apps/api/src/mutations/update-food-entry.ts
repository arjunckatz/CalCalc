import { randomUUID } from "node:crypto";

import {
  DomainValidationError,
  parseNutritionOverride,
  parseQuantity,
  updateFoodEntryQuantity,
  type FoodEntry,
  type Quantity,
  type QuantityOverrideAction,
} from "@cal-calc/domain";
import {
  FoodEntryRevisionConflictError,
  updateFoodEntryExactlyOnce,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";

import {
  deriveMutationIdentity,
  type IdempotencyKey,
} from "./mutation-identity.js";

export interface UpdateFoodEntryCommand {
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly quantity: Quantity;
  readonly overrideAction: QuantityOverrideAction;
}

export interface UpdateFoodEntryMutationInput {
  /** Verified application identity, never caller-supplied ownership. */
  readonly trustedUserId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly command: UpdateFoodEntryCommand;
}

export interface UpdateFoodEntryMutationResult {
  readonly disposition: "APPLIED" | "REPLAYED";
  readonly entry: FoodEntry;
  readonly appliedRevision: number;
}

export async function updateFoodEntryMutation(
  dependencies: { readonly transactionRunner: PostgresTransactionRunner },
  input: UpdateFoodEntryMutationInput,
): Promise<UpdateFoodEntryMutationResult> {
  const command = normalizeCommand(input.command);
  const identity = deriveMutationIdentity({
    trustedUserId: input.trustedUserId,
    action: "UPDATE_FOOD_ENTRY",
    idempotencyKey: input.idempotencyKey,
    semanticPayload: {
      entryId: command.entryId,
      expectedRevision: command.expectedRevision,
      quantity: { ...command.quantity },
      overrideAction: semanticOverrideAction(command.overrideAction),
    },
  });
  const result = await updateFoodEntryExactlyOnce(
    dependencies.transactionRunner,
    {
      userId: input.trustedUserId,
      entryId: command.entryId,
      expectedRevision: command.expectedRevision,
      operationId: randomUUID(),
      ...identity,
      transform(current) {
        const correction = updateFoodEntryQuantity(current, {
          expectedRevision: command.expectedRevision,
          quantity: command.quantity,
          overrideAction: command.overrideAction,
        });
        if (!correction.ok) {
          throw new FoodEntryRevisionConflictError(
            correction.error.entryId,
            correction.error.expectedRevision,
            correction.error.actualRevision,
          );
        }
        return correction.value;
      },
    },
  );
  return {
    disposition: result.disposition,
    entry: result.entry.entry,
    appliedRevision: result.appliedRevision,
  };
}

function normalizeCommand(
  command: UpdateFoodEntryCommand,
): UpdateFoodEntryCommand {
  checkFields(command, [
    "entryId",
    "expectedRevision",
    "quantity",
    "overrideAction",
  ]);
  if (typeof command.entryId !== "string" || command.entryId.trim() === "") {
    throw invalidCommand();
  }
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1
  ) {
    throw invalidCommand();
  }
  checkFields(command.quantity, ["amount", "unit"]);
  const quantity = parseQuantity(command.quantity);
  const overrideAction = normalizeOverrideAction(command.overrideAction);
  return {
    entryId: command.entryId.trim(),
    expectedRevision: command.expectedRevision,
    quantity,
    overrideAction,
  };
}

function normalizeOverrideAction(
  value: QuantityOverrideAction,
): QuantityOverrideAction {
  checkFields(value, ["type", "override"]);
  if (value.type === "PRESERVE" || value.type === "CLEAR") {
    checkFields(value, ["type"]);
    return { type: value.type };
  }
  if (value.type !== "REPLACE") throw invalidCommand();
  checkFields(value, ["type", "override"]);
  checkFields(value.override, [
    "calories",
    "protein",
    "carbs",
    "fat",
    "fibre",
    "sodium",
  ]);
  return { type: "REPLACE", override: parseNutritionOverride(value.override) };
}

function semanticOverrideAction(value: QuantityOverrideAction) {
  return value.type === "REPLACE"
    ? { type: value.type, override: { ...value.override } }
    : { type: value.type };
}

function checkFields(value: unknown, allowed: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidCommand();
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidCommand();
    }
  }
}

function invalidCommand(): DomainValidationError {
  return new DomainValidationError("Invalid FoodEntry update command.");
}
