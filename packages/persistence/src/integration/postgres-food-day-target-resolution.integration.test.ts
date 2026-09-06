import { randomUUID } from "node:crypto";

import type { FoodDayStatus } from "@cal-calc/domain";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  FoodDayNotFoundError,
  PostgresFoodDayRepository,
  resolveFoodDayTarget,
  type ResolveFoodDayTargetInput,
} from "../index.js";

interface TestUser {
  readonly id: string;
  readonly email: string;
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the PostgreSQL FoodDay target resolution integration test.",
  );
}

const client = new Client({ connectionString: databaseUrl });
const repository = new PostgresFoodDayRepository(client);
const userA = testUser();
const userB = testUser();
const userIds = [userA.id, userB.id];
let connected = false;

describe("PostgreSQL conservative FoodDay target resolution", () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    await createFixtures(client, [userA, userB]);
  });

  beforeEach(async () => {
    await client.query(
      "delete from public.food_days where user_id = any($1::uuid[])",
      [userIds],
    );
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await cleanupFixtures(client, userIds);
    } finally {
      await client.end();
    }
  });

  it("resolves a sole OPEN day with an intentionally old local date", async () => {
    const foodDay = await fixtureDay(userA.id, "OPEN", "2001-01-01");

    expect(await resolveWithoutMutation({ userId: userA.id })).toEqual({
      disposition: "RESOLVED",
      reason: "SOLE_NON_CLOSED",
      foodDay,
    });
  });

  it("excludes CLOSED history even when it shares the OPEN day's local date", async () => {
    const foodDay = await fixtureDay(userA.id, "OPEN", "2001-01-01");
    await fixtureDay(userA.id, "CLOSED", "2001-01-01");

    expect(await resolveWithoutMutation({ userId: userA.id })).toEqual({
      disposition: "RESOLVED",
      reason: "SOLE_NON_CLOSED",
      foodDay,
    });
  });

  it("returns both OPEN and PROVISIONAL candidates without choosing the newest", async () => {
    const older = await fixtureDay(userA.id, "OPEN", "2026-09-04");
    const newer = await fixtureDay(userA.id, "PROVISIONAL", "2026-09-05");
    await fixtureDay(userA.id, "CLOSED", "2026-09-05");
    await fixtureDay(userB.id, "OPEN", "2026-09-05");

    expect(await resolveWithoutMutation({ userId: userA.id })).toEqual({
      disposition: "AMBIGUOUS",
      candidates: [newer, older],
    });
  });

  it("resolves an explicit CLOSED target even when an OPEN candidate exists", async () => {
    const foodDay = await fixtureDay(userA.id, "CLOSED", "2001-01-01");
    await fixtureDay(userA.id, "OPEN", "2026-09-05");

    expect(
      await resolveWithoutMutation({
        userId: userA.id,
        foodDayId: foodDay.foodDay.id,
      }),
    ).toEqual({ disposition: "RESOLVED", reason: "EXPLICIT", foodDay });
  });

  it("rejects a cross-account explicit ID without falling back to the caller's OPEN day", async () => {
    const ownedByA = await fixtureDay(userA.id, "OPEN", "2001-01-01");
    await fixtureDay(userB.id, "OPEN", "2026-09-05");

    await expect(
      resolveWithoutMutation({
        userId: userB.id,
        foodDayId: ownedByA.foodDay.id,
      }),
    ).rejects.toBeInstanceOf(FoodDayNotFoundError);
  });

  it("returns NONE for only CLOSED history without creating a day or using another account", async () => {
    await fixtureDay(userA.id, "CLOSED", "2001-01-01");
    await fixtureDay(userB.id, "OPEN", "2026-09-05");

    expect(await resolveWithoutMutation({ userId: userA.id })).toEqual({
      disposition: "NONE",
    });
  });
});

async function resolveWithoutMutation(input: ResolveFoodDayTargetInput) {
  const before = await ledgerState();
  expect(before.foodEntries).toBe("0");
  expect(before.semanticOperations).toBe("0");
  try {
    return await resolveFoodDayTarget(repository, input);
  } finally {
    // Compare complete FoodDay rows (including timestamps) and both counts,
    // including when explicit resolution rejects. Fixtures are outside this check.
    expect(await ledgerState()).toEqual(before);
  }
}

async function ledgerState() {
  const foodDays = await client.query<Record<string, unknown>>(
    "select * from public.food_days where user_id = any($1::uuid[]) order by id",
    [userIds],
  );
  const foodEntries = await client.query<{ readonly count: string }>(
    "select count(*)::text as count from public.food_entries where user_id = any($1::uuid[])",
    [userIds],
  );
  const semanticOperations = await client.query<{ readonly count: string }>(
    "select count(*)::text as count from public.semantic_operations where user_id = any($1::uuid[])",
    [userIds],
  );
  return {
    foodDays: foodDays.rows,
    foodEntries: foodEntries.rows[0]?.count,
    semanticOperations: semanticOperations.rows[0]?.count,
  };
}

async function fixtureDay(
  userId: string,
  status: FoodDayStatus,
  localDate: string,
) {
  const id = randomUUID();
  const openedAt = `${localDate}T00:00:00.000Z`;
  await client.query(
    `insert into public.food_days (
       id, user_id, status, completeness, calorie_target, protein_target,
       local_date, timezone, opened_at, closed_at
     ) values (
       $1, $2, $3::public.food_day_status, 'UNKNOWN', $6, $7,
       $4::date, 'UTC', $5::timestamptz,
       case when $3::public.food_day_status = 'CLOSED' then $5::timestamptz else null end
     )`,
    [id, userId, status, localDate, openedAt, "2100.125", "120.005"],
  );
  const foodDay = await repository.findById(userId, id);
  if (foodDay === null) throw new Error("Missing FoodDay fixture.");
  return foodDay;
}

function testUser(): TestUser {
  const id = randomUUID();
  return { id, email: `cal-calc-m2b9-${id}@example.invalid` };
}

async function createFixtures(
  database: Client,
  users: readonly [TestUser, TestUser],
): Promise<void> {
  await database.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values
       ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
       ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [users[0].id, users[0].email, users[1].id, users[1].email],
  );
  await database.query(
    "insert into public.profiles (user_id) values ($1), ($2)",
    [users[0].id, users[1].id],
  );
}

async function cleanupFixtures(
  database: Client,
  ids: readonly string[],
): Promise<void> {
  await database.query(
    "delete from public.food_days where user_id = any($1::uuid[])",
    [ids],
  );
  await database.query(
    "delete from public.profiles where user_id = any($1::uuid[])",
    [ids],
  );
  await database.query("delete from auth.users where id = any($1::uuid[])", [
    ids,
  ]);
}
