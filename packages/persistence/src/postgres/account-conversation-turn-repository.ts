import { isDeepStrictEqual } from "node:util";

import {
  parseAccountTurnCalendarSnapshot,
  parseAccountTurnPlan,
  parseAccountTurnRoutingResolution,
} from "../account-turn-values.js";
import type {
  AccountTurnCalendarSnapshot,
  AccountTurnPlan,
  AccountTurnRoutingResolution,
  PersistedAccountTurn,
} from "../types.js";
import type { PostgresExecutor } from "./food-entry-repository.js";
import type { BoundedRows } from "./food-day-repository.js";
import { PostgresConversationRepository } from "./conversation-repository.js";

export const RECENT_ACCOUNT_TURN_LIMIT = 8;
export const MAX_RECENT_RESOLVED_TURNS = 8;

export interface ResolvedTurnReference {
  readonly foodDayId: string;
  readonly turnId: string;
  readonly createdAt: string;
}

export interface ClaimAccountTurnInput {
  readonly id: string;
  readonly userId: string;
  readonly turnKey: string;
  readonly requestFingerprint: string;
  readonly userMessage: string;
  readonly calendarContext: AccountTurnCalendarSnapshot;
}

export interface AccountTurnKeyInput {
  readonly userId: string;
  readonly turnKey: string;
  readonly requestFingerprint: string;
}

export type AccountTurnClaim =
  | { readonly disposition: "CREATED"; readonly turn: PersistedAccountTurn }
  | { readonly disposition: "EXISTING"; readonly turn: PersistedAccountTurn };

export type AccountTurnCompletion =
  | { readonly disposition: "COMPLETED"; readonly turn: PersistedAccountTurn }
  | { readonly disposition: "REPLAYED"; readonly turn: PersistedAccountTurn };

export interface AccountTranscriptItem {
  readonly userMessage: string;
  readonly response: string;
}

export class AccountTurnIdempotencyConflictError extends Error {
  override readonly name = "AccountTurnIdempotencyConflictError";
  constructor() {
    super("Account turn key was already used for a different request.");
  }
}

export class AccountTurnNotFoundError extends Error {
  override readonly name = "AccountTurnNotFoundError";
  constructor() {
    super("Account turn was not found for this user.");
  }
}

export class AccountTurnStateConflictError extends Error {
  override readonly name = "AccountTurnStateConflictError";
  constructor() {
    super("Account turn state cannot be changed.");
  }
}

export class PostgresAccountConversationTurnRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  async claimPending(input: ClaimAccountTurnInput): Promise<AccountTurnClaim> {
    if (
      typeof input.userMessage !== "string" ||
      input.userMessage.trim() === ""
    ) {
      throw new TypeError("Account turn message must not be blank.");
    }
    const context = parseAccountTurnCalendarSnapshot(input.calendarContext);
    const found = await this.findByKey(input.userId, input.turnKey);
    if (found !== null) return this.matchClaim(found, input, context);
    await new PostgresConversationRepository(this.executor).getOrCreate(
      input.userId,
    );
    const result = await this.executor.query(
      `insert into public.conversation_turns (
         id, user_id, turn_key, request_fingerprint, user_message, calendar_context
       ) values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict (user_id, turn_key) do nothing
       returning ${columns}`,
      [
        input.id,
        input.userId,
        input.turnKey,
        input.requestFingerprint,
        input.userMessage,
        JSON.stringify(context),
      ],
    );
    const row = result.rows[0];
    if (row !== undefined)
      return { disposition: "CREATED", turn: parseTurn(row) };
    const existing = await this.requireMatching(input);
    return this.matchClaim(existing, input, context);
  }

  async findByKey(
    userId: string,
    turnKey: string,
  ): Promise<PersistedAccountTurn | null> {
    const result = await this.executor.query(
      `select ${columns} from public.conversation_turns
       where user_id = $1 and turn_key = $2`,
      [userId, turnKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : parseTurn(row);
  }

  async setResolvedTarget(
    input: AccountTurnKeyInput & {
      readonly foodDayId: string;
    },
  ): Promise<PersistedAccountTurn> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        input.foodDayId,
      )
    ) {
      throw new TypeError("Resolved FoodDay ID must be a UUID.");
    }
    const foodDayId = input.foodDayId.toLowerCase();
    const updated = await this.executor.query(
      `update public.conversation_turns
       set resolved_food_day_id = $4
       where user_id = $1 and turn_key = $2 and request_fingerprint = $3
         and status = 'PENDING' and resolved_food_day_id is null
         and routing_resolution is null and execution_plan is null
       returning ${columns}`,
      [input.userId, input.turnKey, input.requestFingerprint, foodDayId],
    );
    if (updated.rows[0] !== undefined) return parseTurn(updated.rows[0]);
    const existing = await this.requireMatching(input);
    if (existing.resolvedFoodDayId === foodDayId) return existing;
    throw new AccountTurnStateConflictError();
  }

  /** A single row CAS persists the trusted resolution and its owned parent day.
   * Concurrent losers read the first durable winner without overwriting it. */
  async setRoutingResolutionOnce(
    input: AccountTurnKeyInput & {
      readonly resolution: AccountTurnRoutingResolution;
    },
  ): Promise<PersistedAccountTurn> {
    const resolution = parseAccountTurnRoutingResolution(input.resolution);
    const foodDayId =
      resolution.kind === "EXISTING_DAY" ||
      resolution.kind === "EXISTING_ENTRY_REFERENCE"
        ? resolution.foodDayId
        : null;
    const updated = await this.executor.query(
      `update public.conversation_turns
       set routing_resolution = $4::jsonb, resolved_food_day_id = $5::uuid
       where user_id = $1 and turn_key = $2 and request_fingerprint = $3
         and status = 'PENDING' and routing_resolution is null
         and resolved_food_day_id is null and execution_plan is null
       returning ${columns}`,
      [
        input.userId,
        input.turnKey,
        input.requestFingerprint,
        JSON.stringify(resolution),
        foodDayId,
      ],
    );
    if (updated.rows[0] !== undefined) return parseTurn(updated.rows[0]);
    const existing = await this.requireMatching(input);
    if (existing.routingResolution !== null) return existing;
    throw new AccountTurnStateConflictError();
  }

  async setPlanOnce(
    input: AccountTurnKeyInput & {
      readonly plan: AccountTurnPlan;
    },
  ): Promise<PersistedAccountTurn> {
    const plan = parseAccountTurnPlan(input.plan);
    const updated = await this.executor.query(
      `update public.conversation_turns
       set execution_plan = $4::jsonb
       where user_id = $1 and turn_key = $2 and request_fingerprint = $3
         and status = 'PENDING' and execution_plan is null
       returning ${columns}`,
      [
        input.userId,
        input.turnKey,
        input.requestFingerprint,
        JSON.stringify(plan),
      ],
    );
    if (updated.rows[0] !== undefined) return parseTurn(updated.rows[0]);
    const existing = await this.requireMatching(input);
    if (
      existing.executionPlan !== null &&
      isDeepStrictEqual(existing.executionPlan, plan)
    )
      return existing;
    throw new AccountTurnStateConflictError();
  }

  async markCompleted(
    input: AccountTurnKeyInput & {
      readonly response: string;
    },
  ): Promise<AccountTurnCompletion> {
    if (typeof input.response !== "string" || input.response.trim() === "") {
      throw new TypeError("Completed account turn response must not be blank.");
    }
    const updated = await this.executor.query(
      `update public.conversation_turns
       set status = 'COMPLETED', response = $4
       where user_id = $1 and turn_key = $2 and request_fingerprint = $3
         and status = 'PENDING'
       returning ${columns}`,
      [input.userId, input.turnKey, input.requestFingerprint, input.response],
    );
    if (updated.rows[0] !== undefined)
      return { disposition: "COMPLETED", turn: parseTurn(updated.rows[0]) };
    const existing = await this.requireMatching(input);
    if (existing.status !== "COMPLETED")
      throw new AccountTurnStateConflictError();
    return { disposition: "REPLAYED", turn: existing };
  }

  async listRecentCompleted(
    userId: string,
    limit = RECENT_ACCOUNT_TURN_LIMIT,
  ): Promise<readonly AccountTranscriptItem[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > RECENT_ACCOUNT_TURN_LIMIT
    ) {
      throw new RangeError(
        `Account transcript limit must be 1..${RECENT_ACCOUNT_TURN_LIMIT}.`,
      );
    }
    const result = await this.executor.query(
      `select user_message, response from public.conversation_turns
       where user_id = $1 and status = 'COMPLETED'
       order by created_at desc, id desc limit $2`,
      [userId, limit],
    );
    return result.rows
      .map((row) => {
        if (
          !isRecord(row) ||
          typeof row.user_message !== "string" ||
          typeof row.response !== "string"
        )
          throw new TypeError("Invalid account transcript row.");
        return { userMessage: row.user_message, response: row.response };
      })
      .reverse();
  }

  /** Internal routing metadata; not the public transcript projection. */
  async listRecentResolvedTargets(
    userId: string,
  ): Promise<BoundedRows<ResolvedTurnReference>> {
    const result = await this.executor.query(
      `select id, resolved_food_day_id,
              to_jsonb(created_at) #>> '{}' as created_at
       from public.conversation_turns
       where user_id = $1 and status = 'COMPLETED'
         and resolved_food_day_id is not null
       order by created_at desc, id desc
       limit $2`,
      [userId, MAX_RECENT_RESOLVED_TURNS + 1],
    );
    const items = result.rows.slice(0, MAX_RECENT_RESOLVED_TURNS).map((row) => {
      if (
        !isRecord(row) ||
        typeof row.id !== "string" ||
        typeof row.resolved_food_day_id !== "string" ||
        typeof row.created_at !== "string"
      ) {
        throw new TypeError("Invalid resolved account turn reference row.");
      }
      return {
        turnId: row.id,
        foodDayId: row.resolved_food_day_id,
        createdAt: row.created_at,
      };
    });
    return { items, hasMore: result.rows.length > MAX_RECENT_RESOLVED_TURNS };
  }

  private async requireMatching(
    input: AccountTurnKeyInput,
  ): Promise<PersistedAccountTurn> {
    const existing = await this.findByKey(input.userId, input.turnKey);
    if (existing === null) throw new AccountTurnNotFoundError();
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new AccountTurnIdempotencyConflictError();
    }
    return existing;
  }

  private matchClaim(
    existing: PersistedAccountTurn,
    input: ClaimAccountTurnInput,
    context: AccountTurnCalendarSnapshot,
  ): AccountTurnClaim {
    if (
      existing.requestFingerprint !== input.requestFingerprint ||
      existing.userMessage !== input.userMessage ||
      !isDeepStrictEqual(existing.calendarContext, context)
    ) {
      throw new AccountTurnIdempotencyConflictError();
    }
    return { disposition: "EXISTING", turn: existing };
  }
}

const columns = `id, user_id, turn_key, request_fingerprint, user_message,
  calendar_context, status, resolved_food_day_id, routing_resolution,
  execution_plan, response,
  to_jsonb(created_at) #>> '{}' as created_at,
  to_jsonb(completed_at) #>> '{}' as completed_at`;

function parseTurn(value: unknown): PersistedAccountTurn {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.user_id !== "string" ||
    typeof value.turn_key !== "string" ||
    typeof value.request_fingerprint !== "string" ||
    typeof value.user_message !== "string" ||
    (value.status !== "PENDING" && value.status !== "COMPLETED") ||
    (value.resolved_food_day_id !== null &&
      typeof value.resolved_food_day_id !== "string") ||
    value.routing_resolution === undefined ||
    (value.response !== null && typeof value.response !== "string") ||
    typeof value.created_at !== "string" ||
    (value.completed_at !== null && typeof value.completed_at !== "string")
  ) {
    throw new TypeError("PostgreSQL returned an invalid account turn row.");
  }
  const calendarContext = parseAccountTurnCalendarSnapshot(
    value.calendar_context,
  );
  const executionPlan =
    value.execution_plan === null
      ? null
      : parseAccountTurnPlan(value.execution_plan);
  const routingResolution =
    value.routing_resolution === null
      ? null
      : parseAccountTurnRoutingResolution(value.routing_resolution);
  if (
    routingResolution !== null &&
    (routingResolution.kind === "EXISTING_DAY" ||
    routingResolution.kind === "EXISTING_ENTRY_REFERENCE"
      ? value.resolved_food_day_id !== routingResolution.foodDayId
      : value.resolved_food_day_id !== null)
  ) {
    throw new TypeError("PostgreSQL returned an inconsistent routing target.");
  }
  if (
    value.status === "PENDING" &&
    (value.response !== null || value.completed_at !== null)
  ) {
    throw new TypeError("PostgreSQL returned an invalid pending account turn.");
  }
  if (
    value.status === "COMPLETED" &&
    (value.response === null || value.completed_at === null)
  ) {
    throw new TypeError(
      "PostgreSQL returned an invalid completed account turn.",
    );
  }
  return {
    id: value.id,
    userId: value.user_id,
    turnKey: value.turn_key,
    requestFingerprint: value.request_fingerprint,
    userMessage: value.user_message,
    calendarContext,
    status: value.status,
    resolvedFoodDayId: value.resolved_food_day_id,
    routingResolution,
    executionPlan,
    response: value.response,
    createdAt: value.created_at,
    completedAt: value.completed_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
