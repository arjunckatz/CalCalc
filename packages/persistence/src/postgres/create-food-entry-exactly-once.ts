import type { FoodEntry } from "@cal-calc/domain";

import type {
  ConsumedTimePrecision,
  JsonObject,
  PersistedFoodEntry,
  PersistedSemanticOperation,
} from "../types.js";
import { PostgresFoodEntryRepository } from "./food-entry-repository.js";
import {
  PostgresSemanticOperationRepository,
  SemanticOperationStateConflictError,
} from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";

export interface CreateFoodEntryExactlyOnceInput {
  readonly userId: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly entry: FoodEntry;
  readonly consumedAt?: string;
  readonly consumedTimePrecision?: ConsumedTimePrecision;
}

export type CreateFoodEntryExactlyOnceResult =
  | {
      readonly disposition: "CREATED";
      readonly entry: PersistedFoodEntry;
      readonly operation: PersistedSemanticOperation;
    }
  | {
      readonly disposition: "REPLAYED";
      readonly entry: PersistedFoodEntry;
      readonly operation: PersistedSemanticOperation;
    };

export type CreateFoodEntryIntegrityReason =
  "MALFORMED_OPERATION_RESULT" | "REFERENCED_ENTRY_NOT_FOUND";

export class CreateFoodEntryIntegrityError extends Error {
  override readonly name = "CreateFoodEntryIntegrityError";

  constructor(
    readonly operationKey: string,
    readonly reason: CreateFoodEntryIntegrityReason,
  ) {
    super(
      reason === "MALFORMED_OPERATION_RESULT"
        ? `Succeeded semantic operation ${operationKey} has an invalid FoodEntry result.`
        : `Succeeded semantic operation ${operationKey} references no FoodEntry visible to this user.`,
    );
  }
}

export async function createFoodEntryExactlyOnce(
  transactionRunner: PostgresTransactionRunner,
  input: CreateFoodEntryExactlyOnceInput,
): Promise<CreateFoodEntryExactlyOnceResult> {
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

    const entry = await foodEntryRepository.create({
      userId: input.userId,
      entry: input.entry,
      ...(input.consumedAt === undefined
        ? {}
        : { consumedAt: input.consumedAt }),
      ...(input.consumedTimePrecision === undefined
        ? {}
        : { consumedTimePrecision: input.consumedTimePrecision }),
      lastOperationId: claim.operation.id,
    });
    const result = {
      kind: "FOOD_ENTRY_CREATED",
      entryId: entry.entry.id,
    } as const satisfies JsonObject;
    const completedAt = new Date().toISOString();
    const operation = await operationRepository.markSucceeded({
      userId: input.userId,
      operationKey: input.operationKey,
      result,
      completedAt,
    });

    return { disposition: "CREATED", entry, operation };
  });
}

async function replayExistingOperation(
  foodEntryRepository: PostgresFoodEntryRepository,
  userId: string,
  operation: PersistedSemanticOperation,
): Promise<CreateFoodEntryExactlyOnceResult> {
  if (operation.status !== "SUCCEEDED") {
    throw new SemanticOperationStateConflictError(
      operation.operationKey,
      operation.status,
    );
  }

  const entryId = parseCreatedFoodEntryResult(
    operation.operationKey,
    operation.result,
  );
  const entry = await foodEntryRepository.findById(userId, entryId);
  if (entry === null) {
    throw new CreateFoodEntryIntegrityError(
      operation.operationKey,
      "REFERENCED_ENTRY_NOT_FOUND",
    );
  }
  return { disposition: "REPLAYED", entry, operation };
}

function parseCreatedFoodEntryResult(
  operationKey: string,
  result: unknown,
): string {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("kind" in result) ||
    result.kind !== "FOOD_ENTRY_CREATED" ||
    !("entryId" in result) ||
    typeof result.entryId !== "string" ||
    result.entryId.trim() === ""
  ) {
    throw new CreateFoodEntryIntegrityError(
      operationKey,
      "MALFORMED_OPERATION_RESULT",
    );
  }
  return result.entryId;
}
