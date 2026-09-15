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

describe("real authenticated exactly-once HTTP FoodEntry quantity correction", () => {
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
        "HTTP FoodEntry update integration cleanup failed.",
      );
    }
  });

  it("applies one real quantity correction with canonical nutrition and revision linkage", async () => {
    const original = await createEntry();
    const key = randomUUID();
    const response = await patch(accountA, original.entry.id, key, 1, "250");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      disposition: "APPLIED",
      appliedRevision: 2,
      entry: {
        id: original.entry.id,
        quantity: { amount: "250", unit: "GRAM" },
        derivedNutrition: { calories: "622.825", protein: "37.275" },
        workingNutrition: { calories: "622.825", protein: "37.275" },
        revision: 2,
      },
    });
    const stored = await storedEntry(original.entry.id);
    expect(stored).toMatchObject({
      user_id: accountA.id,
      quantity_amount: "250",
      derived_nutrition: { calories: "622.825", protein: "37.275" },
      working_nutrition: { calories: "622.825", protein: "37.275" },
      revision: 2,
      last_operation_id: expect.any(String),
    });
    const operations = await entryOperations(accountA.id, original.entry.id);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      id: stored.last_operation_id,
      user_id: accountA.id,
      status: "SUCCEEDED",
      result: {
        kind: "FOOD_ENTRY_UPDATED",
        entryId: original.entry.id,
        appliedRevision: 2,
      },
    });
    expect(await revisionHistory(accountA.id, original.entry.id)).toEqual([
      { revision: 1, operation_id: null },
      { revision: 2, operation_id: stored.last_operation_id },
    ]);
  });

  it("replays exact and normalized-equivalent corrections without another revision or operation", async () => {
    const original = await createEntry();
    const key = randomUUID();
    const first = await patch(accountA, original.entry.id, key, 1, "0250.00");
    expect(first.statusCode).toBe(200);
    expect(first.json().disposition).toBe("APPLIED");
    const stored = await storedEntry(original.entry.id);
    const history = await revisionHistory(accountA.id, original.entry.id);
    const operations = await entryOperations(accountA.id, original.entry.id);

    for (const amount of ["0250.00", "250.000"]) {
      const replay = await patch(accountA, original.entry.id, key, 1, amount);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({
        ...first.json(),
        disposition: "REPLAYED",
      });
      expect(replay.json().entry.id).toBe(original.entry.id);
      expect(replay.json().appliedRevision).toBe(2);
      expect(await storedEntry(original.entry.id)).toEqual(stored);
      expect(await revisionHistory(accountA.id, original.entry.id)).toEqual(
        history,
      );
      expect(await entryOperations(accountA.id, original.entry.id)).toEqual(
        operations,
      );
    }
    expect(history).toHaveLength(2);
    expect(operations).toHaveLength(1);
  });

  it("rejects changed meaning under the same key without another update revision", async () => {
    const original = await createEntry();
    const key = randomUUID();
    expect(
      (await patch(accountA, original.entry.id, key, 1, "250")).statusCode,
    ).toBe(200);
    const stored = await storedEntry(original.entry.id);
    const history = await revisionHistory(accountA.id, original.entry.id);
    const operations = await entryOperations(accountA.id, original.entry.id);

    const conflict = await patch(accountA, original.entry.id, key, 1, "275");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency key was already used for a different request.",
      },
    });
    expect(await storedEntry(original.entry.id)).toEqual(stored);
    expect(await revisionHistory(accountA.id, original.entry.id)).toEqual(
      history,
    );
    expect(await entryOperations(accountA.id, original.entry.id)).toEqual(
      operations,
    );
  });

  it("rolls back a fresh semantic claim for a stale first execution", async () => {
    const original = await createEntry();
    expect(
      (await patch(accountA, original.entry.id, randomUUID(), 1, "250"))
        .statusCode,
    ).toBe(200);
    const stored = await storedEntry(original.entry.id);
    const history = await revisionHistory(accountA.id, original.entry.id);
    const operations = await operationCount(accountA.id);

    const stale = await patch(
      accountA,
      original.entry.id,
      randomUUID(),
      1,
      "275",
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: {
        code: "FOOD_ENTRY_REVISION_CONFLICT",
        message: "Food entry revision conflict.",
      },
    });
    expect(await storedEntry(original.entry.id)).toEqual(stored);
    expect(await revisionHistory(accountA.id, original.entry.id)).toEqual(
      history,
    );
    expect(await operationCount(accountA.id)).toBe(operations);
  });

  it("applies a new explicit correction intent at the current revision", async () => {
    const original = await createEntry();
    const first = await patch(
      accountA,
      original.entry.id,
      randomUUID(),
      1,
      "250",
    );
    expect(first.statusCode).toBe(200);
    const second = await patch(
      accountA,
      original.entry.id,
      randomUUID(),
      2,
      "300",
    );
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      disposition: "APPLIED",
      appliedRevision: 3,
      entry: {
        id: original.entry.id,
        quantity: { amount: "300", unit: "GRAM" },
        derivedNutrition: { calories: "747.39", protein: "44.73" },
        workingNutrition: { calories: "747.39", protein: "44.73" },
        revision: 3,
      },
    });
    const stored = await storedEntry(original.entry.id);
    expect(stored).toMatchObject({
      user_id: accountA.id,
      quantity_amount: "300",
      revision: 3,
    });
    const history = await revisionHistory(accountA.id, original.entry.id);
    expect(history).toHaveLength(3);
    expect(history.map((row) => row.revision)).toEqual([1, 2, 3]);
    expect(history[1]?.operation_id).not.toBeNull();
    expect(history[2]?.operation_id).not.toBeNull();
    expect(history[2]?.operation_id).not.toBe(history[1]?.operation_id);
    expect(await entryOperations(accountA.id, original.entry.id)).toHaveLength(
      2,
    );
  });

  it("rejects User B's correction of User A's entry without state or claim leakage", async () => {
    const original = await createEntry();
    const stored = await storedEntry(original.entry.id);
    const history = await revisionHistory(accountA.id, original.entry.id);
    const operationsA = await operationCount(accountA.id);
    const operationsB = await operationCount(accountB.id);

    const denied = await patch(
      accountB,
      original.entry.id,
      randomUUID(),
      1,
      "250",
    );
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Resource not found." },
    });
    expect(await storedEntry(original.entry.id)).toEqual(stored);
    expect(await revisionHistory(accountA.id, original.entry.id)).toEqual(
      history,
    );
    expect(await operationCount(accountA.id)).toBe(operationsA);
    expect(await operationCount(accountB.id)).toBe(operationsB);
    expect((await storedEntry(original.entry.id)).user_id).toBe(accountA.id);
  });
});

function patch(
  account: Account,
  entryId: string,
  key: string,
  expectedRevision: number,
  amount: string,
) {
  return app.inject({
    method: "PATCH",
    url: `/v1/food-entries/${entryId}/quantity`,
    headers: {
      authorization: `Bearer ${account.token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify({
      expectedRevision,
      quantity: { amount, unit: "GRAM" },
      overrideAction: { type: "PRESERVE" },
    }),
  });
}

async function createEntry() {
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
  return new PostgresFoodEntryRepository(runtime.pool).create({
    userId: accountA.id,
    entry,
  });
}

async function storedEntry(entryId: string) {
  const result = await runtime.pool.query(
    `select user_id,
            quantity_amount::text as quantity_amount,
            derived_nutrition,
            working_nutrition,
            revision,
            last_operation_id
     from public.food_entries
     where id = $1`,
    [entryId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

async function revisionHistory(userId: string, entryId: string) {
  const result = await runtime.pool.query(
    `select revision, operation_id
     from public.food_entry_revisions
     where user_id = $1 and food_entry_id = $2
     order by revision`,
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
    `select count(*)::text as count
     from public.semantic_operations
     where user_id = $1`,
    [userId],
  );
  return result.rows[0]?.count;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is required for the HTTP FoodEntry update integration test.`,
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
    email: `cal-calc-m3g2d-${label}-${randomUUID()}@example.invalid`,
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
