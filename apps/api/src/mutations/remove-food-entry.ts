import { randomUUID } from "node:crypto";

import {
  deleteFoodEntry,
  DomainValidationError,
  type FoodEntry,
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

export interface RemoveFoodEntryCommand {
  readonly entryId: string;
  readonly expectedRevision: number;
}

export interface RemoveFoodEntryMutationInput {
  readonly trustedUserId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly command: RemoveFoodEntryCommand;
}

export interface RemoveFoodEntryMutationResult {
  readonly disposition: "APPLIED" | "REPLAYED";
  readonly entry: FoodEntry;
  readonly appliedRevision: number;
}

export async function removeFoodEntryMutation(
  dependencies: { readonly transactionRunner: PostgresTransactionRunner },
  input: RemoveFoodEntryMutationInput,
): Promise<RemoveFoodEntryMutationResult> {
  const command = normalizeCommand(input.command);
  const identity = deriveMutationIdentity({
    trustedUserId: input.trustedUserId,
    action: "REMOVE_FOOD_ENTRY",
    idempotencyKey: input.idempotencyKey,
    semanticPayload: {
      entryId: command.entryId,
      expectedRevision: command.expectedRevision,
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
        const removal = deleteFoodEntry(current, {
          expectedRevision: command.expectedRevision,
          deletedAt: new Date().toISOString(),
        });
        if (!removal.ok) {
          throw new FoodEntryRevisionConflictError(
            removal.error.entryId,
            removal.error.expectedRevision,
            removal.error.actualRevision,
          );
        }
        return removal.value;
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
  command: RemoveFoodEntryCommand,
): RemoveFoodEntryCommand {
  if (
    command === null ||
    typeof command !== "object" ||
    (Object.getPrototypeOf(command) !== Object.prototype &&
      Object.getPrototypeOf(command) !== null)
  ) {
    throw invalidCommand();
  }
  const allowed = ["entryId", "expectedRevision"];
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
  if (typeof command.entryId !== "string" || command.entryId.trim() === "") {
    throw invalidCommand();
  }
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1
  ) {
    throw invalidCommand();
  }
  return {
    entryId: command.entryId.trim(),
    expectedRevision: command.expectedRevision,
  };
}

function invalidCommand(): DomainValidationError {
  return new DomainValidationError("Invalid FoodEntry removal command.");
}
