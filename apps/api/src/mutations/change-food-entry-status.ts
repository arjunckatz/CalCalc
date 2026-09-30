import { randomUUID } from "node:crypto";

import {
  changeFoodEntryStatus,
  DomainValidationError,
  foodEntryStatuses,
  type FoodEntry,
  type FoodEntryStatus,
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

export interface ChangeFoodEntryStatusCommand {
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly status: FoodEntryStatus;
}

export interface ChangeFoodEntryStatusMutationInput {
  readonly trustedUserId: string;
  readonly idempotencyKey: IdempotencyKey;
  /** Trusted application context only, never part of the caller's command. */
  readonly operationScope?: MutationOperationScope;
  readonly trustedFoodDayId?: string;
  readonly command: ChangeFoodEntryStatusCommand;
}

export interface ChangeFoodEntryStatusMutationResult {
  readonly disposition: "APPLIED" | "REPLAYED";
  readonly entry: FoodEntry;
  readonly appliedRevision: number;
}

export async function changeFoodEntryStatusMutation(
  dependencies: { readonly transactionRunner: PostgresTransactionRunner },
  input: ChangeFoodEntryStatusMutationInput,
): Promise<ChangeFoodEntryStatusMutationResult> {
  const command = normalizeCommand(input.command);
  validateTrustedFoodDayScope(input.operationScope, input.trustedFoodDayId);
  const identity = deriveMutationIdentity({
    trustedUserId: input.trustedUserId,
    action: "CHANGE_FOOD_ENTRY_STATUS",
    idempotencyKey: input.idempotencyKey,
    ...(input.operationScope === undefined
      ? {}
      : { operationScope: input.operationScope }),
    semanticPayload: {
      entryId: command.entryId,
      expectedRevision: command.expectedRevision,
      status: command.status,
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
        const changed = changeFoodEntryStatus(current, {
          expectedRevision: command.expectedRevision,
          status: command.status,
        });
        if (!changed.ok) {
          throw new FoodEntryRevisionConflictError(
            changed.error.entryId,
            changed.error.expectedRevision,
            changed.error.actualRevision,
          );
        }
        return changed.value;
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
  command: ChangeFoodEntryStatusCommand,
): ChangeFoodEntryStatusCommand {
  if (
    command === null ||
    typeof command !== "object" ||
    (Object.getPrototypeOf(command) !== Object.prototype &&
      Object.getPrototypeOf(command) !== null)
  ) {
    throw invalidCommand();
  }
  const allowed = ["entryId", "expectedRevision", "status"];
  for (const key of Reflect.ownKeys(command)) {
    const descriptor = Object.getOwnPropertyDescriptor(command, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalidCommand();
    }
  }
  if (
    typeof command.entryId !== "string" ||
    command.entryId.trim() === "" ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1 ||
    typeof command.status !== "string" ||
    !(foodEntryStatuses as readonly string[]).includes(command.status)
  ) {
    throw invalidCommand();
  }
  return {
    entryId: command.entryId.trim(),
    expectedRevision: command.expectedRevision,
    status: command.status,
  };
}

function invalidCommand(): DomainValidationError {
  return new DomainValidationError("Invalid FoodEntry status command.");
}
