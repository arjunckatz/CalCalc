import { randomUUID } from "node:crypto";

import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import {
  PostgresFoodDayRepository,
  PostgresFoodEntryRepository,
} from "@cal-calc/persistence";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createApiApp,
  createPostgresRuntime,
  createSupabaseAccessTokenVerifier,
} from "../index.js";

const supabaseUrl = requiredEnvironment("SUPABASE_URL");
const publishableKey = requiredEnvironment("SUPABASE_PUBLISHABLE_KEY");
const secretKey = requiredEnvironment("SUPABASE_SECRET_KEY");
const runtime = createPostgresRuntime({
  connectionString: requiredEnvironment("DATABASE_URL"),
});
const app = createApiApp({
  authVerifier: createSupabaseAccessTokenVerifier({
    supabaseUrl,
    supabasePublishableKey: publishableKey,
  }),
  postgres: runtime.pool,
  transactionRunner: runtime.transactionRunner,
});
const admin = authClient(secretKey);
const createdUserIds: string[] = [];
interface Account {
  readonly id: string;
  readonly token: string;
}
let accountA: Account;
let accountB: Account;
const dayAId = randomUUID();

describe("real authenticated exactly-once HTTP FoodEntry removal", () => {
  beforeAll(async () => {
    accountA = await createAccount("a");
    accountB = await createAccount("b");
    await runtime.pool.query(
      "insert into public.profiles (user_id) values ($1), ($2)",
      [accountA.id, accountB.id],
    );
    await new PostgresFoodDayRepository(runtime.pool).create({
      userId: accountA.id,
      foodDay: createFoodDay({
        id: dayAId,
        status: "OPEN",
        calorieTarget: "2400",
        proteinTarget: "120",
      }),
      completeness: "UNKNOWN",
    });
  });

  afterAll(async () => {
    const failures: Error[] = [];
    async function cleanup(label: string, work: () => Promise<unknown>) {
      try {
        await work();
      } catch {
        failures.push(new Error(`${label} failed.`));
      }
    }
    await cleanup("HTTP shutdown", () => app.close());
    if (createdUserIds.length > 0) {
      for (const table of [
        "food_entry_revisions",
        "food_entries",
        "semantic_operations",
        "food_days",
        "profiles",
      ] as const) {
        await cleanup(`${table} cleanup`, () =>
          runtime.pool.query(
            `delete from public.${table} where user_id = any($1::uuid[])`,
            [createdUserIds],
          ),
        );
      }
      for (const id of createdUserIds) {
        await cleanup("Auth cleanup", async () => {
          const { error } = await admin.auth.admin.deleteUser(id);
          if (error !== null) throw new Error("Auth fixture deletion failed.");
        });
      }
    }
    await cleanup("PostgreSQL shutdown", () => runtime.close());
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "HTTP FoodEntry removal integration cleanup failed.",
      );
    }
  });

  it("logically removes one entry and persists an attributed revision and succeeded operation", async () => {
    const entryId = await createEntry();
    const response = await remove(accountA, entryId, randomUUID(), 1);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      disposition: "APPLIED",
      appliedRevision: 2,
      entry: { id: entryId, revision: 2, deletedAt: expect.any(String) },
    });
    const stored = await storedEntry(entryId);
    expect(stored).toMatchObject({
      id: entryId,
      user_id: accountA.id,
      revision: 2,
      deleted_at: expect.any(String),
      last_operation_id: expect.any(String),
    });
    const operations = await entryOperations(accountA.id, entryId);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      id: stored.last_operation_id,
      user_id: accountA.id,
      status: "SUCCEEDED",
      result: { kind: "FOOD_ENTRY_UPDATED", entryId, appliedRevision: 2 },
    });
    expect(await revisionHistory(accountA.id, entryId)).toEqual([
      { revision: 1, operation_id: null, deleted_at: null },
      {
        revision: 2,
        operation_id: stored.last_operation_id,
        deleted_at: stored.deleted_at,
      },
    ]);
  });

  it("replays without replacing the persisted deletion timestamp, row, history, or operation", async () => {
    const entryId = await createEntry();
    const key = randomUUID();
    const first = await remove(accountA, entryId, key, 1);
    expect(first.statusCode).toBe(200);
    expect(first.json().disposition).toBe("APPLIED");
    const stored = await storedEntry(entryId);
    const history = await revisionHistory(accountA.id, entryId);
    const operations = await entryOperations(accountA.id, entryId);
    expect(stored.deleted_at).toEqual(expect.any(String));

    const replay = await remove(accountA, entryId, key, 1);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...first.json(), disposition: "REPLAYED" });
    expect(replay.json()).toMatchObject({
      appliedRevision: 2,
      entry: { id: entryId, deletedAt: first.json().entry.deletedAt },
    });
    expect((await storedEntry(entryId)).deleted_at).toBe(stored.deleted_at);
    expect(await storedEntry(entryId)).toEqual(stored);
    expect(await revisionHistory(accountA.id, entryId)).toEqual(history);
    expect(await entryOperations(accountA.id, entryId)).toEqual(operations);
    expect(history).toHaveLength(2);
    expect(operations).toHaveLength(1);
  });

  it("rejects a changed expected revision under the same key without another write", async () => {
    const entryId = await createEntry();
    const key = randomUUID();
    expect((await remove(accountA, entryId, key, 1)).statusCode).toBe(200);
    const stored = await storedEntry(entryId);
    const history = await revisionHistory(accountA.id, entryId);
    const operations = await entryOperations(accountA.id, entryId);

    const conflict = await remove(accountA, entryId, key, 2);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency key was already used for a different request.",
      },
    });
    expect(await storedEntry(entryId)).toEqual(stored);
    expect(await revisionHistory(accountA.id, entryId)).toEqual(history);
    expect(await entryOperations(accountA.id, entryId)).toEqual(operations);
  });

  it("rolls back a fresh operation claim for a stale first execution", async () => {
    const entryId = await createEntry();
    expect((await remove(accountA, entryId, randomUUID(), 1)).statusCode).toBe(
      200,
    );
    const stored = await storedEntry(entryId);
    const history = await revisionHistory(accountA.id, entryId);
    const operations = await operationCount(accountA.id);

    const stale = await remove(accountA, entryId, randomUUID(), 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: {
        code: "FOOD_ENTRY_REVISION_CONFLICT",
        message: "Food entry revision conflict.",
      },
    });
    expect(await storedEntry(entryId)).toEqual(stored);
    expect(await revisionHistory(accountA.id, entryId)).toEqual(history);
    expect(await operationCount(accountA.id)).toBe(operations);
  });

  it("rejects a fresh removal intent for an already-deleted entry", async () => {
    const entryId = await createEntry();
    expect((await remove(accountA, entryId, randomUUID(), 1)).statusCode).toBe(
      200,
    );
    const stored = await storedEntry(entryId);
    const history = await revisionHistory(accountA.id, entryId);
    const operations = await operationCount(accountA.id);

    const rejected = await remove(accountA, entryId, randomUUID(), 2);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({
      error: {
        code: "INVALID_REMOVE_FOOD_ENTRY",
        message: "Invalid FoodEntry removal request.",
      },
    });
    expect(await storedEntry(entryId)).toEqual(stored);
    expect(await revisionHistory(accountA.id, entryId)).toEqual(history);
    expect(await operationCount(accountA.id)).toBe(operations);
  });

  it("does not let User B remove User A's entry or retain an operation claim", async () => {
    const entryId = await createEntry();
    const stored = await storedEntry(entryId);
    const history = await revisionHistory(accountA.id, entryId);
    const operationsA = await operationCount(accountA.id);
    const operationsB = await operationCount(accountB.id);

    const denied = await remove(accountB, entryId, randomUUID(), 1);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Resource not found." },
    });
    expect(await storedEntry(entryId)).toEqual(stored);
    expect((await storedEntry(entryId)).user_id).toBe(accountA.id);
    expect(await revisionHistory(accountA.id, entryId)).toEqual(history);
    expect(await operationCount(accountA.id)).toBe(operationsA);
    expect(await operationCount(accountB.id)).toBe(operationsB);
  });
});

function remove(
  account: Account,
  entryId: string,
  key: string,
  expectedRevision: number,
) {
  return app.inject({
    method: "DELETE",
    url: `/v1/food-entries/${entryId}`,
    headers: {
      authorization: `Bearer ${account.token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify({ expectedRevision }),
  });
}

async function createEntry(): Promise<string> {
  const entry = createFoodEntry({
    id: randomUUID(),
    foodDayId: dayAId,
    rawUserDescription: "200 g chicken and rice",
    displayName: "Chicken and rice",
    quantity: { amount: "200", unit: "GRAM" },
    nutritionBasis: {
      amount: "100",
      unit: "GRAM",
      nutrition: { calories: "249.13", protein: "14.91" },
    },
    evidenceClass: "EXACT",
    status: "CONFIRMED_CONSUMED",
  });
  const persisted = await new PostgresFoodEntryRepository(runtime.pool).create({
    userId: accountA.id,
    entry,
  });
  return persisted.entry.id;
}

async function storedEntry(entryId: string) {
  const result = await runtime.pool.query(
    `select id, user_id, revision, to_jsonb(deleted_at) #>> '{}' as deleted_at,
            last_operation_id
     from public.food_entries where id = $1`,
    [entryId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

async function revisionHistory(userId: string, entryId: string) {
  const result = await runtime.pool.query(
    `select revision, operation_id, snapshot ->> 'deleted_at' as deleted_at
     from public.food_entry_revisions
     where user_id = $1 and food_entry_id = $2 order by revision`,
    [userId, entryId],
  );
  return result.rows;
}

async function entryOperations(userId: string, entryId: string) {
  const result = await runtime.pool.query(
    `select id, user_id, operation_key, request_fingerprint, status, result
     from public.semantic_operations
     where user_id = $1 and result ->> 'entryId' = $2
     order by created_at, id`,
    [userId, entryId],
  );
  return result.rows;
}

async function operationCount(userId: string) {
  const result = await runtime.pool.query(
    `select count(*)::text as count from public.semantic_operations where user_id = $1`,
    [userId],
  );
  return result.rows[0]?.count;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is required for the HTTP FoodEntry removal integration test.`,
    );
  }
  return value;
}

function authClient(key: string) {
  return createClient(supabaseUrl, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function createAccount(label: string): Promise<Account> {
  const credentials = {
    email: `cal-calc-m3h3-${label}-${randomUUID()}@example.invalid`,
    password: `CalCalc-${randomUUID()}-Aa1!`,
  };
  const created = await admin.auth.admin.createUser({
    ...credentials,
    email_confirm: true,
  });
  if (created.error !== null || created.data.user === null) {
    throw new Error("Auth fixture creation failed.");
  }
  createdUserIds.push(created.data.user.id);
  const signedIn =
    await authClient(publishableKey).auth.signInWithPassword(credentials);
  if (
    signedIn.error !== null ||
    signedIn.data.session === null ||
    signedIn.data.user === null
  ) {
    throw new Error("Auth fixture sign-in failed.");
  }
  expect(signedIn.data.user.id).toBe(created.data.user.id);
  return {
    id: created.data.user.id,
    token: signedIn.data.session.access_token,
  };
}
