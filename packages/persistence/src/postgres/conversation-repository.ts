import type { PersistedConversation } from "../types.js";
import type { PostgresExecutor } from "./food-entry-repository.js";

export class ConversationNotFoundError extends Error {
  override readonly name = "ConversationNotFoundError";
  constructor() {
    super("Conversation was not found for this user.");
  }
}

export class ConversationVersionConflictError extends Error {
  override readonly name = "ConversationVersionConflictError";
  constructor() {
    super("Conversation version changed since this update was prepared.");
  }
}

export class ConversationPointerNoChangeError extends Error {
  override readonly name = "ConversationPointerNoChangeError";
  constructor() {
    super("Conversation active FoodDay is already the requested value.");
  }
}

export class PostgresConversationRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  async getOrCreate(userId: string): Promise<PersistedConversation> {
    await this.executor.query(
      `insert into public.conversations (user_id)
       values ($1) on conflict (user_id) do nothing`,
      [userId],
    );
    const found = await this.findByUser(userId);
    if (found === null) throw new ConversationNotFoundError();
    return found;
  }

  async findByUser(userId: string): Promise<PersistedConversation | null> {
    const result = await this.executor.query(
      `select ${columns} from public.conversations where user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : parseConversation(row);
  }

  async compareAndSetActiveDay(input: {
    readonly userId: string;
    readonly expectedVersion: number;
    readonly activeFoodDayId: string | null;
  }): Promise<PersistedConversation> {
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    ) {
      throw new TypeError("Expected conversation version must be nonnegative.");
    }
    const result = await this.executor.query(
      `update public.conversations
       set active_food_day_id = $3, version = version + 1
       where user_id = $1 and version = $2
         and active_food_day_id is distinct from $3::uuid
       returning ${columns}`,
      [input.userId, input.expectedVersion, input.activeFoodDayId],
    );
    const row = result.rows[0];
    if (row !== undefined) return parseConversation(row);
    const current = await this.findByUser(input.userId);
    if (current === null) throw new ConversationNotFoundError();
    if (current.version !== input.expectedVersion) {
      throw new ConversationVersionConflictError();
    }
    throw new ConversationPointerNoChangeError();
  }
}

const columns = `user_id, active_food_day_id, version,
  to_jsonb(created_at) #>> '{}' as created_at,
  to_jsonb(updated_at) #>> '{}' as updated_at`;

function parseConversation(value: unknown): PersistedConversation {
  if (
    !isRecord(value) ||
    typeof value.user_id !== "string" ||
    (value.active_food_day_id !== null &&
      typeof value.active_food_day_id !== "string") ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string"
  ) {
    throw new TypeError("PostgreSQL returned an invalid conversation row.");
  }
  return {
    userId: value.user_id,
    activeFoodDayId: value.active_food_day_id,
    version: value.version as number,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
