import { randomUUID } from "node:crypto";

import { createFoodDay } from "@cal-calc/domain";
import { PostgresFoodDayRepository } from "@cal-calc/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresRuntime, type PostgresRuntime } from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the PostgreSQL runtime integration test.",
  );
}

const userId = randomUUID();
const email = `cal-calc-m3a-${userId}@example.invalid`;
let runtime: PostgresRuntime;

describe("production PostgreSQL runtime", () => {
  beforeAll(async () => {
    runtime = createPostgresRuntime({ connectionString: databaseUrl });
    await runtime.pool.query(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password,
         email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
         created_at, updated_at
       ) values (
         '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '',
         now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
       )`,
      [userId, email],
    );
    await runtime.pool.query(
      "insert into public.profiles (user_id) values ($1)",
      [userId],
    );
  });

  afterAll(async () => {
    if (runtime === undefined) return;
    try {
      await runtime.pool.query(
        "delete from public.food_days where user_id = $1",
        [userId],
      );
      await runtime.pool.query(
        "delete from public.profiles where user_id = $1",
        [userId],
      );
      await runtime.pool.query("delete from auth.users where id = $1", [
        userId,
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("commits a FoodDay that is visible outside the transaction on another connection", async () => {
    const foodDay = testFoodDay();
    // Reserve an independent observer so an uncommitted write on a reused
    // transaction connection cannot make this assertion pass accidentally.
    const observer = await runtime.pool.connect();
    try {
      const created = await runtime.transactionRunner.runInTransaction(
        async (executor) => {
          expect(executor).not.toBe(runtime.pool);
          expect(executor).not.toBe(observer);
          return new PostgresFoodDayRepository(executor).create({
            userId,
            foodDay,
            completeness: "UNKNOWN",
          });
        },
      );

      expect(created.foodDay).toEqual(foodDay);
      expect(
        await new PostgresFoodDayRepository(observer).findById(
          userId,
          foodDay.id,
        ),
      ).toEqual(created);
    } finally {
      observer.release();
    }
  });

  it("rolls back a created FoodDay when the transaction callback rejects", async () => {
    const foodDay = testFoodDay();
    const failure = new Error("Intentional transaction rollback.");

    await expect(
      runtime.transactionRunner.runInTransaction(async (executor) => {
        await new PostgresFoodDayRepository(executor).create({
          userId,
          foodDay,
          completeness: "UNKNOWN",
        });
        throw failure;
      }),
    ).rejects.toBe(failure);

    // The runner has released its client; this lookup uses the Pool outside it.
    expect(
      await new PostgresFoodDayRepository(runtime.pool).findById(
        userId,
        foodDay.id,
      ),
    ).toBeNull();
  });

  it("keeps repeated callback queries on the same PostgreSQL backend", async () => {
    await runtime.transactionRunner.runInTransaction(async (executor) => {
      const first = await executor.query("select pg_backend_pid() as pid");
      const second = await executor.query("select pg_backend_pid() as pid");

      expect(first.rows).toEqual([{ pid: expect.any(Number) }]);
      expect(second.rows).toEqual(first.rows);
    });
  });
});

function testFoodDay() {
  return createFoodDay({
    id: randomUUID(),
    status: "OPEN",
    calorieTarget: "2100.125",
    proteinTarget: "120.005",
  });
}
