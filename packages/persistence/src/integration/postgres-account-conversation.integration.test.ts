import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AccountTurnIdempotencyConflictError,
  AccountTurnStateConflictError,
  ConversationVersionConflictError,
  PostgresAccountConversationTurnRepository,
  PostgresConversationRepository,
} from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for account conversation integration.",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const conversations = new PostgresConversationRepository(pool);
const turns = new PostgresAccountConversationTurnRepository(pool);
const userA = randomUUID();
const userB = randomUUID();
const dayA = randomUUID();
const dayB = randomUUID();

describe("PostgreSQL account conversation substrate", () => {
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
        `calcalc-m5a1-${userA}@example.invalid`,
        userB,
        `calcalc-m5a1-${userB}@example.invalid`,
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
      throw new AggregateError(
        failures,
        "Account conversation cleanup failed.",
      );
  });

  it("creates one nullable conversation per owner and CAS-updates only an owned pointer", async () => {
    const [first, duplicate] = await Promise.all([
      conversations.getOrCreate(userA),
      conversations.getOrCreate(userA),
    ]);
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      userId: userA,
      activeFoodDayId: null,
      version: 0,
    });
    expect(
      (
        await pool.query<{ count: string }>(
          "select count(*)::text as count from public.conversations where user_id = $1",
          [userA],
        )
      ).rows[0]?.count,
    ).toBe("1");

    const updated = await conversations.compareAndSetActiveDay({
      userId: userA,
      expectedVersion: 0,
      activeFoodDayId: dayA,
    });
    expect(updated).toMatchObject({ activeFoodDayId: dayA, version: 1 });
    await expect(
      conversations.compareAndSetActiveDay({
        userId: userA,
        expectedVersion: 0,
        activeFoodDayId: null,
      }),
    ).rejects.toBeInstanceOf(ConversationVersionConflictError);
    await expect(
      conversations.compareAndSetActiveDay({
        userId: userA,
        expectedVersion: 1,
        activeFoodDayId: dayB,
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await conversations.findByUser(userA)).toMatchObject({
      activeFoodDayId: dayA,
      version: 1,
    });
  });

  it("claims same-key requests once and rejects changed fingerprints", async () => {
    const base = claimInput(`calcalc:account-turn:v1:${randomUUID()}`);
    const [left, right] = await Promise.all([
      turns.claimPending({ ...base, id: randomUUID() }),
      turns.claimPending({ ...base, id: randomUUID() }),
    ]);
    expect([left.disposition, right.disposition].sort()).toEqual([
      "CREATED",
      "EXISTING",
    ]);
    expect(left.turn).toEqual(right.turn);
    expect(left.turn).toMatchObject({
      status: "PENDING",
      response: null,
      completedAt: null,
      userMessage: "  Exact accepted message.  ",
      calendarContext: base.calendarContext,
    });
    expect(
      (
        await pool.query<{ count: string }>(
          "select count(*)::text as count from public.conversation_turns where user_id = $1 and turn_key = $2",
          [userA, base.turnKey],
        )
      ).rows[0]?.count,
    ).toBe("1");
    await expect(
      turns.claimPending({
        ...base,
        id: randomUUID(),
        requestFingerprint: "changed-fingerprint",
      }),
    ).rejects.toBeInstanceOf(AccountTurnIdempotencyConflictError);
    await expect(turns.findByKey(userB, base.turnKey)).resolves.toBeNull();
    await expect(
      pool.query(
        `insert into public.conversation_turns
         (user_id, turn_key, request_fingerprint, user_message, status, response)
       values ($1, $2, 'fingerprint', 'message', 'COMPLETED', 'response')`,
        [userA, `invalid-start-${randomUUID()}`],
      ),
    ).rejects.toThrow("new conversation turns must begin pending");
  });

  it("sets an owned target once, fixes plan meaning across concurrent writers, and completes once", async () => {
    const base = claimInput(`calcalc:account-turn:v1:${randomUUID()}`);
    await turns.claimPending({ ...base, id: randomUUID() });
    await expect(
      turns.setResolvedTarget({ ...base, foodDayId: dayB }),
    ).rejects.toMatchObject({ code: "23503" });
    const targeted = await turns.setResolvedTarget({
      ...base,
      foodDayId: dayA,
    });
    expect(targeted.resolvedFoodDayId).toBe(dayA);
    await expect(
      turns.setResolvedTarget({ ...base, foodDayId: dayA }),
    ).resolves.toEqual(targeted);

    const leftPlan = plan("GET_BODY_WEIGHT_HISTORY");
    const rightPlan = plan("SET_FOOD_DAY_COMPLETENESS");
    const outcomes = await Promise.allSettled([
      turns.setPlanOnce({ ...base, plan: leftPlan }),
      turns.setPlanOnce({ ...base, plan: rightPlan }),
    ]);
    expect(outcomes.every((item) => item.status === "fulfilled")).toBe(true);
    const stored = await turns.findByKey(userA, base.turnKey);
    expect(stored?.executionPlan).not.toBeNull();
    for (const outcome of outcomes) {
      if (outcome.status !== "fulfilled") throw outcome.reason;
      expect(outcome.value.executionPlan).toEqual(stored?.executionPlan);
    }
    await expect(
      pool.query(
        `update public.conversation_turns
       set execution_plan = $3::jsonb
       where user_id = $1 and turn_key = $2`,
        [
          userA,
          base.turnKey,
          JSON.stringify(
            plan(
              stored?.executionPlan?.slots[0]?.action ===
                "GET_BODY_WEIGHT_HISTORY"
                ? "SET_FOOD_DAY_COMPLETENESS"
                : "GET_BODY_WEIGHT_HISTORY",
            ),
          ),
        ],
      ),
    ).rejects.toThrow("conversation execution plan is immutable");
    await expect(
      turns.setPlanOnce({ ...base, plan: stored!.executionPlan! }),
    ).resolves.toEqual(stored);
    await expect(
      turns.setResolvedTarget({ ...base, foodDayId: dayB }),
    ).rejects.toBeInstanceOf(AccountTurnStateConflictError);

    const completions = await Promise.all([
      turns.markCompleted({ ...base, response: "  First public answer.  " }),
      turns.markCompleted({ ...base, response: "  Second public answer.  " }),
    ]);
    expect(completions.map((item) => item.disposition).sort()).toEqual([
      "COMPLETED",
      "REPLAYED",
    ]);
    expect(completions[0]?.turn).toEqual(completions[1]?.turn);
    expect(completions[0]?.turn.completedAt).toEqual(expect.any(String));
    expect(["  First public answer.  ", "  Second public answer.  "]).toContain(
      completions[0]?.turn.response,
    );
    await expect(
      turns.claimPending({ ...base, id: randomUUID() }),
    ).resolves.toMatchObject({
      disposition: "EXISTING",
      turn: { status: "COMPLETED", response: completions[0]?.turn.response },
    });
    await expect(
      pool.query(
        "update public.conversation_turns set response = 'rewritten' where user_id = $1 and turn_key = $2",
        [userA, base.turnKey],
      ),
    ).rejects.toThrow("completed conversation turns are immutable");
  });

  it("stores a target-bound direct-response plan while pending and returns the first durable value", async () => {
    const base = claimInput(`calcalc:account-turn:v1:${randomUUID()}`);
    await turns.claimPending({ ...base, id: randomUUID() });
    await turns.setResolvedTarget({ ...base, foodDayId: dayA });
    const firstPlan = {
      schema: "account-turn-plan-v1" as const,
      foodDayId: dayA,
      slots: [
        {
          index: 0,
          action: "DIRECT_RESPONSE" as const,
          command: { response: "Exact answer." },
        },
      ],
    };
    const first = await turns.setPlanOnce({ ...base, plan: firstPlan });
    expect(first).toMatchObject({
      status: "PENDING",
      response: null,
      executionPlan: firstPlan,
    });
    const losing = await turns.setPlanOnce({
      ...base,
      plan: {
        ...firstPlan,
        slots: [
          {
            index: 0,
            action: "DIRECT_RESPONSE",
            command: { response: "Different answer." },
          },
        ],
      },
    });
    expect(losing.executionPlan).toEqual(firstPlan);
    expect(await turns.findByKey(userB, base.turnKey)).toBeNull();
  });

  it("returns only the newest eight completed exact transcript pairs oldest to newest", async () => {
    const expected: { userMessage: string; response: string }[] = [];
    for (let index = 0; index < 10; index += 1) {
      const base = claimInput(`calcalc:account-turn:v1:${randomUUID()}`, {
        userMessage: `  message ${index}  `,
      });
      await turns.claimPending({ ...base, id: randomUUID() });
      if (index === 0) continue; // Pending must never appear in transcript.
      const response = `  response ${index}  `;
      await turns.markCompleted({ ...base, response });
      expected.push({ userMessage: base.userMessage, response });
    }
    expect(await turns.listRecentCompleted(userA)).toEqual(expected.slice(-8));
    expect(await turns.listRecentCompleted(userB)).toEqual([]);
    await expect(turns.listRecentCompleted(userA, 9)).rejects.toThrow();
  });

  it("does not grant authenticated direct reads or writes to internal tables", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await expect(
        client.query("select * from public.conversation_turns limit 1"),
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

function claimInput(turnKey: string, overrides: { userMessage?: string } = {}) {
  return {
    userId: userA,
    turnKey,
    requestFingerprint: `fingerprint-${turnKey}`,
    userMessage: overrides.userMessage ?? "  Exact accepted message.  ",
    calendarContext: {
      schema: "client-calendar-v1" as const,
      currentLocalDate: "2026-10-13",
    },
  };
}

function plan(action: "GET_BODY_WEIGHT_HISTORY" | "SET_FOOD_DAY_COMPLETENESS") {
  return {
    schema: "account-turn-plan-v1" as const,
    slots: [
      {
        index: 0,
        action,
        command:
          action === "GET_BODY_WEIGHT_HISTORY"
            ? {}
            : { targetCompleteness: "PARTIAL" },
      },
    ],
  };
}
