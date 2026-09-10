import { randomUUID } from "node:crypto";

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
const command = {
  calorieTarget: "2400.0",
  proteinTarget: "119.00",
  localDate: "2026-09-10",
  timezone: "UTC",
};

describe("real authenticated exactly-once HTTP FoodDay creation", () => {
  beforeAll(async () => {
    accountA = await createAccount("a");
    accountB = await createAccount("b");
    await runtime.pool.query(
      "insert into public.profiles (user_id) values ($1), ($2)",
      [accountA.id, accountB.id],
    );
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
      await cleanup("FoodDay cleanup", () =>
        runtime.pool.query(
          "delete from public.food_days where user_id = any($1::uuid[])",
          [createdUserIds],
        ),
      );
      await cleanup("Operation cleanup", () =>
        runtime.pool.query(
          "delete from public.semantic_operations where user_id = any($1::uuid[])",
          [createdUserIds],
        ),
      );
      await cleanup("Profile cleanup", () =>
        runtime.pool.query(
          "delete from public.profiles where user_id = any($1::uuid[])",
          [createdUserIds],
        ),
      );
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
        "HTTP creation integration cleanup failed.",
      );
  });

  it("creates an owned canonical row and returns only the authoritative DTO", async () => {
    const key = randomUUID();
    const response = await post(accountA, key);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toEqual({
      disposition: "CREATED",
      foodDay: {
        id: expect.any(String),
        status: "OPEN",
        completeness: "UNKNOWN",
        calorieTarget: "2400",
        proteinTarget: "119",
        localDate: command.localDate,
        timezone: "UTC",
        openedAt: expect.any(String),
        closedAt: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    const stored = await runtime.pool.query(
      "select user_id, calorie_target::text, protein_target::text, to_jsonb(opened_at) #>> '{}' as opened_at from public.food_days where id = $1",
      [body.foodDay.id],
    );
    expect(stored.rows).toEqual([
      {
        user_id: accountA.id,
        calorie_target: "2400",
        protein_target: "119",
        opened_at: body.foodDay.openedAt,
      },
    ]);
    const operations = await runtime.pool.query(
      "select status, result, operation_key, request_fingerprint from public.semantic_operations where user_id = $1 and result ->> 'foodDayId' = $2",
      [accountA.id, body.foodDay.id],
    );
    expect(operations.rows).toHaveLength(1);
    expect(operations.rows[0]).toMatchObject({
      status: "SUCCEEDED",
      result: { kind: "FOOD_DAY_CREATED", foodDayId: body.foodDay.id },
    });
    for (const secret of [
      accountA.id,
      accountA.token,
      key,
      operations.rows[0].operation_key,
      operations.rows[0].request_fingerprint,
    ])
      expect(response.body).not.toContain(secret);
  });

  it("replays exact and normalized-equivalent requests with one row and operation", async () => {
    const key = randomUUID();
    const first = await post(accountA, key);
    expect(first.statusCode).toBe(201);
    const afterCreate = await counts();
    for (const body of [
      command,
      { ...command, calorieTarget: "2400.00", proteinTarget: "119" },
    ]) {
      const replay = await post(accountA, key, body);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({
        ...first.json(),
        disposition: "REPLAYED",
      });
      expect(await counts()).toEqual(afterCreate);
    }
    const rows = await runtime.pool.query(
      "select (select count(*)::text from public.food_days where id = $1::uuid) as days, (select count(*)::text from public.semantic_operations where user_id = $2 and result ->> 'foodDayId' = ($1::uuid)::text) as operations",
      [first.json().foodDay.id, accountA.id],
    );
    expect(rows.rows).toEqual([{ days: "1", operations: "1" }]);
  });

  it("rejects changed meaning without creating another row", async () => {
    const key = randomUUID();
    expect((await post(accountA, key)).statusCode).toBe(201);
    const before = await counts();
    const conflict = await post(accountA, key, {
      ...command,
      calorieTarget: "2500",
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency key was already used for a different request.",
      },
    });
    expect(await counts()).toEqual(before);
  });

  it("creates distinct OPEN days on the same date for new explicit retry identities", async () => {
    const a = await post(accountA, randomUUID());
    const b = await post(accountA, randomUUID());
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().foodDay.id).not.toBe(b.json().foodDay.id);
    expect(a.json().foodDay.localDate).toBe(b.json().foodDay.localDate);
    const rows = await runtime.pool.query(
      "select status, local_date::text from public.food_days where id = any($1::uuid[])",
      [[a.json().foodDay.id, b.json().foodDay.id]],
    );
    expect(rows.rows).toEqual([
      { status: "OPEN", local_date: command.localDate },
      { status: "OPEN", local_date: command.localDate },
    ]);
  });

  it("lets independent users reuse the same external key without touching the other's row", async () => {
    const key = randomUUID();
    const a = await post(accountA, key);
    expect(a.statusCode).toBe(201);
    const original = await runtime.pool.query(
      "select * from public.food_days where id = $1",
      [a.json().foodDay.id],
    );
    const b = await post(accountB, key);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().foodDay.id).not.toBe(b.json().foodDay.id);
    expect(
      (
        await runtime.pool.query(
          "select user_id from public.food_days where id = $1",
          [b.json().foodDay.id],
        )
      ).rows,
    ).toEqual([{ user_id: accountB.id }]);
    expect(
      (
        await runtime.pool.query(
          "select * from public.food_days where id = $1",
          [a.json().foodDay.id],
        )
      ).rows,
    ).toEqual(original.rows);
    const operations = await runtime.pool.query(
      "select operation_key from public.semantic_operations where result ->> 'foodDayId' = any($1::text[])",
      [[a.json().foodDay.id, b.json().foodDay.id]],
    );
    expect(new Set(operations.rows.map((row) => row.operation_key)).size).toBe(
      2,
    );
  });

  it("ignores spoofed query/header ownership and rejects ownership in the body", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/food-days?userId=${accountB.id}`,
      headers: {
        authorization: `Bearer ${accountA.token}`,
        "idempotency-key": randomUUID(),
        "x-user-id": accountB.id,
      },
      payload: command,
    });
    expect(response.statusCode).toBe(201);
    expect(
      (
        await runtime.pool.query(
          "select user_id from public.food_days where id = $1",
          [response.json().foodDay.id],
        )
      ).rows,
    ).toEqual([{ user_id: accountA.id }]);
    const before = await counts();
    const rejected = await post(accountA, randomUUID(), {
      ...command,
      userId: accountB.id,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("INVALID_CREATE_FOOD_DAY");
    expect(await counts()).toEqual(before);
  });

  it("rejects missing/invalid/duplicate retry keys without mutation", async () => {
    const before = await counts();
    for (const key of [undefined, "bad key", ["first", "second"]]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-days",
        headers: {
          authorization: `Bearer ${accountA.token}`,
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        payload: command,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "A valid Idempotency-Key is required.",
        },
      });
    }
    expect(await counts()).toEqual(before);
  });

  it("rejects missing and genuinely tampered Auth tokens without mutation", async () => {
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
        url: "/v1/food-days",
        headers: {
          "idempotency-key": randomUUID(),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        payload: command,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Authentication required." },
      });
      expect(response.body).not.toContain(accountA.token);
      expect(response.body).not.toContain(tampered);
    }
    expect(await counts()).toEqual(before);
  });
});

function post(account: Account, key: string, body: unknown = command) {
  return app.inject({
    method: "POST",
    url: "/v1/food-days",
    headers: {
      authorization: `Bearer ${account.token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
}

async function counts() {
  const result = await runtime.pool.query(
    "select (select count(*)::text from public.food_days where user_id = any($1::uuid[])) as days, (select count(*)::text from public.semantic_operations where user_id = any($1::uuid[])) as operations",
    [createdUserIds],
  );
  return result.rows[0];
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(
      `${name} is required for the HTTP creation integration test.`,
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
    email: `cal-calc-m3e-${label}-${randomUUID()}@example.invalid`,
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
