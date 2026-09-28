import type {
  FoodDayTurnResultRow,
  PersistedFoodDayTurnResult,
} from "../types.js";
import type { PostgresExecutor } from "./food-entry-repository.js";

export interface FindCompletedFoodDayTurnInput {
  readonly userId: string;
  readonly foodDayId: string;
  readonly turnKey: string;
  readonly requestFingerprint: string;
}

export interface SaveCompletedFoodDayTurnInput extends FindCompletedFoodDayTurnInput {
  readonly id: string;
  readonly userMessage: string;
  readonly response: string;
}

export type CompletedFoodDayTurnSave =
  | {
      readonly disposition: "CREATED";
      readonly turn: PersistedFoodDayTurnResult;
    }
  | {
      readonly disposition: "EXISTING";
      readonly turn: PersistedFoodDayTurnResult;
    };

export interface CompletedFoodDayTurnStore {
  findCompleted(
    input: FindCompletedFoodDayTurnInput,
  ): Promise<PersistedFoodDayTurnResult | null>;
  saveCompleted(
    input: SaveCompletedFoodDayTurnInput,
  ): Promise<CompletedFoodDayTurnSave>;
}

export class FoodDayTurnIdempotencyConflictError extends Error {
  override readonly name = "FoodDayTurnIdempotencyConflictError";

  constructor(
    readonly turnKey: string,
    readonly existingFingerprint: string,
    readonly suppliedFingerprint: string,
  ) {
    super(
      "This FoodDay turn idempotency key has already been used differently.",
    );
  }
}

export class CompletedFoodDayTurnPersistenceError extends Error {
  override readonly name = "CompletedFoodDayTurnPersistenceError";

  constructor() {
    super("PostgreSQL did not return the completed FoodDay turn result.");
  }
}

export class PostgresFoodDayTurnResultRepository implements CompletedFoodDayTurnStore {
  constructor(private readonly executor: PostgresExecutor) {}

  async findCompleted(
    input: FindCompletedFoodDayTurnInput,
  ): Promise<PersistedFoodDayTurnResult | null> {
    const existing = await this.findByKey(input.userId, input.turnKey);
    if (existing === null) return null;
    assertSameRequest(existing, input);
    return existing;
  }

  async saveCompleted(
    input: SaveCompletedFoodDayTurnInput,
  ): Promise<CompletedFoodDayTurnSave> {
    if (
      typeof input.userMessage !== "string" ||
      input.userMessage.trim() === ""
    ) {
      throw new TypeError(
        "Completed FoodDay turn user message must not be blank.",
      );
    }
    if (typeof input.response !== "string" || input.response.trim() === "") {
      throw new TypeError("Completed FoodDay turn response must not be blank.");
    }
    const inserted = await this.executor.query(
      `insert into public.food_day_turn_results (
         id,
         user_id,
         food_day_id,
         turn_key,
         request_fingerprint,
         user_message,
         response
       ) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (user_id, turn_key) do nothing
       returning ${foodDayTurnResultColumns}`,
      [
        input.id,
        input.userId,
        input.foodDayId,
        input.turnKey,
        input.requestFingerprint,
        input.userMessage,
        input.response,
      ],
    );
    const insertedRow = firstRow(inserted.rows);
    if (insertedRow !== undefined) {
      return {
        disposition: "CREATED",
        turn: fromFoodDayTurnResultRow(parseRow(insertedRow)),
      };
    }

    const existing = await this.findByKey(input.userId, input.turnKey);
    if (existing === null) throw new CompletedFoodDayTurnPersistenceError();
    assertSameRequest(existing, input);
    return { disposition: "EXISTING", turn: existing };
  }

  private async findByKey(
    userId: string,
    turnKey: string,
  ): Promise<PersistedFoodDayTurnResult | null> {
    const result = await this.executor.query(
      `select ${foodDayTurnResultColumns}
       from public.food_day_turn_results
       where user_id = $1
         and turn_key = $2`,
      [userId, turnKey],
    );
    const row = firstRow(result.rows);
    return row === undefined ? null : fromFoodDayTurnResultRow(parseRow(row));
  }
}

const foodDayTurnResultColumns = `
  id,
  user_id,
  food_day_id,
  turn_key,
  request_fingerprint,
  user_message,
  response,
  to_jsonb(created_at) #>> '{}' as created_at
`;

function assertSameRequest(
  existing: PersistedFoodDayTurnResult,
  input: FindCompletedFoodDayTurnInput,
): void {
  if (
    existing.foodDayId !== input.foodDayId ||
    existing.requestFingerprint !== input.requestFingerprint
  ) {
    throw new FoodDayTurnIdempotencyConflictError(
      input.turnKey,
      existing.requestFingerprint,
      input.requestFingerprint,
    );
  }
}

function fromFoodDayTurnResultRow(
  row: FoodDayTurnResultRow,
): PersistedFoodDayTurnResult {
  return {
    id: row.id,
    userId: row.user_id,
    foodDayId: row.food_day_id,
    turnKey: row.turn_key,
    requestFingerprint: row.request_fingerprint,
    userMessage: row.user_message,
    response: row.response,
    createdAt: row.created_at,
  };
}

function parseRow(value: unknown): FoodDayTurnResultRow {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.user_id) ||
    !isString(value.food_day_id) ||
    !isString(value.turn_key) ||
    !isString(value.request_fingerprint) ||
    !isLegacyOrNonblankString(value.user_message) ||
    !isString(value.response) ||
    value.response.trim() === "" ||
    !isString(value.created_at)
  ) {
    throw new TypeError(
      "PostgreSQL returned an invalid FoodDay turn result row.",
    );
  }
  return {
    id: value.id,
    user_id: value.user_id,
    food_day_id: value.food_day_id,
    turn_key: value.turn_key,
    request_fingerprint: value.request_fingerprint,
    user_message: value.user_message,
    response: value.response,
    created_at: value.created_at,
  };
}

function firstRow(rows: readonly unknown[]): unknown {
  return rows[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isLegacyOrNonblankString(value: unknown): value is string | null {
  return value === null || (isString(value) && value.trim() !== "");
}
