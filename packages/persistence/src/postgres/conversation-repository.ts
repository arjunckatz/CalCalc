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
    // Legacy/manual pointer writes intentionally clear account-turn provenance;
    // they are a new advisory baseline, not a turn-order advancement.
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    ) {
      throw new TypeError("Expected conversation version must be nonnegative.");
    }
    const result = await this.executor.query(
      `update public.conversations
       set active_food_day_id = $3, active_food_day_turn_id = null,
           version = version + 1
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

  /** A completed turn's immutable plan and step checkpoint are checked by the
   * application policy first. This single UPDATE derives the target again from
   * durable storage and serializes competing pointer writers on the owner row. */
  async advanceActiveFoodDayFromCompletedTurn(input: {
    readonly userId: string;
    readonly turnId: string;
  }): Promise<PersistedConversation | null> {
    const updated = await this.executor.query(
      `update public.conversations c
       set active_food_day_id = (t.execution_plan ->> 'foodDayId')::uuid,
           active_food_day_turn_id = t.id,
           version = c.version + 1
       from public.conversation_turns t
       where c.user_id = $1 and t.user_id = c.user_id and t.id = $2
         and t.status = 'COMPLETED'
         and (t.execution_plan ->> 'foodDayId')::uuid =
           coalesce(t.materialized_food_day_id, t.resolved_food_day_id)
         and exists (
           select 1 from public.account_turn_step_results r
           where r.turn_id = t.id and r.user_id = t.user_id
             and r.result ->> 'schema' = 'account-turn-step-result-v1'
             and r.result ->> 'action' =
               t.execution_plan -> 'slots' -> r.ordinal ->> 'action'
             and jsonb_typeof(r.result -> 'outcome') = 'object'
             and r.result ->> 'action' in (
               'LOG_FOOD', 'UPDATE_FOOD_QUANTITY', 'REMOVE_FOOD',
               'CHANGE_FOOD_STATUS', 'SET_FOOD_DAY_COMPLETENESS'
             )
         )
         and (
           c.active_food_day_turn_id is null or
           (t.created_at, t.id) > (
             select previous.created_at, previous.id
             from public.conversation_turns previous
             where previous.id = c.active_food_day_turn_id
               and previous.user_id = c.user_id
           )
         )
       returning c.user_id, c.active_food_day_id, c.active_food_day_turn_id,
                 c.version,
                 to_jsonb(c.created_at) #>> '{}' as created_at,
                 to_jsonb(c.updated_at) #>> '{}' as updated_at`,
      [input.userId, input.turnId],
    );
    const row = updated.rows[0];
    return row === undefined ? null : parseConversation(row);
  }
}

const columns = `user_id, active_food_day_id, active_food_day_turn_id, version,
  to_jsonb(created_at) #>> '{}' as created_at,
  to_jsonb(updated_at) #>> '{}' as updated_at`;

function parseConversation(value: unknown): PersistedConversation {
  if (
    !isRecord(value) ||
    typeof value.user_id !== "string" ||
    (value.active_food_day_id !== null &&
      typeof value.active_food_day_id !== "string") ||
    (value.active_food_day_turn_id !== null &&
      typeof value.active_food_day_turn_id !== "string") ||
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
    activeFoodDayTurnId: value.active_food_day_turn_id,
    version: value.version as number,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
