import { randomUUID } from "node:crypto";

import {
  PostgresAccountConversationTurnRepository,
  PostgresAccountTurnStepResultRepository,
  PostgresBodyWeightRepository,
  type AccountTurnPlan,
} from "@cal-calc/persistence";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executeAccountConversationPlan,
  AccountTurnExecutionNotFoundError,
} from "../conversation/execute-account-conversation-plan.js";
import { PostgresPoolTransactionRunner } from "../postgres/transaction-runner.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === "")
  throw new Error(
    "DATABASE_URL is required for account plan execution integration.",
  );

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const turns = new PostgresAccountConversationTurnRepository(pool);
const stepResults = new PostgresAccountTurnStepResultRepository(pool);
const bodyWeights = new PostgresBodyWeightRepository(pool);
const transactionRunner = new PostgresPoolTransactionRunner(pool);
const userA = randomUUID();
const userB = randomUUID();
const dayA = randomUUID();
const dayB = randomUUID();
const users = [userA, userB];
const foodCommand = {
  rawUserDescription: "oats",
  displayName: "Oats",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "100", protein: "5" },
  },
  evidenceClass: "EXACT",
  status: "CONFIRMED_CONSUMED",
};
const dependencies = { turns, stepResults, bodyWeights, transactionRunner };

async function pending(
  userId = userA,
  dayId = dayA,
  slots: readonly {
    readonly action: AccountTurnPlan["slots"][number]["action"];
    readonly command: AccountTurnPlan["slots"][number]["command"];
  }[] = [{ action: "LOG_FOOD", command: foodCommand }],
  userMessage = "I had oats",
) {
  const turnKey = `key-${randomUUID()}`;
  const requestFingerprint = `fingerprint-${randomUUID()}`;
  const claim = await turns.claimPending({
    id: randomUUID(),
    userId,
    turnKey,
    requestFingerprint,
    userMessage,
    calendarContext: null,
  });
  await turns.setRoutingResolutionOnce({
    userId,
    turnKey,
    requestFingerprint,
    resolution: {
      schema: "account-routing-resolution-v1",
      kind: "EXISTING_DAY",
      foodDayId: dayId,
    },
  });
  const plan: AccountTurnPlan = {
    schema: "account-turn-plan-v1",
    foodDayId: dayId,
    slots: slots.map((slot, index) => ({ index, ...slot })),
  };
  await turns.setPlanOnce({ userId, turnKey, requestFingerprint, plan });
  return { turnId: claim.turn.id, turnKey, requestFingerprint, plan };
}

async function counts(turnId: string) {
  const rows = await pool.query<{
    entries: string;
    operations: string;
    results: string;
  }>(
    `select
       (select count(*)::text from public.food_entries where user_id = $1) as entries,
       (select count(*)::text from public.semantic_operations
         where user_id = $1 and operation_key like 'calcalc:v1:ACCOUNT_TURN_PLAN_STEP:%') as operations,
       (select count(*)::text from public.account_turn_step_results where turn_id = $2) as results`,
    [userA, turnId],
  );
  return rows.rows[0]!;
}

async function denied(
  sql: string,
  values: unknown[] = [],
  role: "authenticated" | "anon" = "authenticated",
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    await expect(client.query(sql, values)).rejects.toMatchObject({
      code: "42501",
    });
    await client.query("rollback");
  } finally {
    client.release();
  }
}

describe("PostgreSQL replay-safe account plan execution", () => {
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
        `plan-${userA}@example.invalid`,
        userB,
        `plan-${userB}@example.invalid`,
      ],
    );
    await pool.query(
      `insert into public.food_days
         (id, user_id, status, completeness, calorie_target, protein_target)
       values ($1, $2, 'OPEN', 'PARTIAL', 2100, 120),
              ($3, $4, 'OPEN', 'PARTIAL', 2100, 120)`,
      [dayA, userA, dayB, userB],
    );
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const table of [
      "conversation_turns",
      "food_entry_revisions",
      "food_entries",
      "body_weight_entries",
      "semantic_operations",
      "conversations",
      "food_days",
      "profiles",
    ]) {
      try {
        await pool.query(
          `delete from public.${table} where user_id = any($1::uuid[])`,
          [users],
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await pool.query("delete from auth.users where id = any($1::uuid[])", [
        users,
      ]);
    } catch (error) {
      failures.push(error);
    }
    try {
      await pool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Account plan execution cleanup failed.",
      );
  });

  it("executes LOG_FOOD once, checkpoints its stable effect, and skips it on retry", async () => {
    const { turnId } = await pending();
    const first = await executeAccountConversationPlan(dependencies, {
      trustedUserId: userA,
      turnId,
    });
    expect(first).toMatchObject({
      kind: "TOOL_SEQUENCE_EXECUTED",
      orderedStepResults: [{ action: "LOG_FOOD", outcome: { revision: 1 } }],
    });
    expect(
      await executeAccountConversationPlan(dependencies, {
        trustedUserId: userA,
        turnId,
      }),
    ).toEqual(first);
    expect(await counts(turnId)).toEqual({
      entries: "1",
      operations: "1",
      results: "1",
    });
    expect((await turns.findById(userA, turnId))?.status).toBe("PENDING");
  });

  it("recovers committed LOG_FOOD after its account checkpoint fails", async () => {
    const { turnId } = await pending();
    const broken = {
      ...dependencies,
      stepResults: {
        listForTurn: stepResults.listForTurn.bind(stepResults),
        async setOnce() {
          throw new Error("checkpoint unavailable");
        },
      },
    };
    await expect(
      executeAccountConversationPlan(broken, { trustedUserId: userA, turnId }),
    ).rejects.toThrow("checkpoint unavailable");
    expect(await counts(turnId)).toEqual({
      entries: "2",
      operations: "2",
      results: "0",
    });
    const recovered = await executeAccountConversationPlan(dependencies, {
      trustedUserId: userA,
      turnId,
    });
    expect(recovered).toMatchObject({
      orderedStepResults: [{ action: "LOG_FOOD", outcome: { revision: 1 } }],
    });
    expect(await counts(turnId)).toEqual({
      entries: "2",
      operations: "2",
      results: "1",
    });
  });

  it("converges concurrent same-step workers on one canonical mutation and result", async () => {
    const { turnId } = await pending();
    const [left, right] = await Promise.all([
      executeAccountConversationPlan(dependencies, {
        trustedUserId: userA,
        turnId,
      }),
      executeAccountConversationPlan(dependencies, {
        trustedUserId: userA,
        turnId,
      }),
    ]);
    expect(left).toEqual(right);
    expect(await counts(turnId)).toEqual({
      entries: "3",
      operations: "3",
      results: "1",
    });
  });

  it("executes weight mutation before the read, then replays its durable read snapshot", async () => {
    const { turnId } = await pending(
      userA,
      dayA,
      [
        {
          action: "LOG_BODY_WEIGHT",
          command: {
            localDate: "2026-10-20",
            sourceValue: "80",
            sourceUnit: "KG",
          },
        },
        { action: "GET_BODY_WEIGHT_HISTORY", command: {} },
      ],
      "I weighed 80 kg on 2026-10-20; show my weight history.",
    );
    const first = await executeAccountConversationPlan(dependencies, {
      trustedUserId: userA,
      turnId,
    });
    expect(first).toMatchObject({
      kind: "TOOL_SEQUENCE_EXECUTED",
      orderedStepResults: [
        { action: "LOG_BODY_WEIGHT" },
        {
          action: "GET_BODY_WEIGHT_HISTORY",
          outcome: { latestMeasurementDate: "2026-10-20" },
        },
      ],
    });
    expect(
      await executeAccountConversationPlan(dependencies, {
        trustedUserId: userA,
        turnId,
      }),
    ).toEqual(first);
    expect(
      (
        await pool.query<{ count: string }>(
          "select count(*)::text as count from public.body_weight_entries where user_id = $1",
          [userA],
        )
      ).rows[0]?.count,
    ).toBe("1");
    expect((await counts(turnId)).results).toBe("2");
  });

  it("recovers a committed weigh-in after a lost account checkpoint", async () => {
    const { turnId } = await pending(
      userA,
      dayA,
      [
        {
          action: "LOG_BODY_WEIGHT",
          command: {
            localDate: "2026-10-20",
            sourceValue: "81",
            sourceUnit: "KG",
          },
        },
      ],
      "I weighed 81 kg on 2026-10-20.",
    );
    const broken = {
      ...dependencies,
      stepResults: {
        listForTurn: stepResults.listForTurn.bind(stepResults),
        async setOnce() {
          throw new Error("checkpoint unavailable");
        },
      },
    };
    await expect(
      executeAccountConversationPlan(broken, { trustedUserId: userA, turnId }),
    ).rejects.toThrow("checkpoint unavailable");
    const before = await pool.query<{ count: string }>(
      "select count(*)::text as count from public.body_weight_entries where user_id = $1",
      [userA],
    );
    await executeAccountConversationPlan(dependencies, {
      trustedUserId: userA,
      turnId,
    });
    const after = await pool.query<{ count: string }>(
      "select count(*)::text as count from public.body_weight_entries where user_id = $1",
      [userA],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect(await stepResults.listForTurn(userA, turnId)).toHaveLength(1);
  });

  it("does not replace frozen entry revision or FoodDay completeness preconditions", async () => {
    const { turnId: createdTurn } = await pending();
    const created = await executeAccountConversationPlan(dependencies, {
      trustedUserId: userA,
      turnId: createdTurn,
    });
    if (created.kind !== "TOOL_SEQUENCE_EXECUTED")
      throw new Error("Expected created entry.");
    const entryId = created.orderedStepResults[0]?.outcome.entryId;
    if (typeof entryId !== "string")
      throw new Error("Expected entry identity.");
    const update = await pending(userA, dayA, [
      {
        action: "UPDATE_FOOD_QUANTITY",
        command: {
          entryId,
          expectedRevision: 1,
          quantity: { amount: "2", unit: "SERVING" },
          overrideAction: { type: "PRESERVE" },
        },
      },
    ]);
    await pool.query(
      "update public.food_entries set revision = 2, display_name = 'Changed elsewhere', last_operation_id = null where id = $1 and user_id = $2",
      [entryId, userA],
    );
    await expect(
      executeAccountConversationPlan(dependencies, {
        trustedUserId: userA,
        turnId: update.turnId,
      }),
    ).rejects.toMatchObject({ name: "FoodEntryRevisionConflictError" });
    expect(await stepResults.listForTurn(userA, update.turnId)).toHaveLength(0);
    const completeness = await pending(userA, dayA, [
      {
        action: "SET_FOOD_DAY_COMPLETENESS",
        command: {
          expectedCompleteness: "PARTIAL",
          targetCompleteness: "USER_DECLARED_COMPLETE",
        },
      },
    ]);
    await pool.query(
      "update public.food_days set completeness = 'UNKNOWN' where id = $1",
      [dayA],
    );
    await expect(
      executeAccountConversationPlan(dependencies, {
        trustedUserId: userA,
        turnId: completeness.turnId,
      }),
    ).rejects.toMatchObject({ name: "FoodDayCompletenessConflictError" });
    expect(
      await stepResults.listForTurn(userA, completeness.turnId),
    ).toHaveLength(0);
  });

  it("enforces prefix, set-once, owner FK, completed guard, and direct-client denial", async () => {
    const { turnId, turnKey, requestFingerprint } = await pending(userA, dayA, [
      { action: "GET_BODY_WEIGHT_HISTORY", command: {} },
      { action: "GET_BODY_WEIGHT_HISTORY", command: {} },
    ]);
    const outcome = {
      schema: "account-turn-step-result-v1",
      action: "GET_BODY_WEIGHT_HISTORY",
      outcome: {
        recentObservations: [],
        recentHistoryMayBeTruncated: false,
        latestMeasurementDate: null,
        latestDateObservationCount: 0,
        latestDateObservations: [],
        latestDateObservationsComplete: true,
      },
    } as const;
    await expect(
      pool.query(
        "insert into public.account_turn_step_results (turn_id,user_id,ordinal,result) values ($1,$2,1,$3::jsonb)",
        [turnId, userA, JSON.stringify(outcome)],
      ),
    ).rejects.toThrow();
    const first = await stepResults.setOnce({
      userId: userA,
      turnId,
      ordinal: 0,
      result: outcome,
    });
    expect(
      await stepResults.setOnce({
        userId: userA,
        turnId,
        ordinal: 0,
        result: outcome,
      }),
    ).toEqual(first);
    await expect(
      pool.query(
        "insert into public.account_turn_step_results (turn_id,user_id,ordinal,result) values ($1,$2,1,$3::jsonb)",
        [turnId, userB, JSON.stringify(outcome)],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "update public.account_turn_step_results set result = $3::jsonb where turn_id = $1 and ordinal = $2",
        [turnId, 0, JSON.stringify(outcome)],
      ),
    ).rejects.toThrow();
    await denied(
      "select * from public.account_turn_step_results where turn_id = $1",
      [turnId],
    );
    await denied(
      "select * from public.account_turn_step_results where turn_id = $1",
      [turnId],
      "anon",
    );
    await denied(
      "insert into public.account_turn_step_results (turn_id,user_id,ordinal,result) values ($1,$2,1,$3::jsonb)",
      [turnId, userA, JSON.stringify(outcome)],
    );
    await turns.markCompleted({
      userId: userA,
      turnKey,
      requestFingerprint,
      response: "done",
    });
    await expect(
      pool.query(
        "insert into public.account_turn_step_results (turn_id,user_id,ordinal,result) values ($1,$2,1,$3::jsonb)",
        [turnId, userA, JSON.stringify(outcome)],
      ),
    ).rejects.toThrow();
    expect(
      await executeAccountConversationPlan(dependencies, {
        trustedUserId: userA,
        turnId,
      }),
    ).toEqual({ kind: "COMPLETED_REPLAY", response: "done" });
    await expect(
      executeAccountConversationPlan(dependencies, {
        trustedUserId: userB,
        turnId,
      }),
    ).rejects.toBeInstanceOf(AccountTurnExecutionNotFoundError);
  });
});
