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
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  updateFoodEntryExactlyOnce,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";

import {
  deriveMutationIdentity,
  type IdempotencyKey,
  type MutationOperationScope,
} from "./mutation-identity.js";
import { sameUuid } from "./same-uuid.js";

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
  /** Trusted application context only; never supplied by model or HTTP command. */
  readonly operationScope?: MutationOperationScope;
  /** Optional canonical-entry FoodDay constraint from trusted application context. */
  readonly trustedFoodDayId?: string;
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
  validateTrustedFoodDayScope(input.operationScope, input.trustedFoodDayId);
  const identity = deriveMutationIdentity({
    trustedUserId: input.trustedUserId,
    action: "UPDATE_FOOD_ENTRY",
    idempotencyKey: input.idempotencyKey,
    ...(input.operationScope === undefined
      ? {}
      : { operationScope: input.operationScope }),
    semanticPayload: {
      entryId: command.entryId,
      expectedRevision: command.expectedRevision,
      quantity: { ...command.quantity },
      overrideAction: semanticOverrideAction(command.overrideAction),
      ...(input.trustedFoodDayId === undefined
        ? {}
        : { trustedFoodDayId: input.trustedFoodDayId }),
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
      ...(input.trustedFoodDayId === undefined
        ? {}
        : {
            validateCurrent(current: FoodEntry) {
              if (!sameUuid(current.foodDayId, input.trustedFoodDayId)) {
                throw new FoodEntryNotFoundError(command.entryId);
              }
            },
          }),
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

function validateTrustedFoodDayScope(
  operationScope: MutationOperationScope | undefined,
  trustedFoodDayId: string | undefined,
): void {
  if (
    (operationScope === "FOOD_DAY_TURN_TOOL" &&
      trustedFoodDayId === undefined) ||
    (trustedFoodDayId !== undefined &&
      (typeof trustedFoodDayId !== "string" || trustedFoodDayId.trim() === ""))
  ) {
    throw new DomainValidationError("Invalid trusted FoodDay scope.");
  }
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
