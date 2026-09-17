import { randomUUID } from "node:crypto";

import {
  changeFoodEntryStatus,
  createFoodEntry,
  deleteFoodEntry,
  updateFoodEntryQuantity,
  type MutationResult,
} from "@cal-calc/domain";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  PostgresFoodEntryRepository,
} from "../index.js";

interface TestUser {
  readonly id: string;
  readonly email: string;
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the PostgreSQL FoodEntry repository integration test.",
  );
}

const client = new Client({ connectionString: databaseUrl });
const repository = new PostgresFoodEntryRepository(client);
const userA = testUser();
const userB = testUser();
const dayAId = randomUUID();
const dayBId = randomUUID();
const consumedAt = "2026-09-02T14:30:00.000Z";
let connected = false;

describe("PostgreSQL FoodEntry repository", () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    await createFixtures(client, [userA, userB], [dayAId, dayBId]);
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await cleanupFixtures(client, [userA.id, userB.id]);
    } finally {
      await client.end();
    }
  });

  it("round-trips exact state, guards revisions and ownership, and persists logical deletion", async () => {
    const entry = createFoodEntry({
      id: randomUUID(),
      foodDayId: dayAId,
      rawUserDescription: "275 g label food",
      displayName: "Label food",
      quantity: { amount: "275", unit: "GRAM" },
      nutritionBasis: {
        amount: "100",
        unit: "GRAM",
        nutrition: { calories: "249.13", protein: "14.91" },
      },
      evidenceClass: "EXACT",
      status: "CONFIRMED_CONSUMED",
    });

    const created = await repository.create({
      userId: userA.id,
      entry,
      consumedAt,
      consumedTimePrecision: "APPROXIMATE",
    });
    expect(created.userId).toBe(userA.id);
    expect(new Date(created.consumedAt ?? "").toISOString()).toBe(consumedAt);
    expect(created.consumedTimePrecision).toBe("APPROXIMATE");
    expect(created.entry).toEqual(entry);
    expect(created.entry.derivedNutrition).toEqual({
      calories: "685.1075",
      protein: "41.0025",
    });
    expect(typeof created.entry.derivedNutrition.calories).toBe("string");
    expect("carbs" in created.entry.derivedNutrition).toBe(false);

    const loaded = await repository.findById(userA.id, entry.id);
    expect(loaded?.entry).toEqual(created.entry);
    expect(new Date(loaded?.consumedAt ?? "").toISOString()).toBe(consumedAt);
    expect(loaded?.consumedTimePrecision).toBe("APPROXIMATE");
    expect(await repository.findById(userB.id, entry.id)).toBeNull();

    const quantityUpdate = successful(
      updateFoodEntryQuantity(created.entry, {
        expectedRevision: 1,
        quantity: { amount: "0.1", unit: "GRAM" },
        overrideAction: { type: "PRESERVE" },
      }),
    );
    const updated = await repository.update({
      userId: userA.id,
      expectedRevision: 1,
      entry: quantityUpdate,
    });
    expect(updated.entry.revision).toBe(2);
    expect(updated.entry.quantity.amount).toBe("0.1");
    expect(updated.entry.derivedNutrition).toEqual({
      calories: "0.24913",
      protein: "0.01491",
    });
    expect((await repository.findById(userA.id, entry.id))?.entry).toEqual(
      updated.entry,
    );

    const staleUpdate = successful(
      changeFoodEntryStatus(created.entry, {
        expectedRevision: 1,
        status: "PLANNED",
      }),
    );
    await expect(
      repository.update({
        userId: userA.id,
        expectedRevision: 1,
        entry: staleUpdate,
      }),
    ).rejects.toMatchObject({
      name: "FoodEntryRevisionConflictError",
      expectedRevision: 1,
      actualRevision: 2,
    } satisfies Partial<FoodEntryRevisionConflictError>);

    const crossAccountUpdate = successful(
      changeFoodEntryStatus(updated.entry, {
        expectedRevision: 2,
        status: "PLANNED",
      }),
    );
    await expect(
      repository.update({
        userId: userB.id,
        expectedRevision: 2,
        entry: crossAccountUpdate,
      }),
    ).rejects.toBeInstanceOf(FoodEntryNotFoundError);
    expect((await repository.findById(userA.id, entry.id))?.entry).toEqual(
      updated.entry,
    );

    const deletedEntry = successful(
      deleteFoodEntry(updated.entry, {
        expectedRevision: 2,
        deletedAt: "2026-09-02T12:00:00.000Z",
      }),
    );
    const deleted = await repository.update({
      userId: userA.id,
      expectedRevision: 2,
      entry: deletedEntry,
    });
    expect(deleted.entry.revision).toBe(3);
    expect(new Date(deleted.entry.deletedAt ?? "").toISOString()).toBe(
      "2026-09-02T12:00:00.000Z",
    );
    expect((await repository.findById(userA.id, entry.id))?.entry).toEqual(
      deleted.entry,
    );
  });

  it("lists only current owned entries in immutable creation and ID order", async () => {
    const [lowerId, higherId, olderId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ].sort() as [string, string, string];
    const makeEntry = (id: string, foodDayId: string) =>
      createFoodEntry({
        id,
        foodDayId,
        rawUserDescription: "275 g label food",
        displayName: "Label food",
        quantity: { amount: "275", unit: "GRAM" },
        nutritionBasis: {
          amount: "100",
          unit: "GRAM",
          nutrition: { calories: "249.13", protein: "14.91" },
        },
        evidenceClass: "EXACT",
        status: "CONFIRMED_CONSUMED",
      });
    const older = makeEntry(olderId, dayAId);
    const higher = makeEntry(higherId, dayAId);
    const lower = makeEntry(lowerId, dayAId);
    const removedCandidate = makeEntry(randomUUID(), dayAId);
    const otherUser = makeEntry(randomUUID(), dayBId);

    // An explicit INSERT timestamp is legal; only later UPDATEs are immutable.
    await client.query(
      `insert into public.food_entries (
         id, user_id, food_day_id, raw_user_description, display_name,
         quantity_amount, quantity_unit, nutrition_basis_amount,
         nutrition_basis_unit, nutrition_basis, derived_nutrition,
         working_nutrition, evidence_class, status, revision, created_at
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16::timestamptz
       )`,
      [
        older.id,
        userA.id,
        dayAId,
        older.rawUserDescription,
        older.displayName,
        older.quantity.amount,
        older.quantity.unit,
        older.nutritionBasis.amount,
        older.nutritionBasis.unit,
        older.nutritionBasis.nutrition,
        older.derivedNutrition,
        older.workingNutrition,
        older.evidenceClass,
        older.status,
        older.revision,
        "2020-01-01T00:00:00.000Z",
      ],
    );

    await client.query("begin");
    try {
      // PostgreSQL now() is transaction-stable: these inserts tie on created_at.
      await repository.create({ userId: userA.id, entry: higher });
      await repository.create({ userId: userA.id, entry: lower });
      await repository.create({ userId: userA.id, entry: removedCandidate });
      await repository.create({ userId: userB.id, entry: otherUser });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    const timestamps = await client.query<{ readonly created_at: Date }>(
      `select created_at from public.food_entries where id = any($1::uuid[])`,
      [[lowerId, higherId]],
    );
    expect(timestamps.rows).toHaveLength(2);
    expect(timestamps.rows[0]?.created_at).toEqual(
      timestamps.rows[1]?.created_at,
    );

    const removed = successful(
      deleteFoodEntry(removedCandidate, {
        expectedRevision: 1,
        deletedAt: "2026-09-02T12:00:00.000Z",
      }),
    );
    await repository.update({
      userId: userA.id,
      expectedRevision: 1,
      entry: removed,
    });

    const entries = await repository.listActiveByFoodDay(userA.id, dayAId);
    expect(entries).toEqual([older, lower, higher]);
    expect(entries.map((entry) => entry.id)).not.toContain(removedCandidate.id);
    expect(entries.map((entry) => entry.id)).not.toContain(otherUser.id);
    expect(await repository.listActiveByFoodDay(userB.id, dayAId)).toEqual([]);
    expect(await repository.listActiveByFoodDay(userA.id, dayBId)).toEqual([]);
    const foundDeleted = await repository.findById(
      userA.id,
      removedCandidate.id,
    );
    expect(foundDeleted?.entry).toMatchObject({
      id: removedCandidate.id,
      revision: 2,
    });
    expect(new Date(foundDeleted?.entry.deletedAt ?? "").toISOString()).toBe(
      removed.deletedAt,
    );
  });
});

function testUser(): TestUser {
  const id = randomUUID();
  return { id, email: `cal-calc-m2b4-${id}@example.invalid` };
}

async function createFixtures(
  database: Client,
  users: readonly [TestUser, TestUser],
  dayIds: readonly [string, string],
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
    [users[0].id, users[0].email, users[1].id, users[1].email],
  );
  await database.query(
    `insert into public.profiles (user_id) values ($1), ($2)`,
    [users[0].id, users[1].id],
  );
  await database.query(
    `insert into public.food_days (
       id, user_id, status, completeness, calorie_target, protein_target,
       local_date, timezone
     ) values
       ($1, $2, 'OPEN', 'UNKNOWN', $3, $4, '2026-09-02', 'UTC'),
       ($5, $6, 'OPEN', 'UNKNOWN', $3, $4, '2026-09-02', 'UTC')`,
    [dayIds[0], users[0].id, "2100", "120", dayIds[1], users[1].id],
  );
}

async function cleanupFixtures(
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

function successful<Value>(result: MutationResult<Value>): Value {
  if (!result.ok) throw new Error(`Unexpected conflict: ${result.error.type}`);
  return result.value;
}
