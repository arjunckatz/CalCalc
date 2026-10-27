import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresAccountConversationTurnRepository,
  PostgresAccountTurnStepResultRepository,
  PostgresConversationRepository,
  type AccountTurnPlanAction,
} from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "")
  throw new Error("DATABASE_URL is required for active-pointer integration.");

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const conversations = new PostgresConversationRepository(pool);
const turns = new PostgresAccountConversationTurnRepository(pool);
const steps = new PostgresAccountTurnStepResultRepository(pool);
const owner = randomUUID();
const other = randomUUID();
const dayX = randomUUID();
const dayY = randomUUID();
const otherDay = randomUUID();
const logCommand = {
  rawUserDescription: "oats",
  displayName: "Oats",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "100" },
  },
  evidenceClass: "EXACT",
  status: "CONFIRMED_CONSUMED",
};

async function snapshot() {
  const row = await conversations.findByUser(owner);
  if (row === null) throw new Error("Missing pointer fixture.");
  return row;
}

async function completed(
  dayId: string,
  action: AccountTurnPlanAction = "LOG_FOOD",
  userId = owner,
  complete = true,
) {
  const id = randomUUID();
  const key = `pointer-${id}`;
  const identity = {
    userId,
    turnKey: key,
    requestFingerprint: `fingerprint-${id}`,
  };
  await turns.claimPending({
    ...identity,
    id,
    userMessage: "fixture",
    calendarContext: null,
  });
  await turns.setRoutingResolutionOnce({
    ...identity,
    resolution: {
      schema: "account-routing-resolution-v1",
      kind: "EXISTING_DAY",
      foodDayId: dayId,
    },
  });
  await turns.setPlanOnce({
    ...identity,
    plan: {
      schema: "account-turn-plan-v1",
      foodDayId: dayId,
      slots: [
        {
          index: 0,
          action,
          command:
            action === "DIRECT_RESPONSE"
              ? { response: "Answer." }
              : action === "LOG_FOOD"
                ? logCommand
                : {},
        },
      ],
    },
  });
  if (action !== "DIRECT_RESPONSE") {
    // This fixture exercises the SQL pointer gate using a persisted step
    // checkpoint; M5A8C's application tests prove checkpoint normalization
    // follows a successful canonical mutation, not this repository test.
    await steps.setOnce({
      userId,
      turnId: id,
      ordinal: 0,
      result: {
        schema: "account-turn-step-result-v1",
        action,
        outcome:
          action === "LOG_FOOD"
            ? { entryId: randomUUID(), revision: 1 }
            : { fixture: true },
      },
    });
  }
  if (complete) await turns.markCompleted({ ...identity, response: "Answer." });
  return id;
}

describe("PostgreSQL monotonic completed-turn FoodDay pointer", () => {
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
        owner,
        `pointer-${owner}@example.invalid`,
        other,
        `pointer-${other}@example.invalid`,
      ],
    );
    await pool.query(
      `insert into public.food_days
         (id, user_id, status, completeness, calorie_target, protein_target)
       values ($1, $2, 'OPEN', 'UNKNOWN', 2100, 120),
              ($3, $2, 'OPEN', 'UNKNOWN', 2100, 120),
              ($4, $5, 'OPEN', 'UNKNOWN', 2100, 120)`,
      [dayX, owner, dayY, otherDay, other],
    );
    await conversations.getOrCreate(owner);
    await conversations.getOrCreate(other);
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      await pool.query(
        `update public.conversations
         set active_food_day_id = null, active_food_day_turn_id = null,
             version = version + 1
         where user_id = any($1::uuid[]) and active_food_day_id is not null`,
        [[owner, other]],
      );
    } catch (error) {
      failures.push(error);
    }
    for (const table of [
      "account_turn_step_results",
      "conversation_turns",
      "conversations",
      "food_days",
    ] as const) {
      try {
        await pool.query(
          `delete from public.${table} where user_id = any($1::uuid[])`,
          [[owner, other]],
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await pool.query("delete from auth.users where id = any($1::uuid[])", [
        [owner, other],
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
      throw new AggregateError(failures, "Pointer fixture cleanup failed.");
  });

  it("advances from null, ignores older late completion, and advances on a newer same-day turn once", async () => {
    const older = await completed(dayX, "LOG_FOOD", owner, false);
    const newer = await completed(dayY);
    const start = await snapshot();
    await conversations.advanceActiveFoodDayFromCompletedTurn({
      userId: owner,
      turnId: newer,
    });
    expect(await snapshot()).toMatchObject({
      activeFoodDayId: dayY,
      activeFoodDayTurnId: newer,
      version: start.version + 1,
    });
    const olderTurn = await turns.findById(owner, older);
    await turns.markCompleted({
      userId: owner,
      turnKey: olderTurn!.turnKey,
      requestFingerprint: olderTurn!.requestFingerprint,
      response: "Older answer.",
    });
    await expect(
      conversations.advanceActiveFoodDayFromCompletedTurn({
        userId: owner,
        turnId: older,
      }),
    ).resolves.toBeNull();
    expect(await snapshot()).toMatchObject({
      activeFoodDayId: dayY,
      activeFoodDayTurnId: newer,
      version: start.version + 1,
    });
    await expect(
      conversations.advanceActiveFoodDayFromCompletedTurn({
        userId: owner,
        turnId: newer,
      }),
    ).resolves.toBeNull();
    const sameDay = await completed(dayY);
    await conversations.advanceActiveFoodDayFromCompletedTurn({
      userId: owner,
      turnId: sameDay,
    });
    expect(await snapshot()).toMatchObject({
      activeFoodDayId: dayY,
      activeFoodDayTurnId: sameDay,
      version: start.version + 2,
    });
  });

  it("allows an older then newer advancement and converges a concurrent different-day race", async () => {
    const first = await completed(dayX);
    const second = await completed(dayY);
    const start = await snapshot();
    await conversations.advanceActiveFoodDayFromCompletedTurn({
      userId: owner,
      turnId: first,
    });
    await conversations.advanceActiveFoodDayFromCompletedTurn({
      userId: owner,
      turnId: second,
    });
    expect(await snapshot()).toMatchObject({
      activeFoodDayId: dayY,
      activeFoodDayTurnId: second,
      version: start.version + 2,
    });
    const raceOlder = await completed(dayX);
    const raceNewer = await completed(dayY);
    const beforeRace = await snapshot();
    await Promise.all([
      conversations.advanceActiveFoodDayFromCompletedTurn({
        userId: owner,
        turnId: raceOlder,
      }),
      conversations.advanceActiveFoodDayFromCompletedTurn({
        userId: owner,
        turnId: raceNewer,
      }),
    ]);
    const afterRace = await snapshot();
    expect(afterRace).toMatchObject({
      activeFoodDayId: dayY,
      activeFoodDayTurnId: raceNewer,
    });
    expect(afterRace.version).toBeGreaterThanOrEqual(beforeRace.version + 1);
    expect(afterRace.version).toBeLessThanOrEqual(beforeRace.version + 2);
  });

  it("keeps pending, direct, read-only, and body-weight turns neutral", async () => {
    const start = await snapshot();
    for (const [action, done] of [
      ["LOG_FOOD", false],
      ["DIRECT_RESPONSE", true],
      ["GET_BODY_WEIGHT_HISTORY", true],
      ["LOG_BODY_WEIGHT", true],
    ] as const) {
      const id = await completed(dayX, action, owner, done);
      await expect(
        conversations.advanceActiveFoodDayFromCompletedTurn({
          userId: owner,
          turnId: id,
        }),
      ).resolves.toBeNull();
    }
    expect(await snapshot()).toEqual(start);
  });

  it("rejects cross-owner provenance and direct client writes", async () => {
    const foreign = await completed(otherDay, "LOG_FOOD", other);
    const nonmutating = await completed(dayX, "DIRECT_RESPONSE");
    const before = await snapshot();
    await expect(
      conversations.advanceActiveFoodDayFromCompletedTurn({
        userId: owner,
        turnId: foreign,
      }),
    ).resolves.toBeNull();
    expect(await snapshot()).toEqual(before);
    await expect(
      pool.query(
        `update public.conversations set active_food_day_turn_id = $2, version = version + 1 where user_id = $1`,
        [owner, foreign],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `update public.conversations
         set active_food_day_id = $2, active_food_day_turn_id = $3,
             version = version + 1 where user_id = $1`,
        [owner, dayX, nonmutating],
      ),
    ).rejects.toThrow(
      "active FoodDay source requires a food mutation checkpoint",
    );
    expect(await snapshot()).toEqual(before);
    const privileges = await pool.query<{
      role: string;
      can_write: boolean;
      rls: boolean;
    }>(
      `select role_name as role,
              has_table_privilege(role_name, 'public.conversations', 'UPDATE') as can_write,
              (select relrowsecurity from pg_class where oid = 'public.conversations'::regclass) as rls
       from (values ('anon'), ('authenticated')) as roles(role_name)`,
    );
    expect(privileges.rows).toEqual([
      { role: "anon", can_write: false, rls: true },
      { role: "authenticated", can_write: false, rls: true },
    ]);
    const client = await pool.connect();
    try {
      await client.query("begin");
      try {
        await client.query("set local role authenticated");
        await expect(
          client.query(
            `update public.conversations
           set active_food_day_id = $2, active_food_day_turn_id = $3,
               version = version + 1 where user_id = $1`,
            [owner, dayX, foreign],
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
