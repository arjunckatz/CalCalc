import { randomUUID } from "node:crypto";

import { createFoodDay, createFoodEntry } from "@cal-calc/domain";
import {
  PostgresFoodDayRepository,
  PostgresFoodEntryRepository,
} from "@cal-calc/persistence";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createApiApp,
  createFoodDayTurnRunner,
  createPostgresRuntime,
  createSupabaseAccessTokenVerifier,
  getFoodDayState,
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
const finalMessage = "  I ate yogurt.  ";
const logMessage = "Make that 200 g.";
const plannedMessage = "I plan to have oats later.";
const statusMessage = "Confirm the planned entry.";
const completenessMessage = "Mark this FoodDay complete.";
const plannedEntryId = randomUUID();

interface Account {
  readonly id: string;
  readonly token: string;
}

let account: Account;

const decide = vi.fn<FoodDayTurnModel["decide"]>(async (input) => {
  if (input.userMessage === finalMessage) {
    return { type: "FINAL", text: "How much yogurt did you have?" };
  }
  if (input.userMessage === statusMessage) {
    return {
      type: "TOOLS",
      calls: [
        {
          name: "CHANGE_FOOD_STATUS",
          arguments: {
            entryId: plannedEntryId,
            expectedRevision: 1,
            status: "CONFIRMED_CONSUMED",
          },
        },
      ],
    };
  }
  if (input.userMessage === completenessMessage) {
    return {
      type: "TOOLS",
      calls: [
        {
          name: "SET_FOOD_DAY_COMPLETENESS",
          arguments: { targetCompleteness: "USER_DECLARED_COMPLETE" },
        },
      ],
    };
  }
  if (input.userMessage === plannedMessage) {
    return {
      type: "TOOLS",
      calls: [
        {
          name: "LOG_FOOD",
          arguments: {
            rawUserDescription: "Oats for later",
            displayName: "Oats",
            quantity: { amount: "1", unit: "SERVING" },
            nutritionBasis: {
              amount: "1",
              unit: "SERVING",
              nutrition: { calories: "300" },
            },
            evidenceClass: "SOURCED",
            status: "PLANNED",
          },
        },
      ],
    };
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

const finalize = vi.fn<FoodDayTurnModel["finalize"]>(async (input) => {
  const tool = input.toolResults[0];
  if (tool?.name === "CHANGE_FOOD_STATUS")
    return "Confirmed the planned entry.";
  if (tool?.name === "SET_FOOD_DAY_COMPLETENESS")
    return "Marked the FoodDay complete.";
  if (tool?.name === "LOG_FOOD" && tool.result.entry.status === "PLANNED") {
    return "Planned oats.";
  }
  return "Logged 200 g of yogurt.";
});
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
        response: "How much yogurt did you have?",
      });
      expect(Object.keys(response.json())).toEqual(["response"]);
      expect(await ledgerCounts()).toEqual(before);
      expect(await completedTurnRows()).toEqual([
        expect.objectContaining({
          user_message: finalMessage,
          response: "How much yogurt did you have?",
        }),
      ]);
      expect(finalize).not.toHaveBeenCalled();
      expect(decide).toHaveBeenLastCalledWith({
        userMessage: finalMessage,
        recentTranscript: [],
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
          targetProgress: {
            calories: { remainingToTarget: "2100", overTargetBy: "0" },
            protein: { remainingToTarget: "120", overTargetBy: "0" },
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
      expect(decide).toHaveBeenLastCalledWith({
        userMessage: logMessage,
        recentTranscript: [
          {
            userMessage: finalMessage,
            response: "How much yogurt did you have?",
          },
        ],
        state: expect.objectContaining({
          foodDay: expect.objectContaining({ id: foodDayId }),
        }),
      });
      const firstFinalization = finalize.mock.calls.at(-1)?.[0];
      expect(firstFinalization?.userMessage).toBe(logMessage);
      expect(firstFinalization?.recentTranscript).toEqual([
        {
          userMessage: finalMessage,
          response: "How much yogurt did you have?",
        },
      ]);
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
      const firstTool = firstFinalization?.toolResults[0];
      const entryId =
        firstTool?.name === "LOG_FOOD" ? firstTool.result.entry.id : undefined;
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

    it("creates a PLANNED entry through LOG_FOOD and durably replays without another mutation", async () => {
      const repositories = {
        foodDays: new PostgresFoodDayRepository(runtime.pool),
        foodEntries: new PostgresFoodEntryRepository(runtime.pool),
      };
      const initialState = await getFoodDayState(repositories, {
        trustedUserId: account.id,
        foodDayId,
      });
      expect(initialState.totals.confirmed).toEqual({
        calories: "120",
        protein: "10",
        hasUnknownProtein: false,
      });
      const before = await ledgerCounts();
      const key = randomUUID();
      const first = await turn(plannedMessage, key);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ response: "Planned oats." });
      expect(decide.mock.calls.at(-1)?.[0].state).toEqual(initialState);
      const finalInput = finalize.mock.calls.at(-1)?.[0];
      expect(finalInput?.state).toEqual(initialState);
      expect(finalInput?.toolResults).toMatchObject([
        {
          name: "LOG_FOOD",
          result: {
            disposition: "CREATED",
            entry: {
              id: expect.any(String),
              foodDayId,
              status: "PLANNED",
              revision: 1,
              displayName: "Oats",
              workingNutrition: { calories: "300" },
            },
          },
        },
      ]);
      const tool = finalInput?.toolResults[0];
      if (tool?.name !== "LOG_FOOD")
        throw new Error("Expected LOG_FOOD result.");
      const entryId = tool.result.entry.id;
      const stored = await runtime.pool.query(
        `select user_id, food_day_id, status, revision, working_nutrition,
                last_operation_id from public.food_entries where id = $1`,
        [entryId],
      );
      expect(stored.rows).toEqual([
        {
          user_id: account.id,
          food_day_id: foodDayId,
          status: "PLANNED",
          revision: 1,
          working_nutrition: { calories: "300" },
          last_operation_id: expect.any(String),
        },
      ]);
      const revisions = await runtime.pool.query(
        `select revision, snapshot->>'status' as status, operation_id
         from public.food_entry_revisions where user_id = $1 and food_entry_id = $2`,
        [account.id, entryId],
      );
      expect(revisions.rows).toEqual([
        {
          revision: 1,
          status: "PLANNED",
          operation_id: stored.rows[0]?.last_operation_id,
        },
      ]);
      const after = await ledgerCounts();
      expect(Number(after.entries)).toBe(Number(before.entries) + 1);
      expect(Number(after.revisions)).toBe(Number(before.revisions) + 1);
      expect(Number(after.operations)).toBe(Number(before.operations) + 1);
      expect(
        (
          await getFoodDayState(repositories, {
            trustedUserId: account.id,
            foodDayId,
          })
        ).totals.confirmed,
      ).toEqual(initialState.totals.confirmed);

      const beforeRetry = {
        counts: await ledgerCounts(),
        operations: await operationRows(),
        turns: await completedTurnRows(),
        decideCalls: decide.mock.calls.length,
        finalizeCalls: finalize.mock.calls.length,
      };
      const retry = await turn(plannedMessage, key);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(decide).toHaveBeenCalledTimes(beforeRetry.decideCalls);
      expect(finalize).toHaveBeenCalledTimes(beforeRetry.finalizeCalls);
      expect(await ledgerCounts()).toEqual(beforeRetry.counts);
      expect(await operationRows()).toEqual(beforeRetry.operations);
      expect(await completedTurnRows()).toEqual(beforeRetry.turns);
      expect(
        (
          await runtime.pool.query(
            "select revision from public.food_entry_revisions where food_entry_id = $1",
            [entryId],
          )
        ).rows,
      ).toEqual([{ revision: 1 }]);
    });

    it("applies CHANGE_FOOD_STATUS through the real ledger and durably replays the turn", async () => {
      const entries = new PostgresFoodEntryRepository(runtime.pool);
      await entries.create({
        userId: account.id,
        entry: createFoodEntry({
          id: plannedEntryId,
          foodDayId,
          rawUserDescription: "Planned toast",
          displayName: "Toast",
          quantity: { amount: "1", unit: "SERVING" },
          nutritionBasis: {
            amount: "1",
            unit: "SERVING",
            nutrition: { calories: "250" },
          },
          evidenceClass: "EXACT",
          status: "PLANNED",
        }),
      });
      const key = randomUUID();
      const first = await turn(statusMessage, key);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({
        response: "Confirmed the planned entry.",
      });
      const finalInput = finalize.mock.calls.at(-1)?.[0];
      expect(finalInput?.toolResults).toEqual([
        {
          name: "CHANGE_FOOD_STATUS",
          result: {
            disposition: "APPLIED",
            entry: expect.objectContaining({
              id: plannedEntryId,
              foodDayId,
              status: "CONFIRMED_CONSUMED",
              revision: 2,
            }),
            appliedRevision: 2,
          },
        },
      ]);
      const stored = await runtime.pool.query(
        `select id, user_id, food_day_id, status, revision, last_operation_id
         from public.food_entries where id = $1`,
        [plannedEntryId],
      );
      expect(stored.rows).toEqual([
        {
          id: plannedEntryId,
          user_id: account.id,
          food_day_id: foodDayId,
          status: "CONFIRMED_CONSUMED",
          revision: 2,
          last_operation_id: expect.any(String),
        },
      ]);
      expect(await operationRows()).toContainEqual(
        expect.objectContaining({
          id: stored.rows[0]?.last_operation_id,
          status: "SUCCEEDED",
          result: {
            kind: "FOOD_ENTRY_UPDATED",
            entryId: plannedEntryId,
            appliedRevision: 2,
          },
        }),
      );
      const revisions = await runtime.pool.query(
        `select revision, operation_id from public.food_entry_revisions
         where user_id = $1 and food_entry_id = $2 order by revision`,
        [account.id, plannedEntryId],
      );
      expect(revisions.rows).toEqual([
        { revision: 1, operation_id: null },
        { revision: 2, operation_id: stored.rows[0]?.last_operation_id },
      ]);
      const totals = await getFoodDayState(
        {
          foodDays: new PostgresFoodDayRepository(runtime.pool),
          foodEntries: entries,
        },
        { trustedUserId: account.id, foodDayId },
      );
      expect(totals.totals.confirmed).toEqual({
        calories: "370",
        protein: null,
        hasUnknownProtein: true,
      });
      const beforeRetry = {
        ledger: await ledgerCounts(),
        operations: await operationRows(),
        turns: await completedTurnRows(),
      };
      const callsBeforeRetry = {
        decide: decide.mock.calls.length,
        finalize: finalize.mock.calls.length,
      };
      const retry = await turn(statusMessage, key);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(decide).toHaveBeenCalledTimes(callsBeforeRetry.decide);
      expect(finalize).toHaveBeenCalledTimes(callsBeforeRetry.finalize);
      expect(await ledgerCounts()).toEqual(beforeRetry.ledger);
      expect(await operationRows()).toEqual(beforeRetry.operations);
      expect(await completedTurnRows()).toEqual(beforeRetry.turns);
      expect(
        (await entries.findById(account.id, plannedEntryId))?.entry.revision,
      ).toBe(2);
    });

    it("sets completeness from fresh STATE through the authenticated tool path and durably replays", async () => {
      const repositories = {
        foodDays: new PostgresFoodDayRepository(runtime.pool),
        foodEntries: new PostgresFoodEntryRepository(runtime.pool),
      };
      const beforeState = await getFoodDayState(repositories, {
        trustedUserId: account.id,
        foodDayId,
      });
      const beforeDay = await repositories.foodDays.findById(
        account.id,
        foodDayId,
      );
      const beforeLedger = await ledgerCounts();
      const beforeOperations = await operationRows();
      expect(beforeState.foodDay.completeness).toBe("PARTIAL");

      const key = randomUUID();
      const first = await turn(completenessMessage, key);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({
        response: "Marked the FoodDay complete.",
      });
      expect(decide.mock.calls.at(-1)?.[0].state).toEqual(beforeState);
      expect(await decide.mock.results.at(-1)?.value).toEqual({
        type: "TOOLS",
        calls: [
          {
            name: "SET_FOOD_DAY_COMPLETENESS",
            arguments: { targetCompleteness: "USER_DECLARED_COMPLETE" },
          },
        ],
      });
      const finalInput = finalize.mock.calls.at(-1)?.[0];
      expect(finalInput?.state).toEqual(beforeState);
      expect(finalInput?.toolResults).toEqual([
        {
          name: "SET_FOOD_DAY_COMPLETENESS",
          result: {
            disposition: "APPLIED",
            foodDayId,
            completeness: "USER_DECLARED_COMPLETE",
          },
        },
      ]);

      const stored = await runtime.pool.query(
        "select completeness, status from public.food_days where id = $1 and user_id = $2",
        [foodDayId, account.id],
      );
      expect(stored.rows).toEqual([
        {
          completeness: "USER_DECLARED_COMPLETE",
          status: beforeDay?.foodDay.status,
        },
      ]);
      const afterState = await getFoodDayState(repositories, {
        trustedUserId: account.id,
        foodDayId,
      });
      expect(afterState.foodDay).toEqual({
        ...beforeState.foodDay,
        completeness: "USER_DECLARED_COMPLETE",
      });
      expect(afterState.entries).toEqual(beforeState.entries);
      expect(afterState.totals).toEqual(beforeState.totals);
      expect(
        (await repositories.foodDays.findById(account.id, foodDayId))?.foodDay,
      ).toEqual(beforeDay?.foodDay);

      const afterLedger = await ledgerCounts();
      expect(afterLedger.entries).toBe(beforeLedger.entries);
      expect(afterLedger.revisions).toBe(beforeLedger.revisions);
      expect(Number(afterLedger.operations)).toBe(
        Number(beforeLedger.operations) + 1,
      );
      const afterOperations = await operationRows();
      expect(afterOperations).toHaveLength(beforeOperations.length + 1);
      expect(afterOperations).toContainEqual(
        expect.objectContaining({
          status: "SUCCEEDED",
          result: {
            kind: "FOOD_DAY_COMPLETENESS_SET",
            foodDayId,
            completeness: "USER_DECLARED_COMPLETE",
          },
        }),
      );
      const afterTurns = await completedTurnRows();
      const callsBeforeRetry = {
        decide: decide.mock.calls.length,
        finalize: finalize.mock.calls.length,
      };

      const replay = await turn(completenessMessage, key);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(decide).toHaveBeenCalledTimes(callsBeforeRetry.decide);
      expect(finalize).toHaveBeenCalledTimes(callsBeforeRetry.finalize);
      expect(await ledgerCounts()).toEqual(afterLedger);
      expect(await operationRows()).toEqual(afterOperations);
      expect(await completedTurnRows()).toEqual(afterTurns);
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
