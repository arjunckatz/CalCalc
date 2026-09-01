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
  readonly workingNutritionOverride?: Record<string, string> | null;
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
       status,
       revision,
       deleted_at
     ) values (
       $1, $2, $3, '275 g label food', 'Label food', $4, 'GRAM', $5, 'GRAM',
       $6, $7, $8, $7, 'EXACT', 'CONFIRMED_CONSUMED', $9, $10
     )`,
    [
      id,
      fixture.userId,
      fixture.foodDayId,
      "275",
      "100",
      fixture.nutritionBasis ?? { calories: "249.13", protein: "14.91" },
      { calories: "685.1075", protein: "41.0025" },
      fixture.workingNutritionOverride ?? null,
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
