import type {
  JsonObject,
  PersistedSemanticOperation,
  SemanticOperationRow,
  SemanticOperationStatus,
} from "../types.js";
import type { PostgresExecutor } from "./food-entry-repository.js";

export interface ClaimSemanticOperationInput {
  readonly id: string;
  readonly userId: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
}

export type SemanticOperationClaim =
  | {
      readonly disposition: "CREATED";
      readonly operation: PersistedSemanticOperation;
    }
  | {
      readonly disposition: "EXISTING";
      readonly operation: PersistedSemanticOperation;
    };

export interface CompleteSemanticOperationInput {
  readonly userId: string;
  readonly operationKey: string;
  readonly completedAt: string;
}

export interface MarkSemanticOperationSucceededInput extends CompleteSemanticOperationInput {
  readonly result: JsonObject;
}

export interface MarkSemanticOperationFailedInput extends CompleteSemanticOperationInput {
  readonly error: JsonObject;
}

export class SemanticOperationNotFoundError extends Error {
  override readonly name = "SemanticOperationNotFoundError";

  constructor(readonly operationKey: string) {
    super(`Semantic operation ${operationKey} was not found for this user.`);
  }
}

export class SemanticOperationIdempotencyConflictError extends Error {
  override readonly name = "SemanticOperationIdempotencyConflictError";

  constructor(
    readonly operationKey: string,
    readonly existingFingerprint: string,
    readonly suppliedFingerprint: string,
  ) {
    super(
      `Semantic operation ${operationKey} already exists with a different request fingerprint.`,
    );
  }
}

export class SemanticOperationStateConflictError extends Error {
  override readonly name = "SemanticOperationStateConflictError";

  constructor(
    readonly operationKey: string,
    readonly actualStatus: SemanticOperationStatus,
  ) {
    super(
      `Semantic operation ${operationKey} cannot be completed from status ${actualStatus}.`,
    );
  }
}

export class PostgresSemanticOperationRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  async claim(
    input: ClaimSemanticOperationInput,
  ): Promise<SemanticOperationClaim> {
    const inserted = await this.executor.query(
      `insert into public.semantic_operations (
         id,
         user_id,
         operation_key,
         request_fingerprint
       ) values ($1, $2, $3, $4)
       on conflict (user_id, operation_key) do nothing
       returning ${semanticOperationResultColumns}`,
      [input.id, input.userId, input.operationKey, input.requestFingerprint],
    );
    const insertedRow = firstRow<SemanticOperationRow>(inserted.rows);
    if (insertedRow !== undefined) {
      return {
        disposition: "CREATED",
        operation: fromSemanticOperationRow(insertedRow),
      };
    }

    const existing = await this.findByKey(input.userId, input.operationKey);
    if (existing === null) {
      throw new SemanticOperationNotFoundError(input.operationKey);
    }
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new SemanticOperationIdempotencyConflictError(
        input.operationKey,
        existing.requestFingerprint,
        input.requestFingerprint,
      );
    }
    return { disposition: "EXISTING", operation: existing };
  }

  async findByKey(
    userId: string,
    operationKey: string,
  ): Promise<PersistedSemanticOperation | null> {
    const result = await this.executor.query(
      `select ${semanticOperationResultColumns}
       from public.semantic_operations
       where user_id = $1
         and operation_key = $2`,
      [userId, operationKey],
    );
    const row = firstRow<SemanticOperationRow>(result.rows);
    return row === undefined ? null : fromSemanticOperationRow(row);
  }

  async markSucceeded(
    input: MarkSemanticOperationSucceededInput,
  ): Promise<PersistedSemanticOperation> {
    assertJsonObject(input.result, "result");
    const result = await this.executor.query(
      `update public.semantic_operations
       set status = 'SUCCEEDED',
           result = $3,
           completed_at = $4
       where user_id = $1
         and operation_key = $2
         and status = 'PENDING'
       returning ${semanticOperationResultColumns}`,
      [input.userId, input.operationKey, input.result, input.completedAt],
    );
    return this.resolveCompletion(input, result.rows);
  }

  async markFailed(
    input: MarkSemanticOperationFailedInput,
  ): Promise<PersistedSemanticOperation> {
    assertJsonObject(input.error, "error");
    const result = await this.executor.query(
      `update public.semantic_operations
       set status = 'FAILED',
           error = $3,
           completed_at = $4
       where user_id = $1
         and operation_key = $2
         and status = 'PENDING'
       returning ${semanticOperationResultColumns}`,
      [input.userId, input.operationKey, input.error, input.completedAt],
    );
    return this.resolveCompletion(input, result.rows);
  }

  private async resolveCompletion(
    input: CompleteSemanticOperationInput,
    rows: readonly unknown[],
  ): Promise<PersistedSemanticOperation> {
    const row = firstRow<SemanticOperationRow>(rows);
    if (row !== undefined) return fromSemanticOperationRow(row);

    const existing = await this.findByKey(input.userId, input.operationKey);
    if (existing === null) {
      throw new SemanticOperationNotFoundError(input.operationKey);
    }
    throw new SemanticOperationStateConflictError(
      input.operationKey,
      existing.status,
    );
  }
}

const semanticOperationResultColumns = `
  id,
  user_id,
  operation_key,
  request_fingerprint,
  status,
  result,
  error,
  to_jsonb(created_at) #>> '{}' as created_at,
  to_jsonb(updated_at) #>> '{}' as updated_at,
  to_jsonb(completed_at) #>> '{}' as completed_at
`;

function fromSemanticOperationRow(
  row: SemanticOperationRow,
): PersistedSemanticOperation {
  return {
    id: row.id,
    userId: row.user_id,
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function assertJsonObject(value: JsonObject, label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  try {
    JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (
        nestedValue === undefined ||
        typeof nestedValue === "bigint" ||
        typeof nestedValue === "function" ||
        typeof nestedValue === "symbol" ||
        (typeof nestedValue === "number" && !Number.isFinite(nestedValue))
      ) {
        throw new TypeError(`${label} must contain only JSON values.`);
      }
      return nestedValue;
    });
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(`${label} `)) {
      throw error;
    }
    throw new TypeError(`${label} must be a JSON-compatible object.`, {
      cause: error,
    });
  }
}

function firstRow<Row>(rows: readonly unknown[]): Row | undefined {
  return rows[0] as Row | undefined;
}
