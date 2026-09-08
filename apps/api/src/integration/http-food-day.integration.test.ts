import { randomUUID } from "node:crypto";

import { createFoodDay } from "@cal-calc/domain";
import {
  PostgresFoodDayRepository,
  type PersistedFoodDay,
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
const databaseUrl = requiredEnvironment("DATABASE_URL");
const runtime = createPostgresRuntime({ connectionString: databaseUrl });
const app = createApiApp({
  authVerifier: createSupabaseAccessTokenVerifier({
    supabaseUrl,
    supabasePublishableKey: publishableKey,
  }),
  postgres: runtime.pool,
});
const adminClient = fixtureClient(secretKey);
const createdUserIds: string[] = [];
interface Account {
  readonly id: string;
  readonly token: string;
}
let accountA: Account;
let accountB: Account;
let dayA: PersistedFoodDay;
let dayB: PersistedFoodDay;
const unauthenticated = {
  error: { code: "UNAUTHENTICATED", message: "Authentication required." },
};

describe("authenticated HTTP FoodDay reads with real Supabase and PostgreSQL", () => {
  beforeAll(async () => {
    accountA = await createAccount("a");
    accountB = await createAccount("b");
    await runtime.pool.query(
      "insert into public.profiles (user_id) values ($1), ($2)",
      [accountA.id, accountB.id],
    );
    const repository = new PostgresFoodDayRepository(runtime.pool);
    dayA = await repository.create({
      userId: accountA.id,
      foodDay: createFoodDay({
        id: randomUUID(),
        status: "PROVISIONAL",
        calorieTarget: "685.1075",
        proteinTarget: "41.0025",
        maintenanceSnapshot: "2400.75",
        goalVersionId: "fixture-goal",
      }),
      completeness: "PARTIAL",
      localDate: "2026-09-08",
      timezone: "UTC",
    });
    dayB = await repository.create({
      userId: accountB.id,
      foodDay: createFoodDay({
        id: randomUUID(),
        status: "OPEN",
        calorieTarget: "2100.125",
        proteinTarget: "120.005",
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
    // Finish HTTP work first, then remove only this suite's fixtures in FK order.
    // Each cleanup step is attempted even if an earlier one fails.
    await cleanup("HTTP app shutdown", () => app.close());
    if (createdUserIds.length > 0) {
      await cleanup("FoodDay fixture cleanup", () =>
        runtime.pool.query(
          "delete from public.food_days where user_id = any($1::uuid[])",
          [createdUserIds],
        ),
      );
      await cleanup("Profile fixture cleanup", () =>
        runtime.pool.query(
          "delete from public.profiles where user_id = any($1::uuid[])",
          [createdUserIds],
        ),
      );
      for (const id of createdUserIds) {
        await cleanup("Auth fixture cleanup", async () => {
          const { error } = await adminClient.auth.admin.deleteUser(id);
          if (error !== null) throw new Error("Auth fixture deletion failed.");
        });
      }
    }
    await cleanup("PostgreSQL runtime shutdown", () => runtime.close());
    if (failures.length > 0)
      throw new AggregateError(failures, "HTTP integration cleanup failed.");
  });

  it("returns User A's canonical DTO through real verified identity and the repository", async () => {
    const response = await app.inject({
      url: `/v1/food-days/${dayA.foodDay.id}`,
      headers: { authorization: `Bearer ${accountA.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: dayA.foodDay.id,
      status: "PROVISIONAL",
      completeness: "PARTIAL",
      calorieTarget: "685.1075",
      proteinTarget: "41.0025",
      localDate: "2026-09-08",
      timezone: "UTC",
      openedAt: dayA.openedAt,
      closedAt: null,
      createdAt: dayA.createdAt,
      updatedAt: dayA.updatedAt,
    });
    expect(response.body).not.toContain("userId");
    expect(response.body).not.toContain(accountA.id);
    expect(response.body).not.toContain("fixture-goal");
  });

  it("returns User B's own day with explicit null optional fields", async () => {
    const response = await app.inject({
      url: `/v1/food-days/${dayB.foodDay.id}`,
      headers: { authorization: `Bearer ${accountB.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: dayB.foodDay.id,
      status: "OPEN",
      completeness: "UNKNOWN",
      calorieTarget: "2100.125",
      proteinTarget: "120.005",
      localDate: null,
      timezone: null,
      openedAt: dayB.openedAt,
      closedAt: null,
      createdAt: dayB.createdAt,
      updatedAt: dayB.updatedAt,
    });
  });

  it("returns the same 404 for either cross-account direction and a missing UUID", async () => {
    const aReadsB = await app.inject({
      url: `/v1/food-days/${dayB.foodDay.id}?userId=${accountB.id}`,
      headers: {
        authorization: `Bearer ${accountA.token}`,
        "x-user-id": accountB.id,
      },
    });
    const bReadsA = await app.inject({
      url: `/v1/food-days/${dayA.foodDay.id}?userId=${accountA.id}`,
      headers: {
        authorization: `Bearer ${accountB.token}`,
        "x-user-id": accountA.id,
      },
    });
    const missing = await app.inject({
      url: `/v1/food-days/${randomUUID()}`,
      headers: { authorization: `Bearer ${accountA.token}` },
    });
    for (const response of [aReadsB, bReadsA, missing]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: "NOT_FOUND", message: "Resource not found." },
      });
    }
    expect(aReadsB.body).toBe(missing.body);
    expect(bReadsA.body).toBe(missing.body);
  });

  it("does not let spoofed query/header identity change an owned read", async () => {
    const response = await app.inject({
      url: `/v1/food-days/${dayA.foodDay.id}?userId=${accountB.id}`,
      headers: {
        authorization: `Bearer ${accountA.token}`,
        "x-user-id": accountB.id,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(dayA.foodDay.id);
  });

  it("returns 401 for a missing token", async () => {
    const response = await app.inject(`/v1/food-days/${dayA.foodDay.id}`);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(unauthenticated);
  });

  it("returns a sanitized 401 for a tampered genuinely issued token", async () => {
    const parts = accountA.token.split(".");
    const signature = parts[2];
    if (parts.length !== 3 || signature === undefined || signature.length === 0)
      throw new Error("Expected an Auth JWT fixture.");
    parts[2] = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    const tampered = parts.join(".");
    const response = await app.inject({
      url: `/v1/food-days/${dayA.foodDay.id}`,
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(unauthenticated);
    expect(response.body).not.toContain(tampered);
    expect(response.body).not.toContain(accountA.token);
  });

  it("returns 400 for a malformed FoodDay UUID after valid authentication", async () => {
    const response = await app.inject({
      url: "/v1/food-days/not-a-uuid",
      headers: { authorization: `Bearer ${accountA.token}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_FOOD_DAY_ID",
        message: "Food day ID must be a UUID.",
      },
    });
  });
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`${name} is required for the HTTP integration test.`);
  return value;
}

function fixtureClient(key: string) {
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
    email: `cal-calc-m3c-${label}-${randomUUID()}@example.invalid`,
    password: `CalCalc-${randomUUID()}-Aa1!`,
  };
  const created = await adminClient.auth.admin.createUser({
    ...credentials,
    email_confirm: true,
  });
  if (created.error !== null || created.data.user === null)
    throw new Error("Auth fixture creation failed.");
  createdUserIds.push(created.data.user.id);
  const signedIn =
    await fixtureClient(publishableKey).auth.signInWithPassword(credentials);
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
