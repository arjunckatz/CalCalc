import { randomUUID } from "node:crypto";

import { createFoodDay } from "@cal-calc/domain";
import { PostgresFoodDayRepository } from "@cal-calc/persistence";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createApiApp,
  createFoodDayTurnRunner,
  createPostgresRuntime,
  createSupabaseAccessTokenVerifier,
  type FoodDayTurnModel,
} from "../index.js";

const supabaseUrl = requiredEnvironment("SUPABASE_URL");
const publishableKey = requiredEnvironment("SUPABASE_PUBLISHABLE_KEY");
const secretKey = requiredEnvironment("SUPABASE_SECRET_KEY");
const runtime = createPostgresRuntime({
  connectionString: requiredEnvironment("DATABASE_URL"),
});
const admin = authClient(secretKey);
const createdUserIds: string[] = [];
const foodDayId = randomUUID();
const finalMessage = "What are my confirmed totals?";
const logMessage = "  Log 200 g of yogurt.  ";

interface Account {
  readonly id: string;
  readonly token: string;
}

let account: Account;

const decide = vi.fn<FoodDayTurnModel["decide"]>(async (input) => {
  if (input.userMessage === finalMessage) {
    return { type: "FINAL", text: "No confirmed food is logged yet." };
  }
  if (input.userMessage !== logMessage) {
    throw new Error("Unexpected integration model message.");
  }
  return {
    type: "TOOLS",
    calls: [
      {
        name: "LOG_FOOD",
        arguments: {
          rawUserDescription: "200 g yogurt",
          displayName: "Yogurt",
          quantity: { amount: "200", unit: "GRAM" },
          nutritionBasis: {
            amount: "200",
            unit: "GRAM",
            nutrition: { calories: "120", protein: "10" },
          },
          evidenceClass: "EXACT",
        },
      },
    ],
  };
});

const finalize = vi.fn<FoodDayTurnModel["finalize"]>(async () =>
  Promise.resolve("Logged 200 g of yogurt."),
);
const model: FoodDayTurnModel = { decide, finalize };
const app = createApiApp({
  authVerifier: createSupabaseAccessTokenVerifier({
    supabaseUrl,
    supabasePublishableKey: publishableKey,
  }),
  postgres: runtime.pool,
  transactionRunner: runtime.transactionRunner,
  foodDayTurn: createFoodDayTurnRunner({
    postgres: runtime.pool,
    transactionRunner: runtime.transactionRunner,
    model,
  }),
});

describe.sequential(
  "real authenticated HTTP FoodDay conversational turn",
  () => {
    beforeAll(async () => {
      account = await createAccount();
      await runtime.pool.query(
        "insert into public.profiles (user_id) values ($1)",
        [account.id],
      );
      await new PostgresFoodDayRepository(runtime.pool).create({
        userId: account.id,
        foodDay: createFoodDay({
          id: foodDayId,
          status: "OPEN",
          calorieTarget: "2100",
          proteinTarget: "120",
        }),
        completeness: "PARTIAL",
        localDate: "2026-09-28",
        timezone: "Asia/Calcutta",
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
          "food_day_turn_results",
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
            if (error !== null)
              throw new Error("Auth fixture deletion failed.");
          });
        }
      }
      await cleanup("PostgreSQL shutdown", () => runtime.close());
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "HTTP FoodDay turn integration cleanup failed.",
        );
      }
    });

    it("returns a FINAL response from canonical state without ledger mutation", async () => {
      const before = await ledgerCounts();
      const key = randomUUID();
      const response = await turn(finalMessage, key);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        response: "No confirmed food is logged yet.",
      });
      expect(Object.keys(response.json())).toEqual(["response"]);
      expect(await ledgerCounts()).toEqual(before);
      expect(await completedTurnRows()).toEqual([
        expect.objectContaining({
          user_message: finalMessage,
          response: "No confirmed food is logged yet.",
        }),
      ]);
      expect(finalize).not.toHaveBeenCalled();
      expect(decide).toHaveBeenLastCalledWith({
        userMessage: finalMessage,
        state: {
          foodDay: {
            id: foodDayId,
            localDate: "2026-09-28",
            status: "OPEN",
            completeness: "PARTIAL",
            targets: { calories: "2100", protein: "120" },
          },
          totals: {
            confirmed: {
              calories: "0",
              protein: "0",
              hasUnknownProtein: false,
            },
          },
          entries: [],
        },
      });
    });

    it("executes and safely replays a real LOG_FOOD mutation before finalizing", async () => {
      const key = randomUUID();
      const first = await turn(logMessage, key);

      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ response: "Logged 200 g of yogurt." });
      expect(Object.keys(first.json())).toEqual(["response"]);
      const firstFinalization = finalize.mock.calls.at(-1)?.[0];
      expect(firstFinalization?.userMessage).toBe(logMessage);
      expect(firstFinalization?.state.entries).toEqual([]);
      expect(firstFinalization?.toolResults).toHaveLength(1);
      expect(firstFinalization?.toolResults[0]).toMatchObject({
        name: "LOG_FOOD",
        result: {
          disposition: "CREATED",
          entry: {
            id: expect.any(String),
            foodDayId,
            displayName: "Yogurt",
            quantity: { amount: "200", unit: "GRAM" },
            workingNutrition: { calories: "120", protein: "10" },
            revision: 1,
          },
        },
      });
      const entryId = firstFinalization?.toolResults[0]?.result.entry.id;
      if (entryId === undefined)
        throw new Error("Expected authoritative entry ID.");

      const stored = await runtime.pool.query(
        `select id, user_id, food_day_id, quantity_amount::text as quantity_amount,
              working_nutrition, revision, last_operation_id
       from public.food_entries where id = $1`,
        [entryId],
      );
      expect(stored.rows).toEqual([
        {
          id: entryId,
          user_id: account.id,
          food_day_id: foodDayId,
          quantity_amount: "200",
          working_nutrition: { calories: "120", protein: "10" },
          revision: 1,
          last_operation_id: expect.any(String),
        },
      ]);
      const operations = await operationRows();
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        id: stored.rows[0]?.last_operation_id,
        status: "SUCCEEDED",
        result: { kind: "FOOD_ENTRY_CREATED", entryId },
      });
      const revisions = await runtime.pool.query(
        `select revision, operation_id
       from public.food_entry_revisions
       where user_id = $1 and food_entry_id = $2`,
        [account.id, entryId],
      );
      expect(revisions.rows).toEqual([
        { revision: 1, operation_id: stored.rows[0]?.last_operation_id },
      ]);

      const beforeRetry = await ledgerCounts();
      const completedBeforeRetry = await completedTurnRows();
      expect(completedBeforeRetry).toContainEqual(
        expect.objectContaining({
          food_day_id: foodDayId,
          user_message: logMessage,
          response: "Logged 200 g of yogurt.",
        }),
      );
      const retry = await turn(logMessage, key);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(await ledgerCounts()).toEqual(beforeRetry);
      expect(await operationRows()).toEqual(operations);
      expect(await completedTurnRows()).toEqual(completedBeforeRetry);
      expect(finalize.mock.calls.at(-1)?.[0]).toBe(firstFinalization);
      expect(decide).toHaveBeenCalledTimes(2);
      expect(finalize).toHaveBeenCalledTimes(1);

      const beforeConflict = await ledgerCounts();
      const turnsBeforeConflict = await completedTurnRows();
      const conflict = await turn("Log something different.", key);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "Idempotency key was already used for a different request.",
        },
      });
      expect(await ledgerCounts()).toEqual(beforeConflict);
      expect(await completedTurnRows()).toEqual(turnsBeforeConflict);
      expect(decide).toHaveBeenCalledTimes(2);
      expect(finalize).toHaveBeenCalledTimes(1);
    });
  },
);

function turn(message: string, key: string) {
  return app.inject({
    method: "POST",
    url: `/v1/food-days/${foodDayId}/turns`,
    headers: {
      authorization: `Bearer ${account.token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    payload: JSON.stringify({ message }),
  });
}

async function ledgerCounts() {
  const result = await runtime.pool.query(
    `select
       (select count(*)::text from public.food_entries where user_id = $1) as entries,
       (select count(*)::text from public.semantic_operations where user_id = $1) as operations,
       (select count(*)::text from public.food_entry_revisions where user_id = $1) as revisions`,
    [account.id],
  );
  return result.rows[0];
}

async function operationRows() {
  const result = await runtime.pool.query(
    `select id, operation_key, request_fingerprint, status, result
     from public.semantic_operations where user_id = $1 order by id`,
    [account.id],
  );
  return result.rows;
}

async function completedTurnRows() {
  const result = await runtime.pool.query(
    `select id, food_day_id, turn_key, request_fingerprint, user_message, response,
            to_jsonb(created_at) #>> '{}' as created_at
     from public.food_day_turn_results
     where user_id = $1
     order by created_at, id`,
    [account.id],
  );
  return result.rows;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is required for the HTTP FoodDay turn integration test.`,
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

async function createAccount(): Promise<Account> {
  const credentials = {
    email: `cal-calc-m4c1-${randomUUID()}@example.invalid`,
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
