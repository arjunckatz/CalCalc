import { randomUUID } from "node:crypto";

import {
  createFoodEntry,
  updateFoodEntryQuantity,
  type FoodEntry,
} from "@cal-calc/domain";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  PostgresFoodEntryRepository,
  PostgresSemanticOperationRepository,
  SemanticOperationIdempotencyConflictError,
  updateFoodEntryExactlyOnce,
  type PostgresExecutor,
  type PostgresTransactionRunner,
  type UpdateFoodEntryExactlyOnceInput,
} from "../index.js";

interface TestUser {
  readonly id: string;
  readonly email: string;
}

class ClientTransactionRunner implements PostgresTransactionRunner {
  constructor(private readonly executor: PostgresExecutor) {}

  async runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ): Promise<Value> {
    await this.executor.query("begin");
    try {
      const value = await work(this.executor);
      await this.executor.query("commit");
      return value;
    } catch (error) {
      await this.executor.query("rollback");
      throw error;
    }
  }
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error(
    "DATABASE_URL is required for the PostgreSQL exactly-once FoodEntry update integration test.",
  );
}

const client = new Client({ connectionString: databaseUrl });
const transactionRunner = new ClientTransactionRunner(client);
const foodEntryRepository = new PostgresFoodEntryRepository(client);
const operationRepository = new PostgresSemanticOperationRepository(client);
const userA = testUser();
const userB = testUser();
const dayAId = randomUUID();
let connected = false;

describe("PostgreSQL exactly-once FoodEntry updates", () => {
  beforeAll(async () => {
    await client.connect();
    connected = true;
    await createFixtures(client, [userA, userB]);
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await cleanupFixtures(client, [userA.id, userB.id]);
    } finally {
      await client.end();
    }
  });

  it("applies a 200 g to 250 g correction and links revision 2 to its operation", async () => {
    const { original, input, applied } = await applyCorrection();

    expect(original.revision).toBe(1);
    expect(original.quantity.amount).toBe("200");
    expect(original.derivedNutrition).toEqual({
      calories: "498.26",
      protein: "29.82",
    });
    expect(applied.disposition).toBe("APPLIED");
    expect(applied.appliedRevision).toBe(2);
    expect(applied.entry.entry).toEqual(input.entry);
    expect(applied.entry.entry.revision).toBe(2);
    expect(applied.entry.entry.quantity.amount).toBe("250");
    expect(applied.entry.entry.derivedNutrition).toEqual({
      calories: "622.825",
      protein: "37.275",
    });
    expect(applied.entry.entry.workingNutrition).toEqual({
      calories: "622.825",
      protein: "37.275",
    });
    expect(applied.entry.lastOperationId).toBe(input.operationId);
    expect(applied.operation).toMatchObject({
      id: input.operationId,
      userId: userA.id,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
      status: "SUCCEEDED",
      result: {
        kind: "FOOD_ENTRY_UPDATED",
        entryId: original.id,
        appliedRevision: 2,
      },
      error: null,
    });
    expect(await foodEntryRepository.findById(userA.id, original.id)).toEqual(
      applied.entry,
    );
    expect(
      await operationRepository.findByKey(userA.id, input.operationKey),
    ).toEqual(applied.operation);
    expect(await revisionHistory(userA.id, original.id)).toEqual([
      { revision: 1, operation_id: null },
      { revision: 2, operation_id: input.operationId },
    ]);
  });

  it("replays the same retry without creating another revision or operation", async () => {
    const { original, input, applied } = await applyCorrection();
    const history = await revisionHistory(userA.id, original.id);

    const replayed = await updateFoodEntryExactlyOnce(transactionRunner, {
      ...input,
      operationId: randomUUID(),
    });

    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.appliedRevision).toBe(2);
    expect(replayed.entry.entry.revision).toBe(2);
    expect(replayed.entry).toEqual(applied.entry);
    expect(replayed.operation).toEqual(applied.operation);
    expect(await revisionHistory(userA.id, original.id)).toEqual(history);
    expect(await operationCount(userA.id, input.operationKey)).toBe("1");
  });

  it("rejects a fingerprint conflict without rewriting canonical state or the operation", async () => {
    const { original, input, applied } = await applyCorrection();
    const history = await revisionHistory(userA.id, original.id);

    await expect(
      updateFoodEntryExactlyOnce(transactionRunner, {
        ...input,
        operationId: randomUUID(),
        requestFingerprint: `request-${randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);

    expect(await foodEntryRepository.findById(userA.id, original.id)).toEqual(
      applied.entry,
    );
    expect(await revisionHistory(userA.id, original.id)).toEqual(history);
    expect(
      await operationRepository.findByKey(userA.id, input.operationKey),
    ).toEqual(applied.operation);
    expect(await operationCount(userA.id, input.operationKey)).toBe("1");
  });

  it("rolls back a new semantic claim when the expected FoodEntry revision is stale", async () => {
    const { original, applied } = await applyCorrection();
    const staleInput = correctionInput(original, "275");
    const history = await revisionHistory(userA.id, original.id);

    await expect(
      updateFoodEntryExactlyOnce(transactionRunner, staleInput),
    ).rejects.toMatchObject({
      name: "FoodEntryRevisionConflictError",
      entryId: original.id,
      expectedRevision: 1,
      actualRevision: 2,
    } satisfies Partial<FoodEntryRevisionConflictError>);

    // These reads run after the transaction runner has completed ROLLBACK.
    expect(await foodEntryRepository.findById(userA.id, original.id)).toEqual(
      applied.entry,
    );
    expect(await revisionHistory(userA.id, original.id)).toEqual(history);
    expect(
      await operationRepository.findByKey(userA.id, staleInput.operationKey),
    ).toBeNull();
    expect(await operationCount(userA.id, staleInput.operationKey)).toBe("0");
  });

  it("rolls back User B's claim when User A's FoodEntry is not visible", async () => {
    const { original, applied } = await applyCorrection();
    const wrongUserInput = {
      ...correctionInput(applied.entry.entry, "300"),
      userId: userB.id,
    };
    const history = await revisionHistory(userA.id, original.id);

    await expect(
      updateFoodEntryExactlyOnce(transactionRunner, wrongUserInput),
    ).rejects.toBeInstanceOf(FoodEntryNotFoundError);

    // Verify canonical state and the absence of the failed claim outside the transaction.
    expect(
      await foodEntryRepository.findById(userB.id, original.id),
    ).toBeNull();
    expect(await foodEntryRepository.findById(userA.id, original.id)).toEqual(
      applied.entry,
    );
    expect(await revisionHistory(userA.id, original.id)).toEqual(history);
    expect(
      await operationRepository.findByKey(
        userB.id,
        wrongUserInput.operationKey,
      ),
    ).toBeNull();
    expect(await operationCount(userB.id, wrongUserInput.operationKey)).toBe(
      "0",
    );
  });

  it("replays operation A's applied revision 2 while returning operation B's current revision 3", async () => {
    const { original, input, applied } = await applyCorrection();
    const laterInput = correctionInput(applied.entry.entry, "300");
    const later = await updateFoodEntryExactlyOnce(
      transactionRunner,
      laterInput,
    );
    expect(later.disposition).toBe("APPLIED");
    expect(later.appliedRevision).toBe(3);
    expect(later.entry.entry.revision).toBe(3);
    expect(later.entry.entry.derivedNutrition).toEqual({
      calories: "747.39",
      protein: "44.73",
    });
    const history = await revisionHistory(userA.id, original.id);
    expect(history).toEqual([
      { revision: 1, operation_id: null },
      { revision: 2, operation_id: input.operationId },
      { revision: 3, operation_id: laterInput.operationId },
    ]);

    const replayed = await updateFoodEntryExactlyOnce(transactionRunner, {
      ...input,
      operationId: randomUUID(),
    });

    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.appliedRevision).toBe(2);
    expect(replayed.operation).toEqual(applied.operation);
    expect(replayed.entry).toEqual(later.entry);
    expect(replayed.entry.entry.revision).toBe(3);
    expect(replayed.entry.lastOperationId).toBe(laterInput.operationId);
    expect(await foodEntryRepository.findById(userA.id, original.id)).toEqual(
      later.entry,
    );
    expect(await revisionHistory(userA.id, original.id)).toEqual(history);
    expect(
      await operationRepository.findByKey(userA.id, input.operationKey),
    ).toEqual(applied.operation);
    expect(
      await operationRepository.findByKey(userA.id, laterInput.operationKey),
    ).toEqual(later.operation);
  });
});

async function applyCorrection() {
  const original = createFoodEntry({
    id: randomUUID(),
    foodDayId: dayAId,
    rawUserDescription: "200 g chicken and rice",
    displayName: "Chicken and rice",
    quantity: { amount: "200", unit: "GRAM" },
    nutritionBasis: {
      amount: "100",
      unit: "GRAM",
      nutrition: { calories: "249.13", protein: "14.91" },
    },
    evidenceClass: "EXACT",
    status: "CONFIRMED_CONSUMED",
  });
  await foodEntryRepository.create({ userId: userA.id, entry: original });
  const input = correctionInput(original, "250");
  const applied = await updateFoodEntryExactlyOnce(transactionRunner, input);
  return { original, input, applied };
}

function correctionInput(
  current: FoodEntry,
  amount: string,
): UpdateFoodEntryExactlyOnceInput {
  const mutation = updateFoodEntryQuantity(current, {
    expectedRevision: current.revision,
    quantity: { amount, unit: "GRAM" },
    overrideAction: { type: "PRESERVE" },
  });
  if (!mutation.ok) throw new Error("Unexpected domain revision conflict.");
  return {
    userId: userA.id,
    operationId: randomUUID(),
    operationKey: `correct-quantity-${randomUUID()}`,
    requestFingerprint: `request-${randomUUID()}`,
    expectedRevision: current.revision,
    entry: mutation.value,
  };
}

async function revisionHistory(userId: string, entryId: string) {
  const result = await client.query<{
    readonly revision: number;
    readonly operation_id: string | null;
  }>(
    `select revision, operation_id
     from public.food_entry_revisions
     where user_id = $1 and food_entry_id = $2
     order by revision`,
    [userId, entryId],
  );
  return result.rows;
}

async function operationCount(userId: string, operationKey: string) {
  const result = await client.query<{ readonly count: string }>(
    `select count(*)::text as count
     from public.semantic_operations
     where user_id = $1 and operation_key = $2`,
    [userId, operationKey],
  );
  return result.rows[0]?.count;
}

function testUser(): TestUser {
  const id = randomUUID();
  return { id, email: `cal-calc-m2b8-${id}@example.invalid` };
}

async function createFixtures(
  database: Client,
  users: readonly [TestUser, TestUser],
): Promise<void> {
  await database.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password,
       email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at
     ) values
       ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
       ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
    [users[0].id, users[0].email, users[1].id, users[1].email],
  );
  await database.query(
    "insert into public.profiles (user_id) values ($1), ($2)",
    [users[0].id, users[1].id],
  );
  await database.query(
    `insert into public.food_days (
       id, user_id, status, completeness, calorie_target, protein_target,
       local_date, timezone
     ) values ($1, $2, 'OPEN', 'UNKNOWN', $3, $4, '2026-09-05', 'UTC')`,
    [dayAId, users[0].id, "2100", "120"],
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
