import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FoodDayTurnIdempotencyConflictError,
  PostgresFoodDayTurnResultRepository,
} from "../index.js";

interface TestUser {
  readonly id: string;
  readonly email: string;
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the completed FoodDay-turn repository integration test.",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const repository = new PostgresFoodDayTurnResultRepository(pool);
const userA = testUser();
const userB = testUser();
const dayA = randomUUID();
const otherDayA = randomUUID();
const transcriptDayA = randomUUID();
const dayB = randomUUID();

describe("PostgreSQL completed FoodDay-turn repository", () => {
  beforeAll(async () => {
    await createFixtures();
  });

  afterAll(async () => {
    try {
      await cleanupFixtures();
    } finally {
      await pool.end();
    }
  });

  it("persists, replays, isolates, conflicts, and keeps the first response immutable", async () => {
    const turnKey = `calcalc:food-day-turn:v1:${randomUUID()}`;
    const requestFingerprint = `request-${randomUUID()}`;
    const userMessage = "  Exact persisted message.  ";
    const first = await repository.saveCompleted({
      id: randomUUID(),
      userId: userA.id,
      foodDayId: dayA,
      turnKey,
      requestFingerprint,
      userMessage,
      response: "First persisted response.",
    });
    expect(first.disposition).toBe("CREATED");
    expect(first.turn).toMatchObject({
      userId: userA.id,
      foodDayId: dayA,
      turnKey,
      requestFingerprint,
      userMessage,
      response: "First persisted response.",
    });
    await expect(
      repository.findCompleted({
        userId: userA.id,
        foodDayId: dayA,
        turnKey,
        requestFingerprint,
      }),
    ).resolves.toEqual(first.turn);

    const duplicate = await repository.saveCompleted({
      id: randomUUID(),
      userId: userA.id,
      foodDayId: dayA,
      turnKey,
      requestFingerprint,
      userMessage,
      response: "Losing response must not overwrite.",
    });
    expect(duplicate).toEqual({ disposition: "EXISTING", turn: first.turn });
    expect(duplicate.turn.response).toBe("First persisted response.");

    await expect(
      repository.saveCompleted({
        id: randomUUID(),
        userId: userA.id,
        foodDayId: dayA,
        turnKey,
        requestFingerprint: `changed-${randomUUID()}`,
        userMessage: "Changed request message.",
        response: "Changed request must not overwrite.",
      }),
    ).rejects.toBeInstanceOf(FoodDayTurnIdempotencyConflictError);
    await expect(
      repository.findCompleted({
        userId: userA.id,
        foodDayId: otherDayA,
        turnKey,
        requestFingerprint,
      }),
    ).rejects.toBeInstanceOf(FoodDayTurnIdempotencyConflictError);
    await expect(
      repository.findCompleted({
        userId: userB.id,
        foodDayId: dayB,
        turnKey,
        requestFingerprint,
      }),
    ).resolves.toBeNull();

    await expect(
      pool.query(
        `update public.food_day_turn_results
         set user_message = 'overwritten'
         where id = $1`,
        [first.turn.id],
      ),
    ).rejects.toThrow("completed FoodDay turn results are immutable");
    expect(
      await repository.findCompleted({
        userId: userA.id,
        foodDayId: dayA,
        turnKey,
        requestFingerprint,
      }),
    ).toEqual(first.turn);

    const count = await pool.query<{ readonly count: string }>(
      `select count(*)::text as count
       from public.food_day_turn_results
       where user_id = $1 and turn_key = $2`,
      [userA.id, turnKey],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("resolves simultaneous identical inserts to one durable winner", async () => {
    const turnKey = `calcalc:food-day-turn:v1:${randomUUID()}`;
    const requestFingerprint = `request-${randomUUID()}`;
    const userMessage = "  Concurrent exact message.  ";
    const base = {
      userId: userA.id,
      foodDayId: dayA,
      turnKey,
      requestFingerprint,
      userMessage,
    };
    const [left, right] = await Promise.all([
      repository.saveCompleted({
        ...base,
        id: randomUUID(),
        response: "Concurrent left response.",
      }),
      repository.saveCompleted({
        ...base,
        id: randomUUID(),
        response: "Concurrent right response.",
      }),
    ]);

    expect([left.disposition, right.disposition].sort()).toEqual([
      "CREATED",
      "EXISTING",
    ]);
    expect(left.turn).toEqual(right.turn);
    expect([
      "Concurrent left response.",
      "Concurrent right response.",
    ]).toContain(left.turn.response);
    const count = await pool.query<{ readonly count: string }>(
      `select count(*)::text as count
       from public.food_day_turn_results
       where user_id = $1 and turn_key = $2`,
      [userA.id, turnKey],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("returns the newest bounded owned transcript in chronological order", async () => {
    const tiePrefix = randomUUID().slice(0, 24);
    const ids = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      `${tiePrefix}000000000001`,
      `${tiePrefix}000000000002`,
    ];
    const transcript = [
      ["Message A", "Response A", "2026-09-29T00:01:00.000Z"],
      ["Message B", "Response B", "2026-09-29T00:02:00.000Z"],
      ["  Message C  ", "  Response C  ", "2026-09-29T00:03:00.000Z"],
      ["Message D", "Response D", "2026-09-29T00:04:00.000Z"],
      ["Message E", "Response E", "2026-09-29T00:04:00.000Z"],
    ] as const;
    for (const [
      index,
      [message, response, createdAt],
    ] of transcript.entries()) {
      await insertTranscriptFixture({
        id: ids[index] ?? randomUUID(),
        userId: userA.id,
        foodDayId: transcriptDayA,
        userMessage: message,
        response,
        createdAt,
      });
    }
    await insertTranscriptFixture({
      id: randomUUID(),
      userId: userA.id,
      foodDayId: otherDayA,
      userMessage: "Other FoodDay message",
      response: "Other FoodDay response",
      createdAt: "2026-09-29T00:05:00.000Z",
    });
    await insertTranscriptFixture({
      id: randomUUID(),
      userId: userB.id,
      foodDayId: dayB,
      userMessage: "Other user message",
      response: "Other user response",
      createdAt: "2026-09-29T00:05:00.000Z",
    });

    const client = await pool.connect();
    try {
      await client.query("begin");
      // NOT VALID constraints still reject new invalid rows. Simulate one
      // historical row transactionally, then roll the schema change back.
      await client.query(
        `alter table public.food_day_turn_results
         drop constraint food_day_turn_results_user_message_nonblank`,
      );
      await client.query(
        `insert into public.food_day_turn_results (
           id, user_id, food_day_id, turn_key, request_fingerprint,
           user_message, response, created_at
         ) values ($1, $2, $3, $4, $5, null, $6, $7)`,
        [
          randomUUID(),
          userA.id,
          transcriptDayA,
          `integration-turn-${randomUUID()}`,
          `integration-request-${randomUUID()}`,
          "Legacy response must be skipped",
          "2026-09-29T00:06:00.000Z",
        ],
      );
      const transactionRepository = new PostgresFoodDayTurnResultRepository(
        client,
      );

      await expect(
        transactionRepository.listRecentCompletedForFoodDay({
          userId: userA.id,
          foodDayId: transcriptDayA,
          limit: 3,
        }),
      ).resolves.toEqual([
        { userMessage: "  Message C  ", response: "  Response C  " },
        { userMessage: "Message D", response: "Response D" },
        { userMessage: "Message E", response: "Response E" },
      ]);
      await expect(
        transactionRepository.listRecentCompletedForFoodDay({
          userId: userA.id,
          foodDayId: dayB,
          limit: 3,
        }),
      ).resolves.toEqual([]);
    } finally {
      try {
        await client.query("rollback");
      } finally {
        client.release();
      }
    }
  });
});

function testUser(): TestUser {
  const id = randomUUID();
  return { id, email: `cal-calc-m4c2a-${id}@example.invalid` };
}

async function createFixtures(): Promise<void> {
  await pool.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values
       ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
       ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [userA.id, userA.email, userB.id, userB.email],
  );
  await pool.query("insert into public.profiles (user_id) values ($1), ($2)", [
    userA.id,
    userB.id,
  ]);
  await pool.query(
    `insert into public.food_days (
       id, user_id, status, completeness, calorie_target, protein_target
     ) values
       ($1, $2, 'OPEN', 'UNKNOWN', 2100, 120),
       ($3, $2, 'OPEN', 'UNKNOWN', 2100, 120),
       ($4, $2, 'OPEN', 'UNKNOWN', 2100, 120),
       ($5, $6, 'OPEN', 'UNKNOWN', 2100, 120)`,
    [dayA, userA.id, otherDayA, transcriptDayA, dayB, userB.id],
  );
}

async function insertTranscriptFixture(input: {
  readonly id: string;
  readonly userId: string;
  readonly foodDayId: string;
  readonly userMessage: string;
  readonly response: string;
  readonly createdAt: string;
}): Promise<void> {
  await pool.query(
    `insert into public.food_day_turn_results (
       id, user_id, food_day_id, turn_key, request_fingerprint,
       user_message, response, created_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.userId,
      input.foodDayId,
      `integration-turn-${randomUUID()}`,
      `integration-request-${randomUUID()}`,
      input.userMessage,
      input.response,
      input.createdAt,
    ],
  );
}

async function cleanupFixtures(): Promise<void> {
  const userIds = [userA.id, userB.id];
  for (const table of [
    "food_day_turn_results",
    "food_days",
    "profiles",
  ] as const) {
    await pool.query(
      `delete from public.${table} where user_id = any($1::uuid[])`,
      [userIds],
    );
  }
  await pool.query("delete from auth.users where id = any($1::uuid[])", [
    userIds,
  ]);
}
