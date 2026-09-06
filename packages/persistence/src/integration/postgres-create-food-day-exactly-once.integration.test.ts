import { randomUUID } from "node:crypto";

import { createFoodDay } from "@cal-calc/domain";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFoodDayExactlyOnce,
  PostgresFoodDayRepository,
  PostgresSemanticOperationRepository,
  SemanticOperationIdempotencyConflictError,
  type CreateFoodDayExactlyOnceInput,
  type PostgresExecutor,
  type PostgresTransactionRunner,
} from "../index.js";

interface TestUser {
  readonly id: string;
  readonly email: string;
}

class ClientTransactionRunner implements PostgresTransactionRunner {
  constructor(private readonly executor: PostgresExecutor) {}

  async runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ): Promise<Value> {
    await this.executor.query("begin");
    try {
      const value = await work(this.executor);
      await this.executor.query("commit");
      return value;
    } catch (error) {
      await this.executor.query("rollback");
      throw error;
    }
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the PostgreSQL exactly-once FoodDay creation integration test.",
  );
}

const client = new Client({ connectionString: databaseUrl });
const transactionRunner = new ClientTransactionRunner(client);
const foodDayRepository = new PostgresFoodDayRepository(client);
const operationRepository = new PostgresSemanticOperationRepository(client);
const userA = testUser();
const userB = testUser();
const userIds = [userA.id, userB.id];
const localDate = "2026-09-05";
let connected = false;

describe("PostgreSQL exactly-once FoodDay creation", () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    await createFixtures(client, [userA, userB]);
  });

  beforeEach(async () => {
    await cleanupLedger(client, userIds);
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await cleanupLedger(client, userIds);
      await client.query(
        "delete from public.profiles where user_id = any($1::uuid[])",
        [userIds],
      );
      await client.query("delete from auth.users where id = any($1::uuid[])", [
        userIds,
      ]);
    } finally {
      await client.end();
    }
  });

  it("creates one canonical FoodDay with exact target strings and semantic success", async () => {
    const input = workflowInput(userA.id);

    const created = await createFoodDayExactlyOnce(transactionRunner, input);

    expect(created.disposition).toBe("CREATED");
    expect(created.foodDay.foodDay).toEqual(input.foodDay);
    expect(created.foodDay).toMatchObject({
      userId: userA.id,
      completeness: "PARTIAL",
      localDate,
      timezone: "Asia/Calcutta",
    });
    expect(created.foodDay.foodDay.calorieTarget).toBe("2100.125");
    expect(created.foodDay.foodDay.proteinTarget).toBe("120.005");
    expect(created.foodDay.foodDay.maintenanceSnapshot).toBe("2400.75");
    expect(created.operation).toMatchObject({
      id: input.operationId,
      userId: userA.id,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
      status: "SUCCEEDED",
      error: null,
    });
    expect(created.operation.result).toEqual({
      kind: "FOOD_DAY_CREATED",
      foodDayId: input.foodDay.id,
    });
    expect(created.operation.completedAt).toEqual(expect.any(String));
    expect(
      await foodDayRepository.findById(userA.id, input.foodDay.id),
    ).toEqual(created.foodDay);
    expect(
      await operationRepository.findByKey(userA.id, input.operationKey),
    ).toEqual(created.operation);
    expect(await counts(userA.id)).toEqual({ foodDays: "1", operations: "1" });
  });

  it("replays a retry with a different supplied operation ID without mutation", async () => {
    const input = workflowInput(userA.id);
    const created = await createFoodDayExactlyOnce(transactionRunner, input);

    const replayed = await createFoodDayExactlyOnce(transactionRunner, {
      ...input,
      operationId: randomUUID(),
    });

    expect(replayed).toEqual({ ...created, disposition: "REPLAYED" });
    expect(
      await foodDayRepository.findById(userA.id, input.foodDay.id),
    ).toEqual(created.foodDay);
    expect(
      await operationRepository.findByKey(userA.id, input.operationKey),
    ).toEqual(created.operation);
    expect(await counts(userA.id)).toEqual({ foodDays: "1", operations: "1" });
  });

  it("rejects a fingerprint conflict without changing the FoodDay or semantic operation", async () => {
    const input = workflowInput(userA.id);
    const created = await createFoodDayExactlyOnce(transactionRunner, input);

    await expect(
      createFoodDayExactlyOnce(transactionRunner, {
        ...input,
        operationId: randomUUID(),
        requestFingerprint: `request-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);

    expect(
      await foodDayRepository.findById(userA.id, input.foodDay.id),
    ).toEqual(created.foodDay);
    expect(
      await operationRepository.findByKey(userA.id, input.operationKey),
    ).toEqual(created.operation);
    expect(await counts(userA.id)).toEqual({ foodDays: "1", operations: "1" });
  });

  it("rolls back a new claim when FoodDay insertion violates primary-key uniqueness", async () => {
    const input = workflowInput(userA.id);
    const existing = await foodDayRepository.create(input);

    await expect(
      createFoodDayExactlyOnce(transactionRunner, input),
    ).rejects.toMatchObject({ code: "23505", constraint: "food_days_pkey" });

    // These ownership-scoped reads run after ROLLBACK, outside the failed transaction.
    expect(
      await foodDayRepository.findById(userA.id, input.foodDay.id),
    ).toEqual(existing);
    expect(
      await operationRepository.findByKey(userA.id, input.operationKey),
    ).toBeNull();
    expect(await counts(userA.id)).toEqual({ foodDays: "1", operations: "0" });
  });

  it("creates two same-date FoodDays for two distinct semantic actions", async () => {
    const firstInput = workflowInput(userA.id);
    const secondInput = workflowInput(userA.id);

    const first = await createFoodDayExactlyOnce(transactionRunner, firstInput);
    const second = await createFoodDayExactlyOnce(
      transactionRunner,
      secondInput,
    );

    expect(first.disposition).toBe("CREATED");
    expect(second.disposition).toBe("CREATED");
    expect(first.operation.operationKey).not.toBe(
      second.operation.operationKey,
    );
    expect(first.operation.requestFingerprint).not.toBe(
      second.operation.requestFingerprint,
    );
    expect(first.foodDay.foodDay.id).not.toBe(second.foodDay.foodDay.id);
    expect(first.foodDay.localDate).toBe(localDate);
    expect(second.foodDay.localDate).toBe(localDate);
    const sameDate = await foodDayRepository.findByLocalDate(
      userA.id,
      localDate,
    );
    expect(sameDate).toHaveLength(2);
    expect(sameDate).toEqual(
      expect.arrayContaining([first.foodDay, second.foodDay]),
    );
    expect(await counts(userA.id)).toEqual({ foodDays: "2", operations: "2" });
  });

  it("allows User B to independently use User A's operation key without exposing A's FoodDay", async () => {
    const inputA = workflowInput(userA.id);
    const createdA = await createFoodDayExactlyOnce(transactionRunner, inputA);
    expect(
      await operationRepository.findByKey(userB.id, inputA.operationKey),
    ).toBeNull();
    expect(
      await foodDayRepository.findById(userB.id, inputA.foodDay.id),
    ).toBeNull();
    const inputB = {
      ...workflowInput(userB.id),
      operationKey: inputA.operationKey,
      requestFingerprint: inputA.requestFingerprint,
    };

    const createdB = await createFoodDayExactlyOnce(transactionRunner, inputB);

    expect(createdB.disposition).toBe("CREATED");
    expect(createdB.foodDay.userId).toBe(userB.id);
    expect(createdB.foodDay.foodDay).toEqual(inputB.foodDay);
    expect(createdB.foodDay.foodDay.id).not.toBe(inputA.foodDay.id);
    expect(createdB.operation.userId).toBe(userB.id);
    expect(createdB.operation.result).toEqual({
      kind: "FOOD_DAY_CREATED",
      foodDayId: inputB.foodDay.id,
    });
    const replayedB = await createFoodDayExactlyOnce(transactionRunner, {
      ...inputB,
      operationId: randomUUID(),
    });
    expect(replayedB).toEqual({ ...createdB, disposition: "REPLAYED" });
    expect(
      await foodDayRepository.findById(userB.id, inputA.foodDay.id),
    ).toBeNull();
    expect(
      await foodDayRepository.findById(userA.id, inputB.foodDay.id),
    ).toBeNull();
    expect(
      await foodDayRepository.findById(userA.id, inputA.foodDay.id),
    ).toEqual(createdA.foodDay);
    expect(
      await operationRepository.findByKey(userA.id, inputA.operationKey),
    ).toEqual(createdA.operation);
    expect(await counts(userA.id)).toEqual({ foodDays: "1", operations: "1" });
    expect(await counts(userB.id)).toEqual({ foodDays: "1", operations: "1" });
  });
});

function workflowInput(userId: string): CreateFoodDayExactlyOnceInput {
  return {
    userId,
    operationId: randomUUID(),
    operationKey: `start-day-${randomUUID()}`,
    requestFingerprint: `request-${randomUUID()}`,
    foodDay: createFoodDay({
      id: randomUUID(),
      status: "OPEN",
      calorieTarget: "2100.125",
      proteinTarget: "120.005",
      maintenanceSnapshot: "2400.75",
      goalVersionId: "goal-version-7",
    }),
    completeness: "PARTIAL",
    localDate,
    timezone: "Asia/Calcutta",
  };
}

async function counts(userId: string) {
  const days = await client.query<{ readonly count: string }>(
    "select count(*)::text as count from public.food_days where user_id = $1",
    [userId],
  );
  const operations = await client.query<{ readonly count: string }>(
    "select count(*)::text as count from public.semantic_operations where user_id = $1",
    [userId],
  );
  return {
    foodDays: days.rows[0]?.count,
    operations: operations.rows[0]?.count,
  };
}

function testUser(): TestUser {
  const id = randomUUID();
  return { id, email: `cal-calc-m2b10-${id}@example.invalid` };
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

async function cleanupLedger(
  database: Client,
  ids: readonly string[],
): Promise<void> {
  await database.query(
    "delete from public.semantic_operations where user_id = any($1::uuid[])",
    [ids],
  );
  await database.query(
    "delete from public.food_days where user_id = any($1::uuid[])",
    [ids],
  );
}
