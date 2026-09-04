import { randomUUID } from "node:crypto";

import { createFoodDay } from "@cal-calc/domain";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FoodDayNotFoundError, PostgresFoodDayRepository } from "../index.js";

interface TestUser {
  readonly id: string;
  readonly email: string;
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the PostgreSQL FoodDay repository integration test.",
  );
}

const client = new Client({ connectionString: databaseUrl });
const repository = new PostgresFoodDayRepository(client);
const userA = testUser();
const userB = testUser();
const localDate = "2026-09-04";
let connected = false;

describe("PostgreSQL FoodDay repository", () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    await createFixtures(client, [userA, userB]);
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await cleanupFixtures(client, [userA.id, userB.id]);
    } finally {
      await client.end();
    }
  });

  it("round-trips, preserves same-date multiplicity, isolates users, and updates", async () => {
    const firstDay = createFoodDay({
      id: randomUUID(),
      status: "PROVISIONAL",
      calorieTarget: "2100.125",
      proteinTarget: "120.005",
      maintenanceSnapshot: "2400.75",
      goalVersionId: "goal-version-7",
    });
    const secondDay = createFoodDay({
      id: randomUUID(),
      status: "OPEN",
      calorieTarget: "2050.375",
      proteinTarget: "125.015",
    });

    const createdFirst = await repository.create({
      userId: userA.id,
      foodDay: firstDay,
      completeness: "PARTIAL",
      localDate,
      timezone: "Asia/Calcutta",
    });
    const createdSecond = await repository.create({
      userId: userA.id,
      foodDay: secondDay,
      completeness: "UNKNOWN",
      localDate,
      timezone: "Asia/Calcutta",
    });

    expect(createdFirst.foodDay).toEqual(firstDay);
    expect(createdFirst.foodDay.calorieTarget).toBe("2100.125");
    expect(createdFirst.foodDay.proteinTarget).toBe("120.005");
    expect(createdFirst.foodDay.maintenanceSnapshot).toBe("2400.75");
    expect(typeof createdFirst.foodDay.calorieTarget).toBe("string");
    expect(createdFirst).toMatchObject({
      userId: userA.id,
      completeness: "PARTIAL",
      localDate,
      timezone: "Asia/Calcutta",
    });
    expect(await repository.findById(userA.id, firstDay.id)).toEqual(
      createdFirst,
    );
    expect(await repository.findById(userB.id, firstDay.id)).toBeNull();

    const sameDate = await repository.findByLocalDate(userA.id, localDate);
    const expectedOrder = [createdFirst, createdSecond].toSorted(
      (left, right) =>
        left.openedAt === right.openedAt
          ? left.foodDay.id.localeCompare(right.foodDay.id)
          : left.openedAt.localeCompare(right.openedAt),
    );
    expect(sameDate).toEqual(expectedOrder);
    expect(sameDate.map(({ foodDay }) => foodDay.id)).toHaveLength(2);

    const userBDay = createFoodDay({
      id: randomUUID(),
      status: "OPEN",
      calorieTarget: "1999.875",
      proteinTarget: "110.025",
    });
    const createdUserB = await repository.create({
      userId: userB.id,
      foodDay: userBDay,
      completeness: "UNKNOWN",
      localDate,
      timezone: "UTC",
    });
    expect(await repository.findByLocalDate(userB.id, localDate)).toEqual([
      createdUserB,
    ]);

    const closedAt = new Date(Date.now() + 60_000).toISOString();
    const updatedDay = createFoodDay({
      id: firstDay.id,
      status: "CLOSED",
      calorieTarget: "2075.625",
      proteinTarget: "123.045",
      maintenanceSnapshot: "2399.95",
      goalVersionId: "goal-version-8",
    });
    const updated = await repository.update({
      userId: userA.id,
      foodDay: updatedDay,
      completeness: "USER_DECLARED_COMPLETE",
      localDate,
      timezone: "Asia/Calcutta",
      closedAt,
    });
    expect(updated.foodDay).toEqual(updatedDay);
    expect(updated.foodDay.calorieTarget).toBe("2075.625");
    expect(updated.foodDay.proteinTarget).toBe("123.045");
    expect(updated.foodDay.maintenanceSnapshot).toBe("2399.95");
    expect(new Date(updated.closedAt ?? "").toISOString()).toBe(closedAt);
    expect(updated.openedAt).toBe(createdFirst.openedAt);
    expect(updated.createdAt).toBe(createdFirst.createdAt);
    expect(await repository.findById(userA.id, firstDay.id)).toEqual(updated);

    await expect(
      repository.update({
        userId: userB.id,
        foodDay: updatedDay,
        completeness: "UNKNOWN",
      }),
    ).rejects.toBeInstanceOf(FoodDayNotFoundError);
    expect(await repository.findById(userA.id, firstDay.id)).toEqual(updated);
  });
});

function testUser(): TestUser {
  const id = randomUUID();
  return { id, email: `cal-calc-m2b7-${id}@example.invalid` };
}

async function createFixtures(
  database: Client,
  users: readonly [TestUser, TestUser],
): Promise<void> {
  await database.query(
    `insert into auth.users (
       instance_id,
       id,
       aud,
       role,
       email,
       encrypted_password,
       email_confirmed_at,
       raw_app_meta_data,
       raw_user_meta_data,
       created_at,
       updated_at
     ) values
       ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
       ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [users[0].id, users[0].email, users[1].id, users[1].email],
  );
  await database.query(
    `insert into public.profiles (user_id) values ($1), ($2)`,
    [users[0].id, users[1].id],
  );
}

async function cleanupFixtures(
  database: Client,
  userIds: readonly string[],
): Promise<void> {
  const parameters = [userIds];
  await database.query(
    "delete from public.food_days where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from public.profiles where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from auth.users where id = any($1::uuid[])",
    parameters,
  );
}
