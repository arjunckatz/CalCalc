import { randomUUID } from "node:crypto";

import { createFoodEntry, DomainValidationError } from "@cal-calc/domain";
import {
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  PostgresFoodDayRepository,
  PostgresFoodEntryRepository,
  SemanticOperationIdempotencyConflictError,
} from "@cal-calc/persistence";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  changeFoodEntryStatusMutation,
  type ChangeFoodEntryStatusCommand,
} from "../mutations/change-food-entry-status.js";
import { parseIdempotencyKey } from "../mutations/mutation-identity.js";
import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "../postgres/runtime.js";
import { getFoodDayState } from "../state/get-food-day-state.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the FoodEntry status integration test.",
  );
}

const userA = randomUUID();
const userB = randomUUID();
const dayId = randomUUID();
const entryId = randomUUID();
const emailA = `calcalc-status-${userA}@example.invalid`;
const emailB = `calcalc-status-${userB}@example.invalid`;
const original = createFoodEntry({
  id: entryId,
  foodDayId: dayId,
  rawUserDescription: "Pasta for later",
  displayName: "Pasta",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "400" },
  },
  evidenceClass: "SOURCED",
  status: "PLANNED",
});

let runtime: PostgresRuntime | undefined;
let entries: PostgresFoodEntryRepository;
let days: PostgresFoodDayRepository;
const idlePoolErrors: Error[] = [];

beforeAll(async () => {
  runtime = createPostgresRuntime({ connectionString: databaseUrl });
  runtime.pool.on("error", (error) => idlePoolErrors.push(error));
  entries = new PostgresFoodEntryRepository(runtime.pool);
  days = new PostgresFoodDayRepository(runtime.pool);
  await runtime.pool.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values
       ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
       ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [userA, emailA, userB, emailB],
  );
  await runtime.pool.query(
    "insert into public.profiles (user_id) values ($1), ($2)",
    [userA, userB],
  );
  await runtime.pool.query(
    `insert into public.food_days (
       id, user_id, status, completeness, calorie_target, protein_target,
       local_date, timezone
     ) values ($1, $2, 'OPEN', 'UNKNOWN', '2100', '120', '2026-09-29', 'UTC')`,
    [dayId, userA],
  );
  await entries.create({ userId: userA, entry: original });
});

afterAll(async () => {
  if (runtime === undefined) return;
  const errors: unknown[] = [];
  const cleanup: { sql: string; values: unknown[] }[] = [
    {
      sql: "delete from public.food_entry_revisions where food_entry_id = $1",
      values: [entryId],
    },
    { sql: "delete from public.food_entries where id = $1", values: [entryId] },
    {
      sql: "delete from public.semantic_operations where user_id = any($1::uuid[])",
      values: [[userA, userB]],
    },
    { sql: "delete from public.food_days where id = $1", values: [dayId] },
    {
      sql: "delete from public.profiles where user_id = any($1::uuid[])",
      values: [[userA, userB]],
    },
    {
      sql: "delete from auth.users where id = any($1::uuid[])",
      values: [[userA, userB]],
    },
  ];
  for (const { sql, values } of cleanup) {
    try {
      await runtime.pool.query(sql, values);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await runtime.close();
  } catch (error) {
    errors.push(error);
  }
  errors.push(...idlePoolErrors);
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "FoodEntry status integration cleanup failed.",
    );
  }
});

function mutation(
  trustedUserId: string,
  retryKey: string,
  command: ChangeFoodEntryStatusCommand,
) {
  if (runtime === undefined) throw new Error("Runtime not initialized.");
  return changeFoodEntryStatusMutation(
    { transactionRunner: runtime.transactionRunner },
    {
      trustedUserId,
      idempotencyKey: parseIdempotencyKey(retryKey),
      command,
    },
  );
}

async function confirmedTotals() {
  return (
    await getFoodDayState(
      { foodDays: days, foodEntries: entries },
      { trustedUserId: userA, foodDayId: dayId },
    )
  ).totals.confirmed;
}

async function history() {
  if (runtime === undefined) throw new Error("Runtime not initialized.");
  const result = await runtime.pool.query<{
    revision: number;
    status: string;
    operation_id: string | null;
  }>(
    `select revision, snapshot->>'status' as status, operation_id
     from public.food_entry_revisions
     where user_id = $1 and food_entry_id = $2
     order by revision`,
    [userA, entryId],
  );
  return result.rows;
}

async function operationCount(userId: string) {
  if (runtime === undefined) throw new Error("Runtime not initialized.");
  const result = await runtime.pool.query<{ count: string }>(
    "select count(*)::text as count from public.semantic_operations where user_id = $1",
    [userId],
  );
  return result.rows[0]?.count;
}

it("persists exactly-once status changes, history, ownership, and confirmed totals", async () => {
  const persistedBefore = await entries.findById(userA, entryId);
  if (persistedBefore === null) throw new Error("Missing fixture FoodEntry.");
  expect(await confirmedTotals()).toEqual({
    calories: "0",
    protein: "0",
    hasUnknownProtein: false,
  });
  const toConfirmed: ChangeFoodEntryStatusCommand = {
    entryId,
    expectedRevision: 1,
    status: "CONFIRMED_CONSUMED",
  };
  const first = await mutation(userA, "status-first", toConfirmed);
  expect(first).toMatchObject({
    disposition: "APPLIED",
    appliedRevision: 2,
    entry: { id: entryId, status: "CONFIRMED_CONSUMED", revision: 2 },
  });
  expect(first.entry).toEqual({
    ...original,
    status: "CONFIRMED_CONSUMED",
    revision: 2,
  });
  expect((await entries.findById(userA, entryId))?.entry).toEqual(first.entry);
  expect(await confirmedTotals()).toEqual({
    calories: "400",
    protein: null,
    hasUnknownProtein: true,
  });
  const firstHistory = await history();
  expect(firstHistory).toMatchObject([
    { revision: 1, status: "PLANNED", operation_id: null },
    {
      revision: 2,
      status: "CONFIRMED_CONSUMED",
      operation_id: expect.any(String),
    },
  ]);
  expect(await operationCount(userA)).toBe("1");

  const replay = await mutation(userA, "status-first", toConfirmed);
  expect(replay).toEqual({
    disposition: "REPLAYED",
    entry: first.entry,
    appliedRevision: 2,
  });
  expect(await history()).toEqual(firstHistory);
  expect(await operationCount(userA)).toBe("1");

  await expect(
    mutation(userA, "status-first", { ...toConfirmed, status: "DISCARDED" }),
  ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
  expect(await history()).toEqual(firstHistory);
  expect(await operationCount(userA)).toBe("1");

  const away = await mutation(userA, "status-away", {
    entryId,
    expectedRevision: 2,
    status: "PLANNED",
  });
  expect(away).toMatchObject({
    disposition: "APPLIED",
    appliedRevision: 3,
    entry: { status: "PLANNED", revision: 3 },
  });
  expect(await confirmedTotals()).toEqual({
    calories: "0",
    protein: "0",
    hasUnknownProtein: false,
  });
  expect(await history()).toMatchObject([
    { revision: 1, status: "PLANNED" },
    { revision: 2, status: "CONFIRMED_CONSUMED" },
    { revision: 3, status: "PLANNED", operation_id: expect.any(String) },
  ]);

  await expect(
    mutation(userA, "status-noop", {
      entryId,
      expectedRevision: 3,
      status: "PLANNED",
    }),
  ).rejects.toBeInstanceOf(DomainValidationError);
  await expect(
    mutation(userA, "status-stale", {
      entryId,
      expectedRevision: 2,
      status: "CONSIDERED",
    }),
  ).rejects.toBeInstanceOf(FoodEntryRevisionConflictError);
  await expect(
    mutation(userB, "status-foreign", {
      entryId,
      expectedRevision: 1,
      status: "DISCARDED",
    }),
  ).rejects.toBeInstanceOf(FoodEntryNotFoundError);
  expect(await operationCount(userA)).toBe("2");
  expect(await operationCount(userB)).toBe("0");
  expect((await history()).length).toBe(3);

  const back = await mutation(userA, "status-back", {
    entryId,
    expectedRevision: 3,
    status: "CONFIRMED_CONSUMED",
  });
  expect(back).toMatchObject({
    disposition: "APPLIED",
    appliedRevision: 4,
    entry: { status: "CONFIRMED_CONSUMED", revision: 4 },
  });
  const persistedAfter = await entries.findById(userA, entryId);
  expect(persistedAfter?.entry).toEqual(back.entry);
  expect(persistedAfter?.createdAt).toBe(persistedBefore.createdAt);
  expect(persistedAfter?.reportedAt).toBe(persistedBefore.reportedAt);
  expect(back.entry).toEqual({
    ...original,
    status: "CONFIRMED_CONSUMED",
    revision: 4,
  });
  expect(await confirmedTotals()).toEqual({
    calories: "400",
    protein: null,
    hasUnknownProtein: true,
  });
  expect(await history()).toMatchObject([
    { revision: 1, status: "PLANNED" },
    { revision: 2, status: "CONFIRMED_CONSUMED" },
    { revision: 3, status: "PLANNED" },
    {
      revision: 4,
      status: "CONFIRMED_CONSUMED",
      operation_id: expect.any(String),
    },
  ]);
  expect(await operationCount(userA)).toBe("3");
});
