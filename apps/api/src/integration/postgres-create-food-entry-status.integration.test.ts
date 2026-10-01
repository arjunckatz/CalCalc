import { randomUUID } from "node:crypto";

import {
  PostgresFoodDayRepository,
  PostgresFoodEntryRepository,
  SemanticOperationIdempotencyConflictError,
} from "@cal-calc/persistence";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  createFoodEntryMutation,
  type CreateFoodEntryCommand,
} from "../mutations/create-food-entry.js";
import { parseIdempotencyKey } from "../mutations/mutation-identity.js";
import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "../postgres/runtime.js";
import { getFoodDayState } from "../state/get-food-day-state.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for status-aware create integration.",
  );
}

const userId = randomUUID();
const foodDayId = randomUUID();
const email = `calcalc-create-status-${userId}@example.invalid`;
const command: CreateFoodEntryCommand = {
  foodDayId,
  rawUserDescription: " Pizza for tonight ",
  displayName: " Pizza ",
  quantity: { amount: "1.00", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "685.1075" },
  },
  evidenceClass: "SOURCED",
  status: "PLANNED",
};

let runtime: PostgresRuntime | undefined;
const poolErrors: Error[] = [];

beforeAll(async () => {
  runtime = createPostgresRuntime({ connectionString: databaseUrl });
  runtime.pool.on("error", (error) => poolErrors.push(error));
  await runtime.pool.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values (
       '00000000-0000-0000-0000-000000000000', $1,
       'authenticated', 'authenticated', $2, '', now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb, now(), now()
     )`,
    [userId, email],
  );
  await runtime.pool.query(
    "insert into public.profiles (user_id) values ($1)",
    [userId],
  );
  await runtime.pool.query(
    `insert into public.food_days (
       id, user_id, status, completeness, calorie_target, protein_target,
       local_date, timezone
     ) values ($1, $2, 'OPEN', 'UNKNOWN', '2100', '120', '2026-09-29', 'UTC')`,
    [foodDayId, userId],
  );
});

afterAll(async () => {
  if (runtime === undefined) return;
  const errors: unknown[] = [];
  for (const [sql, id] of [
    ["delete from public.food_entry_revisions where user_id = $1", userId],
    ["delete from public.food_entries where user_id = $1", userId],
    ["delete from public.semantic_operations where user_id = $1", userId],
    ["delete from public.food_days where id = $1", foodDayId],
    ["delete from public.profiles where user_id = $1", userId],
    ["delete from auth.users where id = $1", userId],
  ] as const) {
    try {
      await runtime.pool.query(sql, [id]);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await runtime.close();
  } catch (error) {
    errors.push(error);
  }
  errors.push(...poolErrors);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Status-aware create cleanup failed.");
  }
});

function create(retryKey: string, value: CreateFoodEntryCommand) {
  if (runtime === undefined) throw new Error("Runtime not initialized.");
  return createFoodEntryMutation(
    { transactionRunner: runtime.transactionRunner },
    {
      trustedUserId: userId,
      idempotencyKey: parseIdempotencyKey(retryKey),
      command: value,
    },
  );
}

async function counts() {
  if (runtime === undefined) throw new Error("Runtime not initialized.");
  const result = await runtime.pool.query<{
    entries: string;
    revisions: string;
    operations: string;
  }>(
    `select
       (select count(*)::text from public.food_entries where user_id = $1) as entries,
       (select count(*)::text from public.food_entry_revisions where user_id = $1) as revisions,
       (select count(*)::text from public.semantic_operations where user_id = $1) as operations`,
    [userId],
  );
  return result.rows[0];
}

it("creates a planned canonical entry once without confirmed totals, then rejects changed-status reuse", async () => {
  if (runtime === undefined) throw new Error("Runtime not initialized.");
  const planned = await create("planned-entry", command);
  expect(planned).toMatchObject({
    disposition: "CREATED",
    entry: {
      foodDayId,
      status: "PLANNED",
      revision: 1,
      rawUserDescription: "Pizza for tonight",
      displayName: "Pizza",
      quantity: { amount: "1", unit: "SERVING" },
      nutritionBasis: { nutrition: { calories: "685.1075" } },
      evidenceClass: "SOURCED",
    },
  });
  const entries = new PostgresFoodEntryRepository(runtime.pool);
  const days = new PostgresFoodDayRepository(runtime.pool);
  const stored = await entries.findById(userId, planned.entry.id);
  expect(stored?.entry).toEqual(planned.entry);
  expect(stored?.userId).toBe(userId);
  expect(stored?.createdAt).toEqual(expect.any(String));
  expect(await entries.findById(randomUUID(), planned.entry.id)).toBeNull();
  const history = await runtime.pool.query<{
    revision: number;
    status: string;
    operation_id: string | null;
  }>(
    `select revision, snapshot->>'status' as status, operation_id
     from public.food_entry_revisions where user_id = $1 and food_entry_id = $2`,
    [userId, planned.entry.id],
  );
  expect(history.rows).toEqual([
    { revision: 1, status: "PLANNED", operation_id: stored?.lastOperationId },
  ]);
  expect(stored?.lastOperationId).toEqual(expect.any(String));
  const operation = await runtime.pool.query<{
    status: string;
    entry_id: string | null;
  }>(
    `select status, result->>'entryId' as entry_id
     from public.semantic_operations where id = $1 and user_id = $2`,
    [stored?.lastOperationId, userId],
  );
  expect(operation.rows).toEqual([
    { status: "SUCCEEDED", entry_id: planned.entry.id },
  ]);
  const state = await getFoodDayState(
    { foodDays: days, foodEntries: entries },
    { trustedUserId: userId, foodDayId },
  );
  expect(state.entries).toMatchObject([
    { id: planned.entry.id, status: "PLANNED" },
  ]);
  expect(state.totals.confirmed).toEqual({
    calories: "0",
    protein: "0",
    hasUnknownProtein: false,
  });
  expect(await counts()).toEqual({
    entries: "1",
    revisions: "1",
    operations: "1",
  });

  const replay = await create("planned-entry", command);
  expect(replay).toEqual({ disposition: "REPLAYED", entry: planned.entry });
  expect(await counts()).toEqual({
    entries: "1",
    revisions: "1",
    operations: "1",
  });

  await expect(
    create("planned-entry", { ...command, status: "CONFIRMED_CONSUMED" }),
  ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
  expect(await counts()).toEqual({
    entries: "1",
    revisions: "1",
    operations: "1",
  });
  expect((await entries.findById(userId, planned.entry.id))?.entry).toEqual(
    planned.entry,
  );

  const confirmed = await create("confirmed-entry", {
    ...command,
    rawUserDescription: "Ate lunch",
    displayName: "Lunch",
    nutritionBasis: {
      amount: "1",
      unit: "SERVING",
      nutrition: { calories: "400", protein: "20" },
    },
    status: "CONFIRMED_CONSUMED",
  });
  expect(confirmed.entry.revision).toBe(1);
  expect(
    (
      await getFoodDayState(
        { foodDays: days, foodEntries: entries },
        { trustedUserId: userId, foodDayId },
      )
    ).totals.confirmed,
  ).toEqual({
    calories: "400",
    protein: "20",
    hasUnknownProtein: false,
  });
});
