import { randomUUID } from "node:crypto";

import { createFoodDay } from "@cal-calc/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AccountTurnMaterializationIneligibleError,
  PostgresAccountConversationTurnRepository,
  PostgresAccountNutritionTargetsRepository,
  PostgresFoodDayRepository,
  materializeAccountTurnFoodDay,
  type PostgresExecutor,
  type PostgresTransactionRunner,
} from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "")
  throw new Error(
    "DATABASE_URL is required for account-turn materialization integration.",
  );

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const turns = new PostgresAccountConversationTurnRepository(pool);
const targets = new PostgresAccountNutritionTargetsRepository(pool);
const days = new PostgresFoodDayRepository(pool);
const userA = randomUUID();
const userB = randomUUID();
const users = [userA, userB];
const dateA = "2026-10-18";
const dateB = "2026-10-19";
const operationPrefix = "calcalc:account-turn:materialize-food-day:v1:";

const runner: PostgresTransactionRunner = {
  async runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ): Promise<Value> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      try {
        const value = await work(client);
        await client.query("commit");
        return value;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    } finally {
      client.release();
    }
  },
};

async function pending(
  userId = userA,
  localDate = dateA,
  kind: "DATE_TARGET" | "DAYLESS" = "DATE_TARGET",
) {
  const turnKey = `calcalc:account-turn:v1:${randomUUID()}`;
  const requestFingerprint = `fingerprint-${randomUUID()}`;
  const claimed = await turns.claimPending({
    id: randomUUID(),
    userId,
    turnKey,
    requestFingerprint,
    userMessage: "I had oats.",
    calendarContext: null,
  });
  await turns.setRoutingResolutionOnce({
    userId,
    turnKey,
    requestFingerprint,
    resolution:
      kind === "DATE_TARGET"
        ? { schema: "account-routing-resolution-v1", kind, localDate }
        : { schema: "account-routing-resolution-v1", kind },
  });
  return {
    trustedUserId: userId,
    turnId: claimed.turn.id,
    turnKey,
    requestFingerprint,
  };
}

async function setTargets(
  userId = userA,
  calorieTarget = "685.1075",
  proteinTarget = "41.0025",
  expectedVersion: number | null = null,
) {
  return targets.setWithExpectedVersion({
    userId,
    expectedVersion,
    calorieTarget,
    proteinTarget,
  });
}

async function existingDay(
  userId = userA,
  localDate = dateA,
  status: "OPEN" | "CLOSED" = "OPEN",
) {
  return days.create({
    userId,
    localDate,
    completeness: "USER_DECLARED_COMPLETE",
    foodDay: createFoodDay({
      id: randomUUID(),
      status,
      calorieTarget: "249.13",
      proteinTarget: "0.1",
    }),
  });
}

async function state(userId = userA) {
  const result = await pool.query<{
    days: string;
    operations: string;
    turns: string;
  }>(
    `select
       (select count(*)::text from public.food_days where user_id = $1) as days,
       (select count(*)::text from public.semantic_operations where user_id = $1 and operation_key like $2) as operations,
       (select count(*)::text from public.conversation_turns where user_id = $1 and materialized_food_day_id is not null) as turns`,
    [userId, `${operationPrefix}%`],
  );
  return result.rows[0];
}

async function storedTurn(turnId: string) {
  const result = await pool.query<{
    status: string;
    resolved_food_day_id: string | null;
    materialized_food_day_id: string | null;
    routing_resolution: { kind: string; localDate?: string };
    execution_plan: unknown;
  }>(
    `select status, resolved_food_day_id, materialized_food_day_id,
             routing_resolution, execution_plan
      from public.conversation_turns where id = $1`,
    [turnId],
  );
  return result.rows[0];
}

describe("PostgreSQL replay-safe account-turn FoodDay materialization", () => {
  beforeAll(async () => {
    await pool.query(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password,
         email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
         created_at, updated_at
       ) values
         ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
         ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
      [
        userA,
        `calcalc-m5a7a-${userA}@example.invalid`,
        userB,
        `calcalc-m5a7a-${userB}@example.invalid`,
      ],
    );
  });

  beforeEach(async () => {
    for (const table of [
      "conversation_turns",
      "semantic_operations",
      "food_days",
      "account_nutrition_targets",
      "conversations",
    ])
      await pool.query(
        `delete from public.${table} where user_id = any($1::uuid[])`,
        [users],
      );
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const table of [
      "conversation_turns",
      "semantic_operations",
      "food_days",
      "account_nutrition_targets",
      "conversations",
      "profiles",
    ])
      try {
        await pool.query(
          `delete from public.${table} where user_id = any($1::uuid[])`,
          [users],
        );
      } catch (error) {
        failures.push(error);
      }
    try {
      await pool.query("delete from auth.users where id = any($1::uuid[])", [
        users,
      ]);
    } catch (error) {
      failures.push(error);
    }
    try {
      await pool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Account materialization cleanup failed.",
      );
  });

  it("creates once, preserves semantic DATE_TARGET, freezes pointer/version/plan/status, and recovers after committed response loss", async () => {
    const turn = await pending();
    await setTargets();
    const first = await materializeAccountTurnFoodDay(runner, turn);
    expect(first.kind).toBe("FOOD_DAY_READY");
    if (first.kind !== "FOOD_DAY_READY")
      throw new Error("Materialization did not produce a day.");
    expect(first.source).toBe("CREATED");
    // Discard first's response: the next call must recover only durable state.
    const retry = await materializeAccountTurnFoodDay(runner, turn);
    expect(retry).toEqual(first);
    expect(await state()).toEqual({ days: "1", operations: "1", turns: "1" });
    expect(await storedTurn(turn.turnId)).toEqual({
      status: "PENDING",
      resolved_food_day_id: null,
      materialized_food_day_id: first.foodDayId,
      routing_resolution: {
        schema: "account-routing-resolution-v1",
        kind: "DATE_TARGET",
        localDate: dateA,
      },
      execution_plan: null,
    });
    const conversation = await pool.query<{
      version: number;
      active_food_day_id: string | null;
    }>(
      "select version, active_food_day_id from public.conversations where user_id = $1",
      [userA],
    );
    expect(conversation.rows[0]).toEqual({
      version: 0,
      active_food_day_id: null,
    });
    const storedDay = await days.findById(userA, first.foodDayId);
    expect(storedDay).toMatchObject({
      userId: userA,
      localDate: dateA,
      completeness: "UNKNOWN",
      foodDay: {
        status: "OPEN",
        calorieTarget: "685.1075",
        proteinTarget: "41.0025",
      },
    });
    const operation = await pool.query<{
      status: string;
      result: { source: string; foodDayId: string };
    }>(
      "select status, result from public.semantic_operations where user_id = $1 and operation_key = $2",
      [userA, `${operationPrefix}${turn.turnId}`],
    );
    expect(operation.rows[0]).toMatchObject({
      status: "SUCCEEDED",
      result: { source: "CREATED", foodDayId: first.foodDayId },
    });
  });

  it("rolls back FoodDay, operation, and link if the transaction fails before COMMIT", async () => {
    const turn = await pending();
    await setTargets();
    const failing: PostgresTransactionRunner = {
      async runInTransaction<Value>(
        work: (executor: PostgresExecutor) => Promise<Value>,
      ): Promise<Value> {
        const client = await pool.connect();
        try {
          await client.query("begin");
          try {
            await work(client);
            throw new Error("simulated pre-commit failure");
          } finally {
            await client.query("rollback");
          }
        } finally {
          client.release();
        }
      },
    };
    await expect(materializeAccountTurnFoodDay(failing, turn)).rejects.toThrow(
      "simulated pre-commit failure",
    );
    expect(await state()).toEqual({ days: "0", operations: "0", turns: "0" });
    expect((await materializeAccountTurnFoodDay(runner, turn)).kind).toBe(
      "FOOD_DAY_READY",
    );
  });

  it("converges concurrent calls for the same turn on one day and operation", async () => {
    const turn = await pending();
    await setTargets();
    const [left, right] = await Promise.all([
      materializeAccountTurnFoodDay(runner, turn),
      materializeAccountTurnFoodDay(runner, turn),
    ]);
    expect(right).toEqual(left);
    expect(left.kind).toBe("FOOD_DAY_READY");
    expect(await state()).toEqual({ days: "1", operations: "1", turns: "1" });
  });

  it("serializes two different same-date turns and binds both to one automatic day", async () => {
    const leftTurn = await pending();
    const rightTurn = await pending();
    await setTargets();
    const [left, right] = await Promise.all([
      materializeAccountTurnFoodDay(runner, leftTurn),
      materializeAccountTurnFoodDay(runner, rightTurn),
    ]);
    expect(left.kind).toBe("FOOD_DAY_READY");
    expect(right.kind).toBe("FOOD_DAY_READY");
    if (left.kind !== "FOOD_DAY_READY" || right.kind !== "FOOD_DAY_READY")
      throw new Error("Expected two ready turns.");
    expect(left.foodDayId).toBe(right.foodDayId);
    expect([left.source, right.source].sort()).toEqual(["CREATED", "EXISTING"]);
    expect(await state()).toEqual({ days: "1", operations: "2", turns: "2" });
  });

  it("creates separate automatic days for two different dates", async () => {
    const leftTurn = await pending(userA, dateA);
    const rightTurn = await pending(userA, dateB);
    await setTargets();
    const [left, right] = await Promise.all([
      materializeAccountTurnFoodDay(runner, leftTurn),
      materializeAccountTurnFoodDay(runner, rightTurn),
    ]);
    expect(left.kind).toBe("FOOD_DAY_READY");
    expect(right.kind).toBe("FOOD_DAY_READY");
    if (left.kind !== "FOOD_DAY_READY" || right.kind !== "FOOD_DAY_READY")
      throw new Error("Expected two ready turns.");
    expect(left.foodDayId).not.toBe(right.foodDayId);
    expect(await state()).toEqual({ days: "2", operations: "2", turns: "2" });
  });

  it("requires targets only for creation, then snapshots the latest configured values", async () => {
    const turn = await pending();
    expect(await materializeAccountTurnFoodDay(runner, turn)).toEqual({
      kind: "TARGETS_REQUIRED",
    });
    expect(await state()).toEqual({ days: "0", operations: "0", turns: "0" });
    await setTargets(userA, "100", "10");
    await setTargets(userA, "249.13", "0.1", 0);
    const ready = await materializeAccountTurnFoodDay(runner, turn);
    expect(ready.kind).toBe("FOOD_DAY_READY");
    if (ready.kind !== "FOOD_DAY_READY")
      throw new Error("Expected a ready day.");
    expect(
      (await days.findById(userA, ready.foodDayId))?.foodDay,
    ).toMatchObject({ calorieTarget: "249.13", proteinTarget: "0.1" });
    await setTargets(userA, "300", "20", 1);
    expect(await materializeAccountTurnFoodDay(runner, turn)).toEqual(ready);
    expect(
      (await days.findById(userA, ready.foodDayId))?.foodDay,
    ).toMatchObject({ calorieTarget: "249.13", proteinTarget: "0.1" });
  });

  it("never borrows another owner's account defaults", async () => {
    const turn = await pending(userA);
    await setTargets(userB, "249.13", "0.1");
    expect(await materializeAccountTurnFoodDay(runner, turn)).toEqual({
      kind: "TARGETS_REQUIRED",
    });
    expect(await state(userA)).toEqual({
      days: "0",
      operations: "0",
      turns: "0",
    });
  });

  it("reuses a sole CLOSED and complete day without account defaults", async () => {
    const day = await existingDay(userA, dateA, "CLOSED");
    const turn = await pending();
    expect(await materializeAccountTurnFoodDay(runner, turn)).toEqual({
      kind: "FOOD_DAY_READY",
      foodDayId: day.foodDay.id,
      source: "EXISTING",
    });
    expect(await state()).toEqual({ days: "1", operations: "1", turns: "1" });
    expect(await materializeAccountTurnFoodDay(runner, turn)).toEqual({
      kind: "FOOD_DAY_READY",
      foodDayId: day.foodDay.id,
      source: "EXISTING",
    });
  });

  it("treats two same-date days as ambiguity even with configured defaults", async () => {
    await existingDay();
    await existingDay();
    const turn = await pending();
    await setTargets();
    expect(await materializeAccountTurnFoodDay(runner, turn)).toEqual({
      kind: "AMBIGUOUS_EXISTING_DAYS",
    });
    expect(await state()).toEqual({ days: "2", operations: "0", turns: "0" });
  });

  it("rejects non-date, completed, and cross-owner turns before mutation", async () => {
    const dayless = await pending(userA, dateA, "DAYLESS");
    const completed = await pending();
    await turns.markCompleted({
      userId: userA,
      turnKey: completed.turnKey,
      requestFingerprint: completed.requestFingerprint,
      response: "Done.",
    });
    const foreign = await pending(userB);
    for (const [target, reason] of [
      [dayless, "ROUTING_NOT_DATE_TARGET"],
      [completed, "TURN_COMPLETED"],
      [{ trustedUserId: userA, turnId: foreign.turnId }, "TURN_NOT_FOUND"],
    ] as const) {
      await expect(
        materializeAccountTurnFoodDay(runner, target),
      ).rejects.toMatchObject({
        name: "AccountTurnMaterializationIneligibleError",
        reason,
      });
    }
    expect(await state()).toEqual({ days: "0", operations: "0", turns: "0" });
  });

  it("rejects cross-owner materialized FK and completed-row changes at the database boundary", async () => {
    const owned = await pending();
    const foreignDay = await existingDay(userB);
    await expect(
      pool.query(
        "update public.conversation_turns set materialized_food_day_id = $2 where id = $1",
        [owned.turnId, foreignDay.foodDay.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      (await storedTurn(owned.turnId))?.materialized_food_day_id,
    ).toBeNull();
    await setTargets();
    const ready = await materializeAccountTurnFoodDay(runner, owned);
    expect(ready.kind).toBe("FOOD_DAY_READY");
    const secondOwnedDay = await existingDay(userA);
    await expect(
      pool.query(
        "update public.conversation_turns set materialized_food_day_id = $2 where id = $1",
        [owned.turnId, secondOwnedDay.foodDay.id],
      ),
    ).rejects.toThrow();
    expect((await storedTurn(owned.turnId))?.materialized_food_day_id).toBe(
      ready.kind === "FOOD_DAY_READY" ? ready.foodDayId : null,
    );
    await turns.markCompleted({
      userId: userA,
      turnKey: owned.turnKey,
      requestFingerprint: owned.requestFingerprint,
      response: "Done.",
    });
    await expect(
      pool.query(
        "update public.conversation_turns set materialized_food_day_id = null where id = $1",
        [owned.turnId],
      ),
    ).rejects.toThrow();
    await expect(
      materializeAccountTurnFoodDay(runner, owned),
    ).rejects.toBeInstanceOf(AccountTurnMaterializationIneligibleError);
  });

  it("keeps the internal field inaccessible to direct authenticated/anon clients", async () => {
    const privileges = await pool.query<{
      role: string;
      can_read: boolean;
      can_write: boolean;
      rls: boolean;
    }>(
      `select role_name as role,
         has_table_privilege(role_name, 'public.conversation_turns', 'SELECT') as can_read,
         has_table_privilege(role_name, 'public.conversation_turns', 'UPDATE') as can_write,
         (select relrowsecurity from pg_class where oid = 'public.conversation_turns'::regclass) as rls
       from (values ('anon'), ('authenticated')) as roles(role_name)`,
    );
    expect(privileges.rows).toEqual([
      { role: "anon", can_read: false, can_write: false, rls: true },
      { role: "authenticated", can_read: false, can_write: false, rls: true },
    ]);
    const turn = await pending();
    const client = await pool.connect();
    try {
      await client.query("begin");
      try {
        await client.query("set local role authenticated");
        await expect(
          client.query(
            "update public.conversation_turns set materialized_food_day_id = null where id = $1",
            [turn.turnId],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
  });
});
