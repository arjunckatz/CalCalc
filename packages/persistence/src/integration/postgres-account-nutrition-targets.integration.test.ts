import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AccountNutritionTargetsVersionConflictError,
  PostgresAccountNutritionTargetsRepository,
  SemanticOperationIdempotencyConflictError,
  setAccountNutritionTargetsExactlyOnce,
  type PostgresExecutor,
  type PostgresTransactionRunner,
  type SetAccountNutritionTargetsExactlyOnceInput,
} from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "")
  throw new Error("DATABASE_URL is required for account target integration.");

const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const targets = new PostgresAccountNutritionTargetsRepository(pool);
const userA = randomUUID();
const userB = randomUUID();
const userIds = [userA, userB];

const runner: PostgresTransactionRunner = {
  async runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ): Promise<Value> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      try {
        const result = await work(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    } finally {
      client.release();
    }
  },
};

function input(
  userId = userA,
  overrides: Partial<SetAccountNutritionTargetsExactlyOnceInput> = {},
): SetAccountNutritionTargetsExactlyOnceInput {
  return {
    userId,
    operationId: randomUUID(),
    operationKey: `set-targets-${randomUUID()}`,
    requestFingerprint: `fingerprint-${randomUUID()}`,
    expectedVersion: null,
    calorieTarget: "685.1075",
    proteinTarget: "41.0025",
    ...overrides,
  };
}

async function counts(userId: string) {
  const result = await pool.query<{ targets: string; operations: string }>(
    `select
       (select count(*)::text from public.account_nutrition_targets where user_id = $1) as targets,
       (select count(*)::text from public.semantic_operations where user_id = $1) as operations`,
    [userId],
  );
  return result.rows[0];
}

describe("PostgreSQL account nutrition target defaults", () => {
  beforeAll(async () => {
    await pool.query(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password,
         email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
         created_at, updated_at
       ) values
         ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
         ('00000000-0000-0000-0000-000000000000', $3, 'authenticated', 'authenticated', $4, '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`,
      [
        userA,
        `calcalc-m5a6-${userA}@example.invalid`,
        userB,
        `calcalc-m5a6-${userB}@example.invalid`,
      ],
    );
  });

  beforeEach(async () => {
    await pool.query(
      "delete from public.semantic_operations where user_id = any($1::uuid[])",
      [userIds],
    );
    await pool.query(
      "delete from public.account_nutrition_targets where user_id = any($1::uuid[])",
      [userIds],
    );
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const sql of [
      "delete from public.semantic_operations where user_id = any($1::uuid[])",
      "delete from public.account_nutrition_targets where user_id = any($1::uuid[])",
      "delete from public.profiles where user_id = any($1::uuid[])",
      "delete from auth.users where id = any($1::uuid[])",
    ]) {
      try {
        await pool.query(sql, [userIds]);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await pool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Account target fixture cleanup failed.",
      );
  });

  it("creates, reads, and updates exact two-target configuration with DB-owned time and per-user isolation", async () => {
    expect(await targets.findByUser(userA)).toBeNull();
    const originalInput = input();
    const created = await setAccountNutritionTargetsExactlyOnce(
      runner,
      originalInput,
    );
    expect(created).toMatchObject({
      disposition: "APPLIED",
      targets: {
        userId: userA,
        calorieTarget: "685.1075",
        proteinTarget: "41.0025",
        version: 0,
      },
    });
    expect(await targets.findByUser(userA)).toEqual(created.targets);
    expect(await targets.findByUser(userB)).toBeNull();
    expect(await counts(userA)).toEqual({ targets: "1", operations: "1" });
    expect(Number.isNaN(Date.parse(created.targets.createdAt))).toBe(false);
    expect(created.targets.updatedAt).toBe(created.targets.createdAt);
    expect(created.operation).toMatchObject({
      status: "SUCCEEDED",
      result: {
        calorieTarget: "685.1075",
        proteinTarget: "41.0025",
        version: 0,
      },
    });

    const updated = await setAccountNutritionTargetsExactlyOnce(
      runner,
      input(userA, {
        expectedVersion: 0,
        calorieTarget: "249.13",
        proteinTarget: "0.1",
      }),
    );
    expect(updated.targets).toMatchObject({
      calorieTarget: "249.13",
      proteinTarget: "0.1",
      version: 1,
      createdAt: created.targets.createdAt,
    });
    expect(await targets.findByUser(userA)).toEqual(updated.targets);
    expect(await counts(userA)).toEqual({ targets: "1", operations: "2" });
    const replay = await setAccountNutritionTargetsExactlyOnce(runner, {
      ...originalInput,
      operationId: randomUUID(),
    });
    expect(replay.disposition).toBe("REPLAYED");
    expect(replay.targets).toEqual(created.targets);
    expect(await targets.findByUser(userA)).toEqual(updated.targets);
    expect(await counts(userA)).toEqual({ targets: "1", operations: "2" });
    const raw = await pool.query<{
      calories: string;
      protein: string;
      version: number;
    }>(
      "select calorie_target::text as calories, protein_target::text as protein, version from public.account_nutrition_targets where user_id = $1",
      [userA],
    );
    expect(raw.rows[0]).toEqual({
      calories: "249.13",
      protein: "0.1",
      version: 1,
    });
  });

  it("replays a durable original result and rejects changed same-key meaning", async () => {
    const original = input();
    const first = await setAccountNutritionTargetsExactlyOnce(runner, original);
    const replay = await setAccountNutritionTargetsExactlyOnce(runner, {
      ...original,
      operationId: randomUUID(),
    });
    expect(replay.disposition).toBe("REPLAYED");
    expect(replay.targets).toEqual(first.targets);
    expect(replay.operation.id).toBe(first.operation.id);
    expect(await counts(userA)).toEqual({ targets: "1", operations: "1" });
    await expect(
      setAccountNutritionTargetsExactlyOnce(runner, {
        ...original,
        operationId: randomUUID(),
        requestFingerprint: "changed",
      }),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
    expect(await counts(userA)).toEqual({ targets: "1", operations: "1" });
  });

  it("rejects stale update and rolls back its distinct semantic claim", async () => {
    await setAccountNutritionTargetsExactlyOnce(runner, input());
    await expect(
      setAccountNutritionTargetsExactlyOnce(
        runner,
        input(userA, { expectedVersion: 1 }),
      ),
    ).rejects.toBeInstanceOf(AccountNutritionTargetsVersionConflictError);
    await expect(
      setAccountNutritionTargetsExactlyOnce(
        runner,
        input(userA, { expectedVersion: null }),
      ),
    ).rejects.toBeInstanceOf(AccountNutritionTargetsVersionConflictError);
    expect(await counts(userA)).toEqual({ targets: "1", operations: "1" });
    expect((await targets.findByUser(userA))?.version).toBe(0);
  });

  it("concurrent initial sets choose one winner, including identical values, without merging intent", async () => {
    const proposals = [input(), input(userA, { calorieTarget: "249.13" })];
    const results = await Promise.allSettled(
      proposals.map((proposal) =>
        setAccountNutritionTargetsExactlyOnce(runner, proposal),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      AccountNutritionTargetsVersionConflictError,
    );
    expect(await counts(userA)).toEqual({ targets: "1", operations: "1" });
    const same = await Promise.allSettled(
      [input(userB), input(userB)].map((proposal) =>
        setAccountNutritionTargetsExactlyOnce(runner, proposal),
      ),
    );
    expect(same.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(await counts(userB)).toEqual({ targets: "1", operations: "1" });
  });

  it("concurrent same-version updates allow one CAS winner", async () => {
    await setAccountNutritionTargetsExactlyOnce(runner, input());
    const proposals = [
      input(userA, { expectedVersion: 0, calorieTarget: "249.13" }),
      input(userA, { expectedVersion: 0, calorieTarget: "250" }),
    ];
    const results = await Promise.allSettled(
      proposals.map((proposal) =>
        setAccountNutritionTargetsExactlyOnce(runner, proposal),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      AccountNutritionTargetsVersionConflictError,
    );
    expect((await targets.findByUser(userA))?.version).toBe(1);
    expect(await counts(userA)).toEqual({ targets: "1", operations: "2" });
  });

  it("keeps both owners independent and grants no direct authenticated/anon table access", async () => {
    await setAccountNutritionTargetsExactlyOnce(runner, input(userA));
    await setAccountNutritionTargetsExactlyOnce(
      runner,
      input(userB, { calorieTarget: "0", proteinTarget: "0" }),
    );
    expect((await targets.findByUser(userB))?.calorieTarget).toBe("0");
    expect((await targets.findByUser(userA))?.calorieTarget).toBe("685.1075");
    const privileges = await pool.query<{
      role: string;
      can_read: boolean;
      can_write: boolean;
      rls: boolean;
    }>(
      `select role_name as role,
         has_table_privilege(role_name, 'public.account_nutrition_targets', 'SELECT') as can_read,
         has_table_privilege(role_name, 'public.account_nutrition_targets', 'INSERT,UPDATE,DELETE') as can_write,
         (select relrowsecurity from pg_class where oid = 'public.account_nutrition_targets'::regclass) as rls
       from (values ('anon'), ('authenticated')) as roles(role_name)`,
    );
    expect(privileges.rows).toEqual([
      { role: "anon", can_read: false, can_write: false, rls: true },
      { role: "authenticated", can_read: false, can_write: false, rls: true },
    ]);

    const client = await pool.connect();
    try {
      for (const sql of [
        "select * from public.account_nutrition_targets",
        "insert into public.account_nutrition_targets (user_id, calorie_target, protein_target) values ($1, 1, 1)",
      ]) {
        await client.query("begin");
        try {
          await client.query("set local role authenticated");
          await expect(
            client.query(sql, sql.includes("$1") ? [userA] : []),
          ).rejects.toMatchObject({
            code: "42501",
          });
        } finally {
          await client.query("rollback");
        }
      }
    } finally {
      client.release();
    }
  });
});
