import { randomUUID } from "node:crypto";

import {
  PostgresAccountConversationTurnRepository,
  PostgresAccountNutritionTargetsRepository,
  PostgresAccountTurnStepResultRepository,
  PostgresConversationRepository,
  PostgresFoodDayRepository,
  PostgresFoodEntryRepository,
} from "@cal-calc/persistence";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  DurableFoodDayTurnFinalizer,
  FoodDayTurnModel,
} from "../agent/turn/food-day-turn-types.js";
import { SupabaseAccessTokenVerifier } from "../auth/supabase-verifier.js";
import { createDurableAccountConversationTurnRunner } from "../conversation/create-durable-account-conversation-turn-runner.js";
import type { FoodDayTargetResolutionModel } from "../conversation/resolve-food-day-target.js";
import { deriveAccountTurnIdentity } from "../conversation/account-turn.js";
import { createApiApp } from "../http/app.js";
import { parseIdempotencyKey } from "../mutations/mutation-identity.js";
import { createPostgresRuntime } from "../postgres/runtime.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "")
  throw new Error("DATABASE_URL is required for account HTTP integration.");

const runtime = createPostgresRuntime({ connectionString: databaseUrl });
const turns = new PostgresAccountConversationTurnRepository(runtime.pool);
const steps = new PostgresAccountTurnStepResultRepository(runtime.pool);
const conversations = new PostgresConversationRepository(runtime.pool);
const targets = new PostgresAccountNutritionTargetsRepository(runtime.pool);
const foodDays = new PostgresFoodDayRepository(runtime.pool);
const foodEntries = new PostgresFoodEntryRepository(runtime.pool);
const userA = randomUUID();
const userB = randomUUID();
const users = [userA, userB];
const tokenA = randomUUID();
const tokenB = randomUUID();
const tokenOwners = new Map<string, string>([
  [tokenA, userA],
  [tokenB, userB],
]);
const verifier = new SupabaseAccessTokenVerifier({
  async getClaims(token) {
    const sub = tokenOwners.get(token);
    return sub === undefined
      ? { data: null, error: new Error("Invalid test credential.") }
      : { data: { claims: { sub } }, error: null };
  },
});
const calendar = {
  currentLocalDateTime: "2026-10-27T12:34:56+05:30",
  timeZone: "Asia/Kolkata",
};
const directDate = "2026-10-26";
const logDate = "2026-10-27";
const directMessage = `What is my plan for ${directDate}?`;
const logMessage = `I ate one apple on ${logDate}.`;
const directResponse = "Café 🍵 — no food change.\n  Keep going?";
const otherOwnerResponse = "This is a different account.\nNo food change.";
const logResponse = "  Logged 🍎!\nOne apple recorded.  ";
const apps: ReturnType<typeof createApiApp>[] = [];

function models() {
  const targetDecide = vi.fn<FoodDayTargetResolutionModel["decide"]>(
    async ({ message }) => {
      if (message === directMessage)
        return { kind: "DATE_TARGET", localDate: directDate };
      if (message === logMessage)
        return { kind: "DATE_TARGET", localDate: logDate };
      throw new Error("Unexpected semantic test message.");
    },
  );
  const planDecide = vi.fn<FoodDayTurnModel["decide"]>(async (input) => {
    if (input.userMessage === directMessage)
      return {
        type: "FINAL",
        text:
          input.state.foodDay.targets.calories === "1800"
            ? otherOwnerResponse
            : directResponse,
      };
    if (input.userMessage !== logMessage)
      throw new Error("Unexpected planning test message.");
    return {
      type: "TOOLS",
      calls: [
        {
          name: "LOG_FOOD",
          arguments: {
            rawUserDescription: "one apple",
            displayName: "Apple",
            quantity: { amount: "1", unit: "SERVING" },
            nutritionBasis: {
              amount: "1",
              unit: "SERVING",
              nutrition: { calories: "95.25", protein: "0.5" },
            },
            evidenceClass: "EXACT",
            status: "CONFIRMED_CONSUMED",
          },
        },
      ],
    };
  });
  const finalizeDurableOrRead = vi.fn<
    DurableFoodDayTurnFinalizer["finalizeDurableOrRead"]
  >(async () => ({ type: "FINAL", text: logResponse }));
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected legacy or continuation model call.");
  };
  const foodDayModel: FoodDayTurnModel & DurableFoodDayTurnFinalizer = {
    decide: planDecide,
    finalizeOrRead: unused,
    finalize: unused,
    finalizeDurableOrRead,
    finalizeDurable: unused,
  };
  return { targetDecide, planDecide, finalizeDurableOrRead, foodDayModel };
}

function appWithModels(model: ReturnType<typeof models>) {
  const app = createApiApp({
    authVerifier: verifier,
    postgres: runtime.pool,
    transactionRunner: runtime.transactionRunner,
    accountTurn: createDurableAccountConversationTurnRunner({
      postgres: runtime.pool,
      transactionRunner: runtime.transactionRunner,
      targetModel: { decide: model.targetDecide },
      foodDayModel: model.foodDayModel,
    }),
  });
  apps.push(app);
  return app;
}

function post(
  app: ReturnType<typeof createApiApp>,
  message: string,
  retryKey: string,
  token?: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/turns",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    payload: JSON.stringify({ message, retryKey, calendar }),
  });
}

function identity(userId: string, message: string, retryKey: string) {
  return deriveAccountTurnIdentity({
    trustedUserId: userId,
    userMessage: message,
    idempotencyKey: parseIdempotencyKey(retryKey),
    calendarContext: calendar,
  });
}

async function counts(userId: string) {
  const result = await runtime.pool.query<{
    turns: string;
    entries: string;
    revisions: string;
    operations: string;
  }>(
    `select
       (select count(*)::text from public.conversation_turns where user_id = $1) as turns,
       (select count(*)::text from public.food_entries where user_id = $1) as entries,
       (select count(*)::text from public.food_entry_revisions where user_id = $1) as revisions,
       (select count(*)::text from public.semantic_operations where user_id = $1) as operations`,
    [userId],
  );
  return result.rows[0]!;
}

describe.sequential("real PostgreSQL account-turn HTTP composition", () => {
  beforeAll(async () => {
    await runtime.pool.query(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password,
         email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
         created_at, updated_at
       ) values
         ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
         ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
      [
        userA,
        `account-http-${userA}@example.invalid`,
        userB,
        `account-http-${userB}@example.invalid`,
      ],
    );
    await targets.setWithExpectedVersion({
      userId: userA,
      expectedVersion: null,
      calorieTarget: "2100.25",
      proteinTarget: "120.5",
    });
    await targets.setWithExpectedVersion({
      userId: userB,
      expectedVersion: null,
      calorieTarget: "1800",
      proteinTarget: "90",
    });
  });

  afterAll(async () => {
    const failures: Error[] = [];
    for (const app of apps)
      try {
        await app.close();
      } catch {
        failures.push(new Error("Fastify cleanup failed."));
      }
    try {
      await runtime.pool.query(
        `update public.conversations
         set active_food_day_id = null, active_food_day_turn_id = null,
             version = version + 1
         where user_id = any($1::uuid[]) and active_food_day_id is not null`,
        [users],
      );
    } catch {
      failures.push(new Error("Pointer cleanup failed."));
    }
    for (const table of [
      "account_turn_step_results",
      "food_entry_revisions",
      "food_entries",
      "semantic_operations",
      "conversation_turns",
      "conversations",
      "food_days",
      "account_nutrition_targets",
    ] as const)
      try {
        await runtime.pool.query(
          `delete from public.${table} where user_id = any($1::uuid[])`,
          [users],
        );
      } catch {
        failures.push(new Error(`${table} cleanup failed.`));
      }
    try {
      await runtime.pool.query(
        "delete from auth.users where id = any($1::uuid[])",
        [users],
      );
    } catch {
      failures.push(new Error("Auth fixture cleanup failed."));
    }
    try {
      await runtime.close();
    } catch {
      failures.push(new Error("PostgreSQL shutdown failed."));
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Account HTTP cleanup failed.");
  });

  it("completes a targeted DIRECT_RESPONSE without a food mutation or pointer advance", async () => {
    const model = models();
    const app = appWithModels(model);
    const retryKey = `direct-${randomUUID()}`;
    const first = await post(app, directMessage, retryKey, tokenA);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      status: "COMPLETED",
      response: directResponse,
    });
    const turnIdentity = identity(userA, directMessage, retryKey);
    const turn = await turns.findByKey(userA, turnIdentity.turnKey);
    expect(turn).toMatchObject({
      userId: userA,
      status: "COMPLETED",
      userMessage: directMessage,
      requestFingerprint: turnIdentity.requestFingerprint,
      response: directResponse,
      routingResolution: { kind: "DATE_TARGET", localDate: directDate },
      executionPlan: { slots: [{ action: "DIRECT_RESPONSE" }] },
    });
    const directCheckpoint = await turns.findExecutionCheckpoint(
      userA,
      turn!.id,
    );
    expect(directCheckpoint?.materializedFoodDayId).toEqual(expect.any(String));
    const day = await foodDays.findById(
      userA,
      directCheckpoint!.materializedFoodDayId!,
    );
    expect(day).toMatchObject({
      userId: userA,
      localDate: directDate,
      foodDay: { calorieTarget: "2100.25", proteinTarget: "120.5" },
    });
    expect(await steps.listForTurn(userA, turn!.id)).toEqual([]);
    expect(
      await foodEntries.listActiveByFoodDay(userA, day!.foodDay.id),
    ).toEqual([]);
    expect(await conversations.findByUser(userA)).toMatchObject({
      activeFoodDayId: null,
      activeFoodDayTurnId: null,
      version: 0,
    });
    expect(model.targetDecide).toHaveBeenCalledTimes(1);
    expect(model.planDecide).toHaveBeenCalledTimes(1);
    expect(model.finalizeDurableOrRead).not.toHaveBeenCalled();

    const before = await counts(userA);
    const retry = await post(app, directMessage, retryKey, tokenA);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(await counts(userA)).toEqual(before);
    expect(model.targetDecide).toHaveBeenCalledTimes(1);
    expect(model.planDecide).toHaveBeenCalledTimes(1);
    expect(model.finalizeDurableOrRead).not.toHaveBeenCalled();

    const unauthenticated = await post(
      app,
      directMessage,
      `bad-${randomUUID()}`,
    );
    const badToken = await post(
      app,
      directMessage,
      `bad-${randomUUID()}`,
      randomUUID(),
    );
    for (const response of [unauthenticated, badToken]) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHENTICATED");
    }
    expect(await counts(userA)).toEqual(before);
    expect(model.targetDecide).toHaveBeenCalledTimes(1);

    const sameKeyOtherOwner = await post(app, directMessage, retryKey, tokenB);
    expect(sameKeyOtherOwner.statusCode).toBe(200);
    expect(sameKeyOtherOwner.json()).toEqual({
      status: "COMPLETED",
      response: otherOwnerResponse,
    });
    const otherTurn = await turns.findByKey(
      userB,
      identity(userB, directMessage, retryKey).turnKey,
    );
    expect(otherTurn?.id).not.toBe(turn?.id);
    expect(otherTurn?.response).toBe(otherOwnerResponse);
    expect(await counts(userA)).toEqual(before);
  });

  it("executes one canonical LOG_FOOD, completes, and replays across a fresh app instance", async () => {
    const model = models();
    const app = appWithModels(model);
    const retryKey = `log-${randomUUID()}`;
    // Discard the first payload as a lost-return equivalent; durable data is authoritative.
    const first = await post(app, logMessage, retryKey, tokenA);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      status: "COMPLETED",
      response: logResponse,
    });
    const turnIdentity = identity(userA, logMessage, retryKey);
    const turn = await turns.findByKey(userA, turnIdentity.turnKey);
    expect(turn).toMatchObject({
      status: "COMPLETED",
      response: logResponse,
      routingResolution: { kind: "DATE_TARGET", localDate: logDate },
      executionPlan: { slots: [{ index: 0, action: "LOG_FOOD" }] },
    });
    const checkpoint = await turns.findExecutionCheckpoint(userA, turn!.id);
    expect(checkpoint?.materializedFoodDayId).toEqual(expect.any(String));
    const dayId = checkpoint!.materializedFoodDayId!;
    const day = await foodDays.findById(userA, dayId);
    expect(day).toMatchObject({
      userId: userA,
      localDate: logDate,
      foodDay: { calorieTarget: "2100.25", proteinTarget: "120.5" },
    });
    const entries = await foodEntries.listActiveByFoodDay(userA, dayId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: expect.any(String),
      foodDayId: dayId,
      displayName: "Apple",
      quantity: { amount: "1", unit: "SERVING" },
      workingNutrition: { calories: "95.25", protein: "0.5" },
      status: "CONFIRMED_CONSUMED",
      revision: 1,
    });
    expect(entries[0]?.deletedAt).toBeUndefined();
    const stepRows = await steps.listForTurn(userA, turn!.id);
    expect(stepRows).toMatchObject([
      {
        userId: userA,
        turnId: turn!.id,
        ordinal: 0,
        result: {
          action: "LOG_FOOD",
          outcome: { entryId: entries[0]!.id, revision: 1 },
        },
      },
    ]);
    const pointer = await conversations.findByUser(userA);
    expect(pointer).toMatchObject({
      activeFoodDayId: dayId,
      activeFoodDayTurnId: turn!.id,
      version: 1,
    });
    expect(model.targetDecide).toHaveBeenCalledTimes(1);
    expect(model.planDecide).toHaveBeenCalledTimes(1);
    expect(model.finalizeDurableOrRead).toHaveBeenCalledTimes(1);
    const before = await counts(userA);

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const freshModel = models();
    const freshApp = appWithModels(freshModel);
    const retry = await post(freshApp, logMessage, retryKey, tokenA);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(await turns.findByKey(userA, turnIdentity.turnKey)).toMatchObject({
      id: turn!.id,
    });
    expect(await counts(userA)).toEqual(before);
    expect(await conversations.findByUser(userA)).toEqual(pointer);
    expect(freshModel.targetDecide).not.toHaveBeenCalled();
    expect(freshModel.planDecide).not.toHaveBeenCalled();
    expect(freshModel.finalizeDurableOrRead).not.toHaveBeenCalled();

    const changed = await post(
      freshApp,
      `I ate two apples on ${logDate}.`,
      retryKey,
      tokenA,
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency key was already used for a different request.",
      },
    });
    expect(await counts(userA)).toEqual(before);
    expect(await foodEntries.listActiveByFoodDay(userA, dayId)).toHaveLength(1);
    expect(freshModel.targetDecide).not.toHaveBeenCalled();
    expect(freshModel.planDecide).not.toHaveBeenCalled();
    expect(freshModel.finalizeDurableOrRead).not.toHaveBeenCalled();
  });
});
