import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresAccountConversationTurnRepository,
  type AccountTurnRoutingResolution,
} from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "")
  throw new Error("DATABASE_URL is required for account routing integration.");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const turns = new PostgresAccountConversationTurnRepository(pool);
const userA = randomUUID();
const userB = randomUUID();
const dayA = randomUUID();
const dayB = randomUUID();
const entryA = randomUUID();
const schema = "account-routing-resolution-v1";

function claimInput(userId = userA) {
  const turnKey = `calcalc:account-turn:v1:${randomUUID()}`;
  return {
    userId,
    turnKey,
    requestFingerprint: `fingerprint-${turnKey}`,
    userMessage: "  Exact accepted message.  ",
    calendarContext: null,
  };
}

async function claim(base: ReturnType<typeof claimInput>) {
  return turns.claimPending({ ...base, id: randomUUID() });
}

describe("PostgreSQL durable account routing resolution", () => {
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
        `calcalc-m5a5-${userA}@example.invalid`,
        userB,
        `calcalc-m5a5-${userB}@example.invalid`,
      ],
    );
    await pool.query(
      `insert into public.food_days
         (id, user_id, status, completeness, calorie_target, protein_target)
       values ($1, $2, 'OPEN', 'UNKNOWN', 2100, 120),
              ($3, $4, 'OPEN', 'UNKNOWN', 2100, 120)`,
      [dayA, userA, dayB, userB],
    );
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const table of [
      "conversation_turns",
      "conversations",
      "food_days",
    ] as const) {
      try {
        await pool.query(
          `delete from public.${table} where user_id = any($1::uuid[])`,
          [[userA, userB]],
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await pool.query("delete from auth.users where id = any($1::uuid[])", [
        [userA, userB],
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
      throw new AggregateError(failures, "Account routing cleanup failed.");
  });

  it("converges concurrent identical proposals on one durable resolution", async () => {
    const base = claimInput();
    await claim(base);
    const resolution: AccountTurnRoutingResolution = {
      schema,
      kind: "EXISTING_DAY",
      foodDayId: dayA,
    };
    const [left, right] = await Promise.all([
      turns.setRoutingResolutionOnce({ ...base, resolution }),
      turns.setRoutingResolutionOnce({ ...base, resolution }),
    ]);
    expect(left).toEqual(right);
    expect(left).toMatchObject({
      status: "PENDING",
      routingResolution: resolution,
      resolvedFoodDayId: dayA,
      executionPlan: null,
      response: null,
    });
    const stored = await pool.query<{
      routing_resolution: unknown;
      resolved_food_day_id: string | null;
    }>(
      `select routing_resolution, resolved_food_day_id
       from public.conversation_turns where user_id = $1 and turn_key = $2`,
      [userA, base.turnKey],
    );
    expect(stored.rows).toEqual([
      { routing_resolution: resolution, resolved_food_day_id: dayA },
    ]);
  });

  it("converges different concurrent proposals on one first writer without overwrite", async () => {
    const base = claimInput();
    await claim(base);
    const left: AccountTurnRoutingResolution = {
      schema,
      kind: "EXISTING_DAY",
      foodDayId: dayA,
    };
    const right: AccountTurnRoutingResolution = {
      schema,
      kind: "CLARIFY",
      question: "Which day did you mean?",
    };
    const [first, second] = await Promise.all([
      turns.setRoutingResolutionOnce({ ...base, resolution: left }),
      turns.setRoutingResolutionOnce({ ...base, resolution: right }),
    ]);
    expect(first).toEqual(second);
    expect([left, right]).toContainEqual(first.routingResolution);
    expect(first.resolvedFoodDayId).toBe(
      first.routingResolution?.kind === "EXISTING_DAY" ? dayA : null,
    );
    await expect(turns.findByKey(userA, base.turnKey)).resolves.toEqual(first);
    const losing =
      first.routingResolution?.kind === "EXISTING_DAY" ? right : left;
    await expect(
      turns.setRoutingResolutionOnce({ ...base, resolution: losing }),
    ).resolves.toEqual(first);
    await expect(
      pool.query(
        `update public.conversation_turns set routing_resolution = $3::jsonb
         where user_id = $1 and turn_key = $2`,
        [userA, base.turnKey, JSON.stringify(losing)],
      ),
    ).rejects.toThrow("conversation routing resolution is immutable");
  });

  it("rehydrates a canonical entry reference and rejects inconsistent target columns", async () => {
    const base = claimInput();
    await claim(base);
    const resolution: AccountTurnRoutingResolution = {
      schema,
      kind: "EXISTING_ENTRY_REFERENCE",
      foodDayId: dayA,
      entryId: entryA,
      revision: 7,
    };
    await turns.setRoutingResolutionOnce({ ...base, resolution });
    expect(await turns.findByKey(userA, base.turnKey)).toMatchObject({
      routingResolution: resolution,
      resolvedFoodDayId: dayA,
      status: "PENDING",
    });
    await expect(
      pool.query(
        `update public.conversation_turns
         set routing_resolution = $3::jsonb, resolved_food_day_id = $4
         where user_id = $1 and turn_key = $2`,
        [userA, base.turnKey, JSON.stringify(resolution), dayB],
      ),
    ).rejects.toThrow();
    expect(
      (await turns.findByKey(userA, base.turnKey))?.routingResolution,
    ).toEqual(resolution);
  });

  it("rejects cross-owner target persistence and leaves the claim unresolved", async () => {
    const base = claimInput();
    await claim(base);
    await expect(
      turns.setRoutingResolutionOnce({
        ...base,
        resolution: { schema, kind: "EXISTING_DAY", foodDayId: dayB },
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await turns.findByKey(userA, base.turnKey)).toMatchObject({
      status: "PENDING",
      routingResolution: null,
      resolvedFoodDayId: null,
    });
    await expect(turns.findByKey(userB, base.turnKey)).resolves.toBeNull();
  });

  it("keeps completed rows immutable and denies authenticated direct table access", async () => {
    const base = claimInput();
    await claim(base);
    await turns.setRoutingResolutionOnce({
      ...base,
      resolution: { schema, kind: "DAYLESS" },
    });
    await turns.markCompleted({ ...base, response: "  exact answer  " });
    await expect(
      pool.query(
        `update public.conversation_turns
         set routing_resolution = $3::jsonb
         where user_id = $1 and turn_key = $2`,
        [
          userA,
          base.turnKey,
          JSON.stringify({ schema, kind: "CLARIFY", question: "Which day?" }),
        ],
      ),
    ).rejects.toThrow("completed conversation turns are immutable");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await expect(
        client.query(
          "select routing_resolution from public.conversation_turns limit 1",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      try {
        await client.query("rollback");
      } finally {
        client.release();
      }
    }
  });
});
