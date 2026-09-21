import { randomUUID } from "node:crypto";

import { Client, DatabaseError, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface TestUser {
  readonly id: string;
  readonly email: string;
}

interface FoodEntryFixture {
  readonly id?: string;
  readonly userId: string;
  readonly foodDayId: string;
  readonly revision?: number;
  readonly deletedAt?: string | null;
  readonly nutritionBasis?: Record<string, string>;
  readonly derivedNutrition?: Record<string, string>;
  readonly workingNutritionOverride?: Record<string, string> | null;
  readonly workingNutrition?: Record<string, string>;
  readonly evidenceClass?: "EXACT" | "ESTIMATED";
  readonly estimateLow?: Record<string, string>;
  readonly estimateHigh?: Record<string, string>;
}

interface RevisionRow extends QueryResultRow {
  readonly revision: number;
  readonly snapshot: Record<string, unknown>;
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the PostgreSQL ledger integration tests.",
  );
}

const client = new Client({ connectionString: databaseUrl });
const userA = testUser();
const userB = testUser();
let connected = false;

describe.sequential("PostgreSQL canonical ledger invariants", () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    await createTestUsers(client, [userA, userB]);
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await cleanupTestUsers(client, [userA.id, userB.id]);
    } finally {
      await client.end();
    }
  });

  it("allows two FoodDays with the same local date", async () => {
    const firstDayId = await insertFoodDay(client, userA.id, "2026-09-01");
    const secondDayId = await insertFoodDay(client, userA.id, "2026-09-01");

    const result = await client.query<{ readonly count: string }>(
      `select count(*)::text as "count"
       from public.food_days
       where id = any($1::uuid[])`,
      [[firstDayId, secondDayId]],
    );
    expect(result.rows[0]?.count).toBe("2");
  });

  it("captures revision snapshots for valid insert and update", async () => {
    const dayId = await insertFoodDay(client, userA.id);
    const entryId = await insertFoodEntry(client, {
      userId: userA.id,
      foodDayId: dayId,
    });

    const inserted = await client.query<{
      readonly revision: number;
      readonly deletedAt: Date | null;
    }>(
      `select revision, deleted_at as "deletedAt"
       from public.food_entries
       where id = $1`,
      [entryId],
    );
    expect(inserted.rows[0]).toMatchObject({ revision: 1, deletedAt: null });

    await client.query(
      `update public.food_entries
       set display_name = 'Updated label food', revision = 2
       where id = $1`,
      [entryId],
    );

    const revisions = await client.query<RevisionRow>(
      `select revision, snapshot
       from public.food_entry_revisions
       where food_entry_id = $1
       order by revision`,
      [entryId],
    );
    expect(revisions.rows.map((row) => row.revision)).toEqual([1, 2]);
    expect(revisions.rows[0]?.snapshot.quantity_amount).toBe("275");
    expect(revisions.rows[1]?.snapshot.display_name).toBe("Updated label food");
  });

  it("preserves the database creation timestamp across valid updates and rejects rewriting it", async () => {
    const dayId = await insertFoodDay(client, userA.id);
    const entryId = await insertFoodEntry(client, {
      userId: userA.id,
      foodDayId: dayId,
    });
    const inserted = await client.query<{
      readonly createdAt: Date;
      readonly revision: number;
      readonly displayName: string;
      readonly deletedAt: Date | null;
    }>(
      `select created_at as "createdAt", revision,
              display_name as "displayName", deleted_at as "deletedAt"
       from public.food_entries
       where id = $1`,
      [entryId],
    );
    const createdAt = inserted.rows[0]?.createdAt;
    expect(createdAt).toBeInstanceOf(Date);

    const corrected = await client.query<{
      readonly createdAt: Date;
      readonly revision: number;
      readonly displayName: string;
    }>(
      `update public.food_entries
       set display_name = 'Corrected label food', revision = 2
       where id = $1
       returning created_at as "createdAt", revision,
                 display_name as "displayName"`,
      [entryId],
    );
    expect(corrected.rows[0]).toEqual({
      createdAt,
      revision: 2,
      displayName: "Corrected label food",
    });

    await expectDatabaseFailure(
      () =>
        client.query(
          `update public.food_entries
           set created_at = created_at + interval '1 second', revision = 3
           where id = $1`,
          [entryId],
        ),
      {
        code: "P0001",
        message: "food entry creation timestamp is immutable",
      },
    );
    const unchanged = await client.query<{
      readonly createdAt: Date;
      readonly revision: number;
      readonly displayName: string;
      readonly deletedAt: Date | null;
    }>(
      `select created_at as "createdAt", revision,
              display_name as "displayName", deleted_at as "deletedAt"
       from public.food_entries
       where id = $1`,
      [entryId],
    );
    expect(unchanged.rows[0]).toEqual({
      createdAt,
      revision: 2,
      displayName: "Corrected label food",
      deletedAt: null,
    });

    const removed = await client.query<{
      readonly createdAt: Date;
      readonly revision: number;
      readonly deletedAt: Date | null;
    }>(
      `update public.food_entries
       set deleted_at = '2026-09-16T12:00:00.000Z', revision = 3
       where id = $1
       returning created_at as "createdAt", revision,
                 deleted_at as "deletedAt"`,
      [entryId],
    );
    expect(removed.rows[0]?.createdAt).toEqual(createdAt);
    expect(removed.rows[0]?.revision).toBe(3);
    expect(removed.rows[0]?.deletedAt?.toISOString()).toBe(
      "2026-09-16T12:00:00.000Z",
    );
  });

  it("rejects invalid initial revision and tombstone state", async () => {
    const dayId = await insertFoodDay(client, userA.id);

    await expectDatabaseFailure(
      () =>
        insertFoodEntry(client, {
          userId: userA.id,
          foodDayId: dayId,
          revision: 2,
        }),
      { code: "P0001", message: "new food entries must begin at revision 1" },
    );
    await expectDatabaseFailure(
      () =>
        insertFoodEntry(client, {
          userId: userA.id,
          foodDayId: dayId,
          deletedAt: "2026-09-01T12:00:00.000Z",
        }),
      { code: "P0001", message: "new food entries must not be deleted" },
    );
  });

  it("rejects an update without an exact revision increment", async () => {
    const dayId = await insertFoodDay(client, userA.id);
    const entryId = await insertFoodEntry(client, {
      userId: userA.id,
      foodDayId: dayId,
    });

    await expectDatabaseFailure(
      () =>
        client.query(
          `update public.food_entries
           set display_name = 'Invalid update', revision = 1
           where id = $1`,
          [entryId],
        ),
      {
        code: "P0001",
        message: "food entry revision must increment exactly once",
      },
    );
  });

  it("rejects updates to revision history", async () => {
    const dayId = await insertFoodDay(client, userA.id);
    const entryId = await insertFoodEntry(client, {
      userId: userA.id,
      foodDayId: dayId,
    });

    await expectDatabaseFailure(
      () =>
        client.query(
          `update public.food_entry_revisions
           set snapshot = snapshot || '{"tampered":true}'::jsonb
           where food_entry_id = $1 and revision = 1`,
          [entryId],
        ),
      { code: "P0001", message: "food entry revision history is append-only" },
    );
  });

  it("rejects cross-user FoodDay ownership", async () => {
    await insertFoodDay(client, userA.id);
    const userBDayId = await insertFoodDay(client, userB.id);

    await expectDatabaseFailure(
      () =>
        insertFoodEntry(client, {
          userId: userA.id,
          foodDayId: userBDayId,
        }),
      {
        code: "23503",
        constraint: "food_entries_food_day_id_user_id_fkey",
      },
    );
  });

  it("rejects malformed nutrition and an empty working override", async () => {
    const dayId = await insertFoodDay(client, userA.id);

    await expectDatabaseFailure(
      () =>
        insertFoodEntry(client, {
          userId: userA.id,
          foodDayId: dayId,
          nutritionBasis: { calories: "banana" },
        }),
      {
        code: "23514",
        constraint: "food_entries_nutrition_basis_check",
      },
    );
    await expectDatabaseFailure(
      () =>
        insertFoodEntry(client, {
          userId: userA.id,
          foodDayId: dayId,
          workingNutritionOverride: {},
        }),
      {
        code: "23514",
        constraint: "food_entries_working_nutrition_override_check",
      },
    );
  });

  it("returns false for missing required calories while preserving partial overrides", async () => {
    const result = await client.query<{
      readonly emptyNutrition: boolean;
      readonly missingCalories: boolean;
      readonly zeroCalories: boolean;
      readonly partialOverride: boolean;
      readonly emptyOverride: boolean;
    }>(
      `select
         public.is_nutrition_json('{}'::jsonb) as "emptyNutrition",
         public.is_nutrition_json('{"protein":"10"}'::jsonb) as "missingCalories",
         public.is_nutrition_json('{"calories":"0"}'::jsonb) as "zeroCalories",
         public.is_nutrition_json('{"protein":"10"}'::jsonb, false) as "partialOverride",
         public.is_nutrition_json('{}'::jsonb, false) as "emptyOverride"`,
    );
    expect(result.rows[0]).toEqual({
      emptyNutrition: false,
      missingCalories: false,
      zeroCalories: true,
      partialOverride: true,
      emptyOverride: false,
    });

    const dayId = await insertFoodDay(client, userA.id);
    const entryId = await insertFoodEntry(client, {
      userId: userA.id,
      foodDayId: dayId,
      workingNutritionOverride: { protein: "41.0025" },
    });
    const entry = await client.query<{
      readonly override: Record<string, string>;
    }>(
      `select working_nutrition_override as "override"
       from public.food_entries where id = $1`,
      [entryId],
    );
    expect(entry.rows[0]?.override).toEqual({ protein: "41.0025" });

    const caloriesOnlyId = await insertFoodEntry(client, {
      userId: userA.id,
      foodDayId: dayId,
      nutritionBasis: { calories: "249.13" },
      derivedNutrition: { calories: "685.1075" },
      workingNutrition: { calories: "685.1075" },
    });
    const caloriesOnly = await client.query<{
      readonly nutrition: Record<string, string>;
      readonly override: null;
      readonly low: null;
      readonly high: null;
    }>(
      `select working_nutrition as nutrition,
              working_nutrition_override as "override",
              estimate_low as low, estimate_high as high
       from public.food_entries where id = $1`,
      [caloriesOnlyId],
    );
    expect(caloriesOnly.rows[0]).toEqual({
      nutrition: { calories: "685.1075" },
      override: null,
      low: null,
      high: null,
    });
  });

  it.each([
    { column: "nutrition_basis", fixture: { nutritionBasis: {} } },
    {
      column: "derived_nutrition",
      fixture: { derivedNutrition: { protein: "10" } },
    },
    { column: "working_nutrition", fixture: { workingNutrition: {} } },
    {
      column: "estimate_low",
      fixture: {
        evidenceClass: "ESTIMATED" as const,
        estimateLow: { protein: "10" },
        estimateHigh: { calories: "800" },
      },
    },
    {
      column: "estimate_high",
      fixture: {
        evidenceClass: "ESTIMATED" as const,
        estimateLow: { calories: "600" },
        estimateHigh: {},
      },
    },
  ])("rejects missing calories in $column", async ({ column, fixture }) => {
    const dayId = await insertFoodDay(client, userA.id);
    await expectDatabaseFailure(
      () =>
        insertFoodEntry(client, {
          userId: userA.id,
          foodDayId: dayId,
          ...fixture,
        }),
      { code: "23514", constraint: `food_entries_${column}_check` },
    );
  });

  it.each(["NaN", "Infinity", "-Infinity"])(
    "rejects %s in FoodDay targets and maintenance snapshots",
    async (value) => {
      const dayId = await insertFoodDay(client, userA.id);
      for (const column of [
        "calorie_target",
        "protein_target",
        "maintenance_snapshot",
      ]) {
        await expectDatabaseFailure(
          () =>
            client.query(
              `update public.food_days set ${column} = $2::numeric where id = $1`,
              [dayId, value],
            ),
          { code: "23514", constraint: `food_days_${column}_check` },
        );
      }
    },
  );

  it.each(["NaN", "Infinity", "-Infinity"])(
    "rejects %s in FoodEntry quantities and nutrition basis amounts",
    async (value) => {
      const dayId = await insertFoodDay(client, userA.id);
      const entryId = await insertFoodEntry(client, {
        userId: userA.id,
        foodDayId: dayId,
      });
      for (const column of ["quantity_amount", "nutrition_basis_amount"]) {
        await expectDatabaseFailure(
          () =>
            client.query(
              `update public.food_entries
               set ${column} = $2::numeric, revision = 2 where id = $1`,
              [entryId, value],
            ),
          { code: "23514", constraint: `food_entries_${column}_check` },
        );
      }
    },
  );

  it("retains zero targets, nullable maintenance, and positive quantity bounds", async () => {
    const dayId = await insertFoodDay(client, userA.id);
    const zeroDay = await client.query<{
      readonly calories: string;
      readonly protein: string;
      readonly maintenance: string;
    }>(
      `update public.food_days
       set calorie_target = 0, protein_target = 0, maintenance_snapshot = 0
       where id = $1
       returning calorie_target::text as calories, protein_target::text as protein,
                 maintenance_snapshot::text as maintenance`,
      [dayId],
    );
    expect(zeroDay.rows[0]).toEqual({
      calories: "0",
      protein: "0",
      maintenance: "0",
    });
    const nullable = await client.query<{ readonly maintenance: null }>(
      `update public.food_days set maintenance_snapshot = null where id = $1
       returning maintenance_snapshot as maintenance`,
      [dayId],
    );
    expect(nullable.rows[0]?.maintenance).toBeNull();
    for (const column of [
      "calorie_target",
      "protein_target",
      "maintenance_snapshot",
    ]) {
      await expectDatabaseFailure(
        () =>
          client.query(
            `update public.food_days set ${column} = -1 where id = $1`,
            [dayId],
          ),
        { code: "23514", constraint: `food_days_${column}_check` },
      );
    }

    const entryId = await insertFoodEntry(client, {
      userId: userA.id,
      foodDayId: dayId,
    });
    for (const column of ["quantity_amount", "nutrition_basis_amount"]) {
      for (const value of ["0", "-1"]) {
        await expectDatabaseFailure(
          () =>
            client.query(
              `update public.food_entries set ${column} = $2::numeric, revision = 2
             where id = $1`,
              [entryId, value],
            ),
          { code: "23514", constraint: `food_entries_${column}_check` },
        );
      }
    }
    const finite = await client.query<{
      readonly quantity: string;
      readonly basis: string;
      readonly revision: number;
    }>(
      `update public.food_entries
       set quantity_amount = 0.1, nutrition_basis_amount = 0.1,
           derived_nutrition = nutrition_basis, working_nutrition = nutrition_basis,
           revision = 2
       where id = $1
       returning quantity_amount::text as quantity,
                 nutrition_basis_amount::text as basis, revision`,
      [entryId],
    );
    expect(finite.rows[0]).toEqual({
      quantity: "0.1",
      basis: "0.1",
      revision: 2,
    });
  });

  it("allows PENDING to SUCCEEDED once and then rejects updates", async () => {
    const operationId = randomUUID();
    await client.query(
      `insert into public.semantic_operations (
         id, user_id, operation_key, request_fingerprint
       ) values ($1, $2, $3, $4)`,
      [operationId, userA.id, randomUUID(), randomUUID()],
    );

    const completed = await client.query<{
      readonly status: string;
      readonly result: Record<string, unknown>;
      readonly completedAt: Date | null;
    }>(
      `update public.semantic_operations
       set status = 'SUCCEEDED', result = '{}'::jsonb, completed_at = now()
       where id = $1
       returning status, result, completed_at as "completedAt"`,
      [operationId],
    );
    expect(completed.rows[0]?.status).toBe("SUCCEEDED");
    expect(completed.rows[0]?.result).toEqual({});
    expect(completed.rows[0]?.completedAt).toBeInstanceOf(Date);

    await expectDatabaseFailure(
      () =>
        client.query(
          `update public.semantic_operations
           set result = '{"rewritten":true}'::jsonb
           where id = $1`,
          [operationId],
        ),
      { code: "P0001", message: "terminal semantic operations are immutable" },
    );
  });
});

function testUser(): TestUser {
  const id = randomUUID();
  return { id, email: `cal-calc-m2b2-${id}@example.invalid` };
}

async function createTestUsers(
  database: Client,
  users: readonly TestUser[],
): Promise<void> {
  await database.query(
    `insert into auth.users (
       instance_id,
       id,
       aud,
       role,
       email,
       encrypted_password,
       email_confirmed_at,
       raw_app_meta_data,
       raw_user_meta_data,
       created_at,
       updated_at
     ) values
       ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
       ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [users[0]?.id, users[0]?.email, users[1]?.id, users[1]?.email],
  );
}

async function insertFoodDay(
  database: Client,
  userId: string,
  localDate = "2026-09-01",
): Promise<string> {
  const id = randomUUID();
  await database.query(
    `insert into public.food_days (
       id, user_id, status, completeness, calorie_target, protein_target,
       local_date, timezone
     ) values ($1, $2, 'OPEN', 'UNKNOWN', $3, $4, $5, 'UTC')`,
    [id, userId, "2100", "120", localDate],
  );
  return id;
}

async function insertFoodEntry(
  database: Client,
  fixture: FoodEntryFixture,
): Promise<string> {
  const id = fixture.id ?? randomUUID();
  await database.query(
    `insert into public.food_entries (
       id,
       user_id,
       food_day_id,
       raw_user_description,
       display_name,
       quantity_amount,
       quantity_unit,
       nutrition_basis_amount,
       nutrition_basis_unit,
       nutrition_basis,
       derived_nutrition,
       working_nutrition_override,
       working_nutrition,
       evidence_class,
       estimate_low,
       estimate_high,
       status,
       revision,
       deleted_at
     ) values (
       $1, $2, $3, '275 g label food', 'Label food', $4, 'GRAM', $5, 'GRAM',
       $6, $7, $8, $9, $10, $11, $12, 'CONFIRMED_CONSUMED', $13, $14
     )`,
    [
      id,
      fixture.userId,
      fixture.foodDayId,
      "275",
      "100",
      fixture.nutritionBasis ?? { calories: "249.13", protein: "14.91" },
      fixture.derivedNutrition ?? { calories: "685.1075", protein: "41.0025" },
      fixture.workingNutritionOverride ?? null,
      fixture.workingNutrition ?? { calories: "685.1075", protein: "41.0025" },
      fixture.evidenceClass ?? "EXACT",
      fixture.estimateLow ?? null,
      fixture.estimateHigh ?? null,
      fixture.revision ?? 1,
      fixture.deletedAt ?? null,
    ],
  );
  return id;
}

async function expectDatabaseFailure(
  action: () => Promise<unknown>,
  expected: {
    readonly code: string;
    readonly message?: string;
    readonly constraint?: string;
  },
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof DatabaseError)) {
    throw new Error("Expected PostgreSQL to reject the statement.", {
      cause: caught,
    });
  }
  expect(caught.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(caught.message).toContain(expected.message);
  }
  if (expected.constraint !== undefined) {
    expect(caught.constraint).toBe(expected.constraint);
  }
}

async function cleanupTestUsers(
  database: Client,
  userIds: readonly string[],
): Promise<void> {
  const parameters = [userIds];
  await database.query(
    "delete from public.food_entry_revisions where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from public.food_entries where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from public.semantic_operations where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from public.food_days where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from public.profiles where user_id = any($1::uuid[])",
    parameters,
  );
  await database.query(
    "delete from auth.users where id = any($1::uuid[])",
    parameters,
  );
}
