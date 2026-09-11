import { randomUUID } from "node:crypto";

import { createFoodDay } from "@cal-calc/domain";
import { PostgresFoodDayRepository } from "@cal-calc/persistence";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createApiApp,
  createPostgresRuntime,
  createSupabaseAccessTokenVerifier,
  type CreateFoodEntryCommand,
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
const dayBId = randomUUID();
const nutrition = {
  calories: "685.1075",
  protein: "41.0025",
  carbs: "249.13",
  fat: "0.1",
};
const command: CreateFoodEntryCommand = {
  foodDayId: dayAId,
  rawUserDescription: "Lunch",
  displayName: "Lunch",
  quantity: { amount: "1.0", unit: "SERVING" },
  nutritionBasis: { amount: "1.00", unit: "SERVING", nutrition },
  evidenceClass: "SOURCED",
};

describe("real authenticated exactly-once HTTP FoodEntry creation", () => {
  beforeAll(async () => {
    accountA = await createAccount("a");
    accountB = await createAccount("b");
    await runtime.pool.query(
      "insert into public.profiles (user_id) values ($1), ($2)",
      [accountA.id, accountB.id],
    );
    const days = new PostgresFoodDayRepository(runtime.pool);
    for (const [account, id] of [
      [accountA, dayAId],
      [accountB, dayBId],
    ] as const) {
      await days.create({
        userId: account.id,
        foodDay: createFoodDay({
          id,
          status: "OPEN",
          calorieTarget: "2400",
          proteinTarget: "120",
        }),
        completeness: "UNKNOWN",
      });
    }
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
      // Privileged fixture cleanup, scoped to this suite's randomized users.
      // Keep attempting later steps even after a failure; never disable triggers.
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
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "HTTP FoodEntry integration cleanup failed.",
      );
  });

  it("creates an owned confirmed entry with an explicit DTO and exact persisted decimals", async () => {
    const key = randomUUID();
    const response = await post(accountA, key);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toEqual({
      disposition: "CREATED",
      entry: {
        id: expect.any(String),
        foodDayId: dayAId,
        rawUserDescription: "Lunch",
        displayName: "Lunch",
        quantity: { amount: "1", unit: "SERVING" },
        nutritionBasis: { amount: "1", unit: "SERVING", nutrition },
        derivedNutrition: nutrition,
        workingNutrition: nutrition,
        evidenceClass: "SOURCED",
        status: "CONFIRMED_CONSUMED",
        revision: 1,
        deletedAt: null,
      },
    });
    const stored = await runtime.pool.query(
      "select user_id, food_day_id, quantity_amount::text, nutrition_basis_amount::text, nutrition_basis, derived_nutrition, working_nutrition, status, revision, consumed_at, consumed_time_precision, last_operation_id from public.food_entries where id = $1",
      [body.entry.id],
    );
    expect(stored.rows).toEqual([
      {
        user_id: accountA.id,
        food_day_id: dayAId,
        quantity_amount: "1",
        nutrition_basis_amount: "1",
        nutrition_basis: nutrition,
        derived_nutrition: nutrition,
        working_nutrition: nutrition,
        status: "CONFIRMED_CONSUMED",
        revision: 1,
        consumed_at: null,
        consumed_time_precision: null,
        last_operation_id: expect.any(String),
      },
    ]);
    const operations = await entryOperations(body.entry.id);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      id: stored.rows[0].last_operation_id,
      user_id: accountA.id,
      status: "SUCCEEDED",
      result: { kind: "FOOD_ENTRY_CREATED", entryId: body.entry.id },
    });
    for (const secret of [
      accountA.id,
      accountA.token,
      key,
      operations[0].id,
      operations[0].operation_key,
      operations[0].request_fingerprint,
    ]) {
      expect(response.body).not.toContain(secret);
    }
  });

  it("replays exact and normalized requests with one persisted entry and operation identity", async () => {
    const key = randomUUID();
    const first = await post(accountA, key);
    expect(first.statusCode).toBe(201);
    const before = await counts();
    const operations = await entryOperations(first.json().entry.id);
    expect(operations).toHaveLength(1);
    for (const body of [
      command,
      {
        ...command,
        quantity: { amount: "1.00", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: {
            ...nutrition,
            calories: "685.107500",
            protein: "41.00250",
          },
        },
      },
    ]) {
      const replay = await post(accountA, key, body);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({
        ...first.json(),
        disposition: "REPLAYED",
      });
      expect(await counts()).toEqual(before);
      expect(await entryOperations(first.json().entry.id)).toEqual(operations);
    }
    const rows = await runtime.pool.query(
      "select count(*)::text as entries from public.food_entries where user_id = $1 and last_operation_id = $2",
      [accountA.id, operations[0].id],
    );
    expect(rows.rows).toEqual([{ entries: "1" }]);
  });

  it("rejects changed meaning without a second entry or operation", async () => {
    const key = randomUUID();
    const first = await post(accountA, key);
    expect(first.statusCode).toBe(201);
    const before = await counts();
    const original = await storedEntry(first.json().entry.id);
    const conflict = await post(accountA, key, {
      ...command,
      quantity: { amount: "2", unit: "SERVING" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency key was already used for a different request.",
      },
    });
    expect(await counts()).toEqual(before);
    expect(await storedEntry(first.json().entry.id)).toEqual(original);
  });

  it("persists identical food twice for distinct explicit retry identities", async () => {
    const a = await post(accountA, randomUUID());
    const b = await post(accountA, randomUUID());
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().entry.id).not.toBe(b.json().entry.id);
    const rows = await runtime.pool.query(
      "select user_id, food_day_id, working_nutrition from public.food_entries where id = any($1::uuid[])",
      [[a.json().entry.id, b.json().entry.id]],
    );
    expect(rows.rows).toEqual([
      {
        user_id: accountA.id,
        food_day_id: dayAId,
        working_nutrition: nutrition,
      },
      {
        user_id: accountA.id,
        food_day_id: dayAId,
        working_nutrition: nutrition,
      },
    ]);
    const opA = await entryOperations(a.json().entry.id);
    const opB = await entryOperations(b.json().entry.id);
    expect(opA).toHaveLength(1);
    expect(opB).toHaveLength(1);
    expect(opA[0].operation_key).not.toBe(opB[0].operation_key);
  });

  it("isolates shared external keys by user and rejects a cross-owned FoodDay without writes", async () => {
    const key = randomUUID();
    const a = await post(accountA, key);
    expect(a.statusCode).toBe(201);
    const original = await storedEntry(a.json().entry.id);
    const bodyB = { ...command, foodDayId: dayBId };
    const b = await post(accountB, key, bodyB);
    expect(b.statusCode).toBe(201);
    expect(b.json().entry.id).not.toBe(a.json().entry.id);
    expect(await storedEntry(b.json().entry.id)).toMatchObject({
      user_id: accountB.id,
      food_day_id: dayBId,
    });
    const replay = await post(accountB, key, bodyB);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...b.json(), disposition: "REPLAYED" });
    const opA = await entryOperations(a.json().entry.id);
    const opB = await entryOperations(b.json().entry.id);
    expect(opA).toHaveLength(1);
    expect(opB).toHaveLength(1);
    expect(opA[0].user_id).toBe(accountA.id);
    expect(opB[0].user_id).toBe(accountB.id);
    expect(opA[0].operation_key).not.toBe(opB[0].operation_key);
    const before = await counts();
    // Fresh key reaches the ownership FK, rather than merely conflicting on replay.
    const denied = await post(accountB, randomUUID(), command);
    // Existing FK violation is deliberately exposed only as a sanitized 500.
    expect(denied.statusCode).toBe(500);
    expect(denied.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "An internal error occurred." },
    });
    expect(await counts()).toEqual(before);
    expect(await storedEntry(a.json().entry.id)).toEqual(original);
    const crossOwned = await runtime.pool.query(
      "select count(*)::text as entries from public.food_entries where user_id = $1 and food_day_id = $2",
      [accountB.id, dayAId],
    );
    expect(crossOwned.rows).toEqual([{ entries: "0" }]);
  });

  it("does not write for missing/tampered auth or missing/invalid idempotency keys", async () => {
    const parts = accountA.token.split(".");
    const signature = parts[2];
    if (parts.length !== 3 || !signature)
      throw new Error("Expected an Auth JWT fixture.");
    parts[2] = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    const tampered = parts.join(".");
    const before = await counts();
    for (const token of [undefined, tampered]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-entries",
        payload: command,
        headers: {
          "idempotency-key": randomUUID(),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Authentication required." },
      });
      expect(response.body).not.toContain(accountA.token);
      expect(response.body).not.toContain(tampered);
      expect(await counts()).toEqual(before);
    }
    for (const key of [undefined, "invalid key"]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-entries",
        payload: command,
        headers: {
          authorization: `Bearer ${accountA.token}`,
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "A valid Idempotency-Key is required.",
        },
      });
      expect(await counts()).toEqual(before);
    }
  });
});

function post(account: Account, key: string, body: unknown = command) {
  return app.inject({
    method: "POST",
    url: "/v1/food-entries",
    headers: {
      authorization: `Bearer ${account.token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
}

async function storedEntry(id: string) {
  const rows = await runtime.pool.query(
    "select * from public.food_entries where id = $1",
    [id],
  );
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0];
}

async function entryOperations(id: string) {
  const result = await runtime.pool.query(
    "select id, user_id, operation_key, request_fingerprint, status, result from public.semantic_operations where user_id = any($1::uuid[]) and result ->> 'entryId' = $2 order by id",
    [createdUserIds, id],
  );
  return result.rows;
}

async function counts() {
  const result = await runtime.pool.query(
    "select (select count(*)::text from public.food_entries where user_id = any($1::uuid[])) as entries, (select count(*)::text from public.semantic_operations where user_id = any($1::uuid[])) as operations, (select count(*)::text from public.food_entry_revisions where user_id = any($1::uuid[])) as revisions",
    [createdUserIds],
  );
  return result.rows[0];
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(
      `${name} is required for the HTTP FoodEntry integration test.`,
    );
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
    email: `cal-calc-m3f3-${label}-${randomUUID()}@example.invalid`,
    password: `CalCalc-${randomUUID()}-Aa1!`,
  };
  const created = await admin.auth.admin.createUser({
    ...credentials,
    email_confirm: true,
  });
  if (created.error !== null || created.data.user === null)
    throw new Error("Auth fixture creation failed.");
  createdUserIds.push(created.data.user.id);
  const signedIn =
    await authClient(publishableKey).auth.signInWithPassword(credentials);
  if (
    signedIn.error !== null ||
    signedIn.data.session === null ||
    signedIn.data.user === null
  )
    throw new Error("Auth fixture sign-in failed.");
  expect(signedIn.data.user.id).toBe(created.data.user.id);
  return {
    id: created.data.user.id,
    token: signedIn.data.session.access_token,
  };
}
