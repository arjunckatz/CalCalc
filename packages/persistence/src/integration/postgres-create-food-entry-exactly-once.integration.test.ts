import { randomUUID } from "node:crypto";

import { createFoodEntry, type FoodEntry } from "@cal-calc/domain";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFoodEntryExactlyOnce,
  PostgresFoodEntryRepository,
  PostgresSemanticOperationRepository,
  SemanticOperationIdempotencyConflictError,
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
    "DATABASE_URL is required for the PostgreSQL exactly-once FoodEntry integration test.",
  );
}

const client = new Client({ connectionString: databaseUrl });
const transactionRunner = new ClientTransactionRunner(client);
const foodEntryRepository = new PostgresFoodEntryRepository(client);
const operationRepository = new PostgresSemanticOperationRepository(client);
const userA = testUser();
const userB = testUser();
const dayAId = randomUUID();
const dayBId = randomUUID();
const consumedAt = "2026-09-04T14:30:00.000Z";
let connected = false;

describe("PostgreSQL exactly-once FoodEntry creation", () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    await createFixtures(client, [userA, userB], [dayAId, dayBId]);
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await cleanupFixtures(client, [userA.id, userB.id]);
    } finally {
      await client.end();
    }
  });

  it("creates once, replays successful retries, rejects conflicts, and isolates accounts", async () => {
    const operationId = randomUUID();
    const operationKey = `log-meal-${randomUUID()}`;
    const fingerprint = `request-${randomUUID()}`;
    const entry = testEntry(randomUUID(), dayAId, "275 g chicken and rice");
    const input = {
      userId: userA.id,
      operationId,
      operationKey,
      requestFingerprint: fingerprint,
      entry,
      consumedAt,
      consumedTimePrecision: "APPROXIMATE" as const,
    };

    const created = await createFoodEntryExactlyOnce(transactionRunner, input);

    expect(created.disposition).toBe("CREATED");
    expect(created.entry.entry).toEqual(entry);
    expect(created.entry.userId).toBe(userA.id);
    expect(created.entry.lastOperationId).toBe(operationId);
    expect(new Date(created.entry.consumedAt ?? "").toISOString()).toBe(
      consumedAt,
    );
    expect(created.entry.consumedTimePrecision).toBe("APPROXIMATE");
    expect(created.entry.entry.derivedNutrition).toEqual({
      calories: "685.1075",
      protein: "41.0025",
    });
    expect(created.operation).toMatchObject({
      id: operationId,
      userId: userA.id,
      operationKey,
      requestFingerprint: fingerprint,
      status: "SUCCEEDED",
      result: { kind: "FOOD_ENTRY_CREATED", entryId: entry.id },
      error: null,
    });

    const loaded = await foodEntryRepository.findById(userA.id, entry.id);
    expect(loaded).toEqual(created.entry);
    expect(await foodEntryRepository.findById(userB.id, entry.id)).toBeNull();
    expect(await operationRepository.findByKey(userA.id, operationKey)).toEqual(
      created.operation,
    );
    expect(
      await rowCount("public.food_entries", userA.id, "id", entry.id),
    ).toBe("1");
    expect(
      await rowCount(
        "public.semantic_operations",
        userA.id,
        "operation_key",
        operationKey,
      ),
    ).toBe("1");

    const revision = await client.query<{
      readonly operation_id: string | null;
    }>(
      `select operation_id
       from public.food_entry_revisions
       where user_id = $1
         and food_entry_id = $2
         and revision = 1`,
      [userA.id, entry.id],
    );
    expect(revision.rows).toEqual([{ operation_id: operationId }]);

    const replayed = await createFoodEntryExactlyOnce(transactionRunner, {
      ...input,
      operationId: randomUUID(),
    });
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.entry).toEqual(created.entry);
    expect(replayed.operation).toEqual(created.operation);
    expect(
      await rowCount("public.food_entries", userA.id, "id", entry.id),
    ).toBe("1");
    expect(
      await rowCount(
        "public.semantic_operations",
        userA.id,
        "operation_key",
        operationKey,
      ),
    ).toBe("1");
    expect(
      await rowCount(
        "public.food_entry_revisions",
        userA.id,
        "food_entry_id",
        entry.id,
      ),
    ).toBe("1");

    const conflictingFingerprint = `request-${randomUUID()}`;
    await expect(
      createFoodEntryExactlyOnce(transactionRunner, {
        ...input,
        operationId: randomUUID(),
        requestFingerprint: conflictingFingerprint,
      }),
    ).rejects.toMatchObject({
      name: "SemanticOperationIdempotencyConflictError",
      operationKey,
      existingFingerprint: fingerprint,
      suppliedFingerprint: conflictingFingerprint,
    } satisfies Partial<SemanticOperationIdempotencyConflictError>);
    expect(await foodEntryRepository.findById(userA.id, entry.id)).toEqual(
      created.entry,
    );
    expect(await operationRepository.findByKey(userA.id, operationKey)).toEqual(
      created.operation,
    );

    expect(
      await operationRepository.findByKey(userB.id, operationKey),
    ).toBeNull();
    const userBEntry = testEntry(
      randomUUID(),
      dayBId,
      "User B chicken and rice",
    );
    const userBCreated = await createFoodEntryExactlyOnce(transactionRunner, {
      userId: userB.id,
      operationId: randomUUID(),
      operationKey,
      requestFingerprint: `request-${randomUUID()}`,
      entry: userBEntry,
    });
    expect(userBCreated.disposition).toBe("CREATED");
    expect(userBCreated.entry.userId).toBe(userB.id);
    expect(userBCreated.entry.entry.id).toBe(userBEntry.id);
    expect(userBCreated.entry.entry.id).not.toBe(entry.id);
    expect(await foodEntryRepository.findById(userB.id, entry.id)).toBeNull();
  });

  it("rolls back the operation claim when FoodEntry persistence fails", async () => {
    const operationKey = `ownership-failure-${randomUUID()}`;
    const entry = testEntry(
      randomUUID(),
      dayBId,
      "Valid entry for the wrong owned FoodDay",
    );

    await expect(
      createFoodEntryExactlyOnce(transactionRunner, {
        userId: userA.id,
        operationId: randomUUID(),
        operationKey,
        requestFingerprint: `request-${randomUUID()}`,
        entry,
      }),
    ).rejects.toThrow();

    expect(await foodEntryRepository.findById(userA.id, entry.id)).toBeNull();
    expect(
      await operationRepository.findByKey(userA.id, operationKey),
    ).toBeNull();
    expect(
      await rowCount("public.food_entries", userA.id, "id", entry.id),
    ).toBe("0");
    expect(
      await rowCount(
        "public.semantic_operations",
        userA.id,
        "operation_key",
        operationKey,
      ),
    ).toBe("0");
  });
});

function testEntry(
  id: string,
  foodDayId: string,
  description: string,
): FoodEntry {
  return createFoodEntry({
    id,
    foodDayId,
    rawUserDescription: description,
    displayName: "Chicken and rice",
    quantity: { amount: "275", unit: "GRAM" },
    nutritionBasis: {
      amount: "100",
      unit: "GRAM",
      nutrition: { calories: "249.13", protein: "14.91" },
    },
    evidenceClass: "EXACT",
    status: "CONFIRMED_CONSUMED",
  });
}

function testUser(): TestUser {
  const id = randomUUID();
  return { id, email: `cal-calc-m2b6-${id}@example.invalid` };
}

async function rowCount(
  table: string,
  userId: string,
  identityColumn: string,
  identityValue: string,
): Promise<string> {
  if (
    ![
      "public.food_entries",
      "public.food_entry_revisions",
      "public.semantic_operations",
    ].includes(table) ||
    !["id", "food_entry_id", "operation_key"].includes(identityColumn)
  ) {
    throw new Error("Unsupported integration-test count query.");
  }
  const result = await client.query<{ readonly count: string }>(
    `select count(*)::text as count
     from ${table}
     where user_id = $1
       and ${identityColumn} = $2`,
    [userId, identityValue],
  );
  return result.rows[0]?.count ?? "0";
}

async function createFixtures(
  database: Client,
  users: readonly [TestUser, TestUser],
  dayIds: readonly [string, string],
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
  await database.query(
    `insert into public.food_days (
       id, user_id, status, completeness, calorie_target, protein_target,
       local_date, timezone
     ) values
       ($1, $2, 'OPEN', 'UNKNOWN', $3, $4, '2026-09-04', 'UTC'),
       ($5, $6, 'OPEN', 'UNKNOWN', $3, $4, '2026-09-04', 'UTC')`,
    [dayIds[0], users[0].id, "2100", "120", dayIds[1], users[1].id],
  );
}

async function cleanupFixtures(
  database: Client,
  userIds: readonly string[],
): Promise<void> {
  const parameters = [userIds];
  await database.query(
    "delete from public.food_entry_revisions where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from public.food_entries where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from public.semantic_operations where user_id = any($1::uuid[])",
    parameters,
  );
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
