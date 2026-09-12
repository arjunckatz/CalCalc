import type { FoodEntry } from "@cal-calc/domain";

import type {
  JsonObject,
  PersistedFoodEntry,
  PersistedSemanticOperation,
} from "../types.js";
import {
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  PostgresFoodEntryRepository,
} from "./food-entry-repository.js";
import {
  PostgresSemanticOperationRepository,
  SemanticOperationStateConflictError,
} from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";

export interface UpdateFoodEntryExactlyOnceInput {
  readonly userId: string;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  /** Must synchronously apply one deterministic domain mutation. */
  readonly transform: (current: FoodEntry) => FoodEntry;
}

export type UpdateFoodEntryExactlyOnceResult =
  | {
      readonly disposition: "APPLIED";
      readonly entry: PersistedFoodEntry;
      readonly operation: PersistedSemanticOperation;
      readonly appliedRevision: number;
    }
  | {
      readonly disposition: "REPLAYED";
      readonly entry: PersistedFoodEntry;
      readonly operation: PersistedSemanticOperation;
      readonly appliedRevision: number;
    };

export type UpdateFoodEntryIntegrityReason =
  | "MALFORMED_OPERATION_RESULT"
  | "REFERENCED_ENTRY_NOT_FOUND"
  | "CURRENT_REVISION_BELOW_APPLIED"
  | "INVALID_TRANSFORM_RESULT";

export class UpdateFoodEntryIntegrityError extends Error {
  override readonly name = "UpdateFoodEntryIntegrityError";

  constructor(
    readonly operationKey: string,
    readonly reason: UpdateFoodEntryIntegrityReason,
  ) {
    const messages = {
      MALFORMED_OPERATION_RESULT: "has an invalid FoodEntry update result",
      REFERENCED_ENTRY_NOT_FOUND:
        "references no FoodEntry visible to this user",
      CURRENT_REVISION_BELOW_APPLIED:
        "records an applied revision beyond the current FoodEntry revision",
      INVALID_TRANSFORM_RESULT:
        "produced a FoodEntry with an invalid identity or revision transition",
    };
    super(
      reason === "INVALID_TRANSFORM_RESULT"
        ? `Semantic operation ${operationKey} ${messages[reason]}.`
        : `Succeeded semantic operation ${operationKey} ${messages[reason]}.`,
    );
  }
}

export async function updateFoodEntryExactlyOnce(
  transactionRunner: PostgresTransactionRunner,
  input: UpdateFoodEntryExactlyOnceInput,
): Promise<UpdateFoodEntryExactlyOnceResult> {
  return transactionRunner.runInTransaction(async (executor) => {
    const operationRepository = new PostgresSemanticOperationRepository(
      executor,
    );
    const foodEntryRepository = new PostgresFoodEntryRepository(executor);
    const claim = await operationRepository.claim({
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
    });

    if (claim.disposition === "EXISTING") {
      return replayExistingOperation(
        foodEntryRepository,
        input.userId,
        claim.operation,
      );
    }

    const current = await foodEntryRepository.findById(
      input.userId,
      input.entryId,
    );
    if (current === null) {
      throw new FoodEntryNotFoundError(input.entryId);
    }
    const currentRevision = current.entry.revision;
    if (currentRevision !== input.expectedRevision) {
      throw new FoodEntryRevisionConflictError(
        input.entryId,
        input.expectedRevision,
        currentRevision,
      );
    }
    const transformed = input.transform(current.entry);
    if (
      transformed === null ||
      typeof transformed !== "object" ||
      transformed.id !== input.entryId ||
      !Number.isSafeInteger(transformed.revision) ||
      transformed.revision !== currentRevision + 1
    ) {
      throw new UpdateFoodEntryIntegrityError(
        input.operationKey,
        "INVALID_TRANSFORM_RESULT",
      );
    }

    const entry = await foodEntryRepository.update({
      userId: input.userId,
      expectedRevision: input.expectedRevision,
      entry: transformed,
      lastOperationId: claim.operation.id,
    });
    const appliedRevision = entry.entry.revision;
    const result = {
      kind: "FOOD_ENTRY_UPDATED",
      entryId: entry.entry.id,
      appliedRevision,
    } as const satisfies JsonObject;
    const completedAt = new Date().toISOString();
    const operation = await operationRepository.markSucceeded({
      userId: input.userId,
      operationKey: input.operationKey,
      result,
      completedAt,
    });
    return { disposition: "APPLIED", entry, operation, appliedRevision };
  });
}

async function replayExistingOperation(
  foodEntryRepository: PostgresFoodEntryRepository,
  userId: string,
  operation: PersistedSemanticOperation,
): Promise<UpdateFoodEntryExactlyOnceResult> {
  if (operation.status !== "SUCCEEDED") {
    throw new SemanticOperationStateConflictError(
      operation.operationKey,
      operation.status,
    );
  }

  const { entryId, appliedRevision } = parseUpdatedFoodEntryResult(
    operation.operationKey,
    operation.result,
  );
  const entry = await foodEntryRepository.findById(userId, entryId);
  if (entry === null) {
    throw new UpdateFoodEntryIntegrityError(
      operation.operationKey,
      "REFERENCED_ENTRY_NOT_FOUND",
    );
  }
  if (entry.entry.revision < appliedRevision) {
    throw new UpdateFoodEntryIntegrityError(
      operation.operationKey,
      "CURRENT_REVISION_BELOW_APPLIED",
    );
  }
  return { disposition: "REPLAYED", entry, operation, appliedRevision };
}

function parseUpdatedFoodEntryResult(
  operationKey: string,
  result: unknown,
): { readonly entryId: string; readonly appliedRevision: number } {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("kind" in result) ||
    result.kind !== "FOOD_ENTRY_UPDATED" ||
    !("entryId" in result) ||
    typeof result.entryId !== "string" ||
    result.entryId.trim() === "" ||
    !("appliedRevision" in result) ||
    typeof result.appliedRevision !== "number" ||
    !Number.isSafeInteger(result.appliedRevision) ||
    result.appliedRevision < 2
  ) {
    throw new UpdateFoodEntryIntegrityError(
      operationKey,
      "MALFORMED_OPERATION_RESULT",
    );
  }
  return { entryId: result.entryId, appliedRevision: result.appliedRevision };
}
