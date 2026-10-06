import type {
  JsonObject,
  PersistedBodyWeightEntry,
  PersistedSemanticOperation,
} from "../types.js";
import { PostgresBodyWeightRepository } from "./body-weight-repository.js";
import {
  PostgresSemanticOperationRepository,
  SemanticOperationStateConflictError,
} from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";

export interface CreateBodyWeightExactlyOnceInput {
  readonly userId: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly entry: PersistedBodyWeightEntry["entry"];
}

export interface CreateBodyWeightExactlyOnceResult {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly weightEntry: PersistedBodyWeightEntry;
  readonly operation: PersistedSemanticOperation;
}

export class CreateBodyWeightIntegrityError extends Error {
  override readonly name = "CreateBodyWeightIntegrityError";

  constructor(readonly reason: "MALFORMED_RESULT" | "ENTRY_NOT_FOUND") {
    super("Succeeded body-weight operation has an invalid persisted result.");
  }
}

export async function createBodyWeightExactlyOnce(
  transactionRunner: PostgresTransactionRunner,
  input: CreateBodyWeightExactlyOnceInput,
): Promise<CreateBodyWeightExactlyOnceResult> {
  return transactionRunner.runInTransaction(async (executor) => {
    const operations = new PostgresSemanticOperationRepository(executor);
    const entries = new PostgresBodyWeightRepository(executor);
    const claim = await operations.claim({
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
    });
    if (claim.disposition === "EXISTING") {
      const operation = claim.operation;
      if (operation.status !== "SUCCEEDED") {
        throw new SemanticOperationStateConflictError(
          operation.operationKey,
          operation.status,
        );
      }
      const entryId = parseCreatedResult(operation.result);
      const weightEntry = await entries.findById(input.userId, entryId);
      if (weightEntry === null) {
        throw new CreateBodyWeightIntegrityError("ENTRY_NOT_FOUND");
      }
      return { disposition: "REPLAYED", weightEntry, operation };
    }

    const weightEntry = await entries.create({
      userId: input.userId,
      entry: input.entry,
    });
    const result = {
      kind: "BODY_WEIGHT_ENTRY_CREATED",
      entryId: weightEntry.entry.id,
    } as const satisfies JsonObject;
    const operation = await operations.markSucceeded({
      userId: input.userId,
      operationKey: input.operationKey,
      result,
    });
    return { disposition: "CREATED", weightEntry, operation };
  });
}

function parseCreatedResult(value: unknown): string {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("kind" in value) ||
    value.kind !== "BODY_WEIGHT_ENTRY_CREATED" ||
    !("entryId" in value) ||
    typeof value.entryId !== "string" ||
    value.entryId.trim() === ""
  ) {
    throw new CreateBodyWeightIntegrityError("MALFORMED_RESULT");
  }
  return value.entryId;
}
