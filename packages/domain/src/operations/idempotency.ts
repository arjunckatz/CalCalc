import { z } from "zod";

import { DomainValidationError } from "../errors.js";

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT" as const;

  constructor(readonly operationId: string) {
    super(
      `Operation ${operationId} was already used with a different request.`,
    );
    this.name = "IdempotencyConflictError";
  }
}

export interface IdempotentExecution<Result> {
  readonly result: Result;
  readonly replayed: boolean;
}

const identifierSchema = z.string().trim().min(1);

/**
 * In-memory reference semantics only. A persistence milestone must enforce the
 * same operation-id/fingerprint uniqueness durably and transactionally in PostgreSQL.
 */
export class InMemoryIdempotencyStore<Result> {
  private readonly records = new Map<
    string,
    { readonly fingerprint: string; readonly result: Result }
  >();

  execute(
    operationId: string,
    fingerprint: string,
    operation: () => Result,
  ): IdempotentExecution<Result> {
    const parsedOperationId = parseIdentifier(operationId, "operationId");
    const parsedFingerprint = parseIdentifier(
      fingerprint,
      "request fingerprint",
    );
    const existing = this.records.get(parsedOperationId);

    if (existing !== undefined) {
      if (existing.fingerprint !== parsedFingerprint) {
        throw new IdempotencyConflictError(parsedOperationId);
      }
      return { result: cloneStoredResult(existing.result), replayed: true };
    }

    const result = operation();
    const stored = cloneStoredResult(result);
    this.records.set(parsedOperationId, {
      fingerprint: parsedFingerprint,
      result: stored,
    });
    return { result: cloneStoredResult(stored), replayed: false };
  }
}

function cloneStoredResult<Result>(result: Result): Result {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    throw new DomainValidationError(
      "Idempotency results must be JSON-serializable values.",
    );
  }
  return JSON.parse(serialized) as Result;
}

function parseIdentifier(value: string, label: string): string {
  const result = identifierSchema.safeParse(value);
  if (!result.success) {
    throw new DomainValidationError(`${label} must be a non-empty string.`);
  }
  return result.data;
}
