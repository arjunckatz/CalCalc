import { randomUUID } from "node:crypto";

import {
  createFoodDay,
  createFoodEntry,
  DomainValidationError,
} from "@cal-calc/domain";
import {
  FoodDayCompletenessConflictError,
  FoodDayNotFoundError,
  PostgresFoodDayRepository,
  PostgresFoodEntryRepository,
  SemanticOperationIdempotencyConflictError,
  type FoodDayCompleteness,
} from "@cal-calc/persistence";
import { afterAll, beforeAll, expect, it } from "vitest";

import { parseIdempotencyKey } from "../mutations/mutation-identity.js";
import { setFoodDayCompletenessMutation } from "../mutations/set-food-day-completeness.js";
import {
  createPostgresRuntime,
  type PostgresRuntime,
} from "../postgres/runtime.js";
import { getFoodDayState } from "../state/get-food-day-state.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the FoodDay completeness integration test.",
  );
}

const userA = randomUUID();
const userB = randomUUID();
const dayId = randomUUID();
const raceDayId = randomUUID();
const entryId = randomUUID();
const emailA = `calcalc-completeness-${userA}@example.invalid`;
const emailB = `calcalc-completeness-${userB}@example.invalid`;
const entry = createFoodEntry({
  id: entryId,
  foodDayId: dayId,
  rawUserDescription: "I ate rice",
  displayName: "Rice",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "320", protein: "6" },
  },
  evidenceClass: "SOURCED",
  status: "CONFIRMED_CONSUMED",
});

let runtime: PostgresRuntime | undefined;
let days: PostgresFoodDayRepository;
let entries: PostgresFoodEntryRepository;
const idlePoolErrors: Error[] = [];

beforeAll(async () => {
  runtime = createPostgresRuntime({ connectionString: databaseUrl });
  runtime.pool.on("error", (error) => idlePoolErrors.push(error));
  days = new PostgresFoodDayRepository(runtime.pool);
  entries = new PostgresFoodEntryRepository(runtime.pool);
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
  for (const id of [dayId, raceDayId]) {
    await days.create({
      userId: userA,
      foodDay: createFoodDay({
        id,
        status: "OPEN",
        calorieTarget: "2100.125",
        proteinTarget: "120.005",
      }),
      completeness: "UNKNOWN",
      localDate: "2026-10-01",
      timezone: "UTC",
    });
  }
  await entries.create({ userId: userA, entry });
});

afterAll(async () => {
  if (runtime === undefined) return;
  const errors: unknown[] = [];
  const cleanup: { readonly sql: string; readonly values: unknown[] }[] = [
    {
      sql: "delete from public.food_entry_revisions where food_entry_id = $1",
      values: [entryId],
    },
    { sql: "delete from public.food_entries where id = $1", values: [entryId] },
    {
      sql: "delete from public.semantic_operations where user_id = any($1::uuid[])",
      values: [[userA, userB]],
    },
    {
      sql: "delete from public.food_days where id = any($1::uuid[])",
      values: [[dayId, raceDayId]],
    },
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
      "FoodDay completeness integration cleanup failed.",
    );
  }
});

function mutate(
  trustedUserId: string,
  foodDayId: string,
  retryKey: string,
  expectedCompleteness: FoodDayCompleteness,
  targetCompleteness: FoodDayCompleteness,
) {
  if (runtime === undefined) throw new Error("Runtime not initialized.");
  return setFoodDayCompletenessMutation(
    { transactionRunner: runtime.transactionRunner },
    {
      trustedUserId,
      trustedFoodDayId: foodDayId,
      idempotencyKey: parseIdempotencyKey(retryKey),
      command: { expectedCompleteness, targetCompleteness },
    },
  );
}

async function state() {
  return getFoodDayState(
    { foodDays: days, foodEntries: entries },
    { trustedUserId: userA, foodDayId: dayId },
  );
}

async function operationCount(userId: string) {
  if (runtime === undefined) throw new Error("Runtime not initialized.");
  const result = await runtime.pool.query<{ count: string }>(
    "select count(*)::text as count from public.semantic_operations where user_id = $1",
    [userId],
  );
  return result.rows[0]?.count;
}

async function revisionCount() {
  if (runtime === undefined) throw new Error("Runtime not initialized.");
  const result = await runtime.pool.query<{ count: string }>(
    "select count(*)::text as count from public.food_entry_revisions where food_entry_id = $1",
    [entryId],
  );
  return result.rows[0]?.count;
}

it("persists reversible completeness only, rehydrates STATE, and handles replay/conflicts/ownership", async () => {
  const beforeDay = await days.findById(userA, dayId);
  const beforeEntry = await entries.findById(userA, entryId);
  const beforeState = await state();
  const beforeRevisions = await revisionCount();
  expect(beforeDay?.completeness).toBe("UNKNOWN");
  expect(beforeState.totals.confirmed).toEqual({
    calories: "320",
    protein: "6",
    hasUnknownProtein: false,
  });

  expect(
    await mutate(userA, dayId, "completeness-first", "UNKNOWN", "PARTIAL"),
  ).toEqual({
    disposition: "APPLIED",
    foodDayId: dayId,
    completeness: "PARTIAL",
  });
  expect((await days.findById(userA, dayId))?.completeness).toBe("PARTIAL");
  expect((await state()).foodDay.completeness).toBe("PARTIAL");
  expect(await operationCount(userA)).toBe("1");

  expect(
    await mutate(userA, dayId, "completeness-first", "UNKNOWN", "PARTIAL"),
  ).toEqual({
    disposition: "REPLAYED",
    foodDayId: dayId,
    completeness: "PARTIAL",
  });
  expect(await operationCount(userA)).toBe("1");
  await expect(
    mutate(
      userA,
      dayId,
      "completeness-first",
      "UNKNOWN",
      "USER_DECLARED_COMPLETE",
    ),
  ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
  await expect(
    mutate(userA, dayId, "completeness-first", "PARTIAL", "PARTIAL"),
  ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
  await expect(
    mutate(userA, dayId, "completeness-noop", "PARTIAL", "PARTIAL"),
  ).rejects.toBeInstanceOf(DomainValidationError);
  await expect(
    mutate(
      userA,
      dayId,
      "completeness-stale",
      "UNKNOWN",
      "USER_DECLARED_COMPLETE",
    ),
  ).rejects.toBeInstanceOf(FoodDayCompletenessConflictError);
  await expect(
    mutate(userB, dayId, "completeness-cross-user", "PARTIAL", "UNKNOWN"),
  ).rejects.toBeInstanceOf(FoodDayNotFoundError);
  expect(await operationCount(userA)).toBe("1");
  expect(await operationCount(userB)).toBe("0");

  expect(
    await mutate(
      userA,
      dayId,
      "completeness-complete",
      "PARTIAL",
      "USER_DECLARED_COMPLETE",
    ),
  ).toMatchObject({
    disposition: "APPLIED",
    completeness: "USER_DECLARED_COMPLETE",
  });
  expect(
    await mutate(
      userA,
      dayId,
      "completeness-reopen",
      "USER_DECLARED_COMPLETE",
      "PARTIAL",
    ),
  ).toMatchObject({ disposition: "APPLIED", completeness: "PARTIAL" });
  const afterDay = await days.findById(userA, dayId);
  const afterState = await state();
  expect(afterDay).toMatchObject({
    userId: userA,
    foodDay: beforeDay?.foodDay,
    completeness: "PARTIAL",
    localDate: beforeDay?.localDate,
    timezone: beforeDay?.timezone,
    openedAt: beforeDay?.openedAt,
    createdAt: beforeDay?.createdAt,
  });
  expect(afterState.foodDay.status).toBe(beforeState.foodDay.status);
  expect(afterState.foodDay.targets).toEqual(beforeState.foodDay.targets);
  expect(afterState.entries).toEqual(beforeState.entries);
  expect(afterState.totals).toEqual(beforeState.totals);
  expect(await entries.findById(userA, entryId)).toEqual(beforeEntry);
  expect(await revisionCount()).toBe(beforeRevisions);
  expect(await operationCount(userA)).toBe("3");
});

it("races two distinct UNKNOWN preconditions: one applies and the other conflicts", async () => {
  const before = await days.findById(userA, raceDayId);
  expect(before?.completeness).toBe("UNKNOWN");
  const targets = ["PARTIAL", "USER_DECLARED_COMPLETE"] as const;
  const outcomes = await Promise.allSettled([
    mutate(userA, raceDayId, "race-partial", "UNKNOWN", targets[0]),
    mutate(userA, raceDayId, "race-complete", "UNKNOWN", targets[1]),
  ]);
  const successes = outcomes.filter(
    (outcome) => outcome.status === "fulfilled",
  );
  const failures = outcomes.filter((outcome) => outcome.status === "rejected");
  expect(successes).toHaveLength(1);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toBeInstanceOf(FoodDayCompletenessConflictError);
  const winningIndex = outcomes.findIndex(
    (outcome) => outcome.status === "fulfilled",
  );
  const winner = targets[winningIndex];
  expect(successes[0]?.value).toMatchObject({
    disposition: "APPLIED",
    foodDayId: raceDayId,
    completeness: winner,
  });
  const after = await days.findById(userA, raceDayId);
  expect(after).toMatchObject({
    userId: userA,
    foodDay: before?.foodDay,
    completeness: winner,
    localDate: before?.localDate,
    timezone: before?.timezone,
    openedAt: before?.openedAt,
    createdAt: before?.createdAt,
  });
  expect(await operationCount(userA)).toBe("4");
});
