import { createHash } from "node:crypto";

import { createFoodDay } from "@cal-calc/domain";
import { describe, expect, it } from "vitest";

import { toFoodDayRow } from "../mapping.js";
import type { PostgresExecutor } from "./food-entry-repository.js";
import {
  AccountTurnMaterializationIneligibleError,
  AccountTurnMaterializationIntegrityError,
  materializeAccountTurnFoodDay,
} from "./materialize-account-turn-food-day.js";
import type { PostgresTransactionRunner } from "./transaction.js";

const userId = "10000000-0000-4000-8000-000000000001";
const turnId = "20000000-0000-4000-8000-000000000001";
const dayId = "30000000-0000-4000-8000-000000000001";
const otherDayId = "30000000-0000-4000-8000-000000000002";
const date = "2026-10-18";
const timestamp = "2026-10-18T00:00:00Z";
const input = { trustedUserId: userId, turnId };
const resolution = {
  schema: "account-routing-resolution-v1",
  kind: "DATE_TARGET",
  localDate: date,
};
const operationKey = `calcalc:account-turn:materialize-food-day:v1:${turnId}`;
const fingerprint = createHash("sha256")
  .update(
    JSON.stringify([
      "calcalc:account-turn:materialize-food-day:v1",
      userId,
      turnId,
      date,
    ]),
  )
  .digest("hex");

type Response =
  readonly unknown[] | Error | ((values: unknown[]) => readonly unknown[]);
class Runner implements PostgresTransactionRunner, PostgresExecutor {
  readonly calls: { sql: string; values: unknown[] }[] = [];
  commits = 0;
  rollbacks = 0;
  constructor(private readonly responses: readonly Response[]) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    const response = this.responses[this.calls.length - 1] ?? [];
    if (response instanceof Error) throw response;
    return {
      rows: [...(typeof response === "function" ? response(values) : response)],
    };
  }
  async runInTransaction<Value>(
    work: (executor: PostgresExecutor) => Promise<Value>,
  ): Promise<Value> {
    try {
      const result = await work(this);
      this.commits++;
      return result;
    } catch (error) {
      this.rollbacks++;
      throw error;
    }
  }
}

function turn(overrides: Record<string, unknown> = {}) {
  return {
    id: turnId,
    status: "PENDING",
    routing_resolution: resolution,
    resolved_food_day_id: null,
    materialized_food_day_id: null,
    execution_plan: null,
    ...overrides,
  };
}
function day(id = dayId, status: "OPEN" | "CLOSED" = "OPEN") {
  return toFoodDayRow(
    createFoodDay({
      id,
      status,
      calorieTarget: "685.1075",
      proteinTarget: "41.0025",
    }),
    {
      userId,
      completeness: "UNKNOWN",
      localDate: date,
      openedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  );
}
function operation(status: "PENDING" | "SUCCEEDED", result: unknown = null) {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    user_id: userId,
    operation_key: operationKey,
    request_fingerprint: fingerprint,
    status,
    result,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: status === "SUCCEEDED" ? timestamp : null,
  };
}
function result(foodDayId = dayId, source: "CREATED" | "EXISTING" = "CREATED") {
  return {
    schema: "account-turn-materialization-v1",
    kind: "FOOD_DAY_READY",
    turnId,
    localDate: date,
    foodDayId,
    source,
  };
}

describe("materializeAccountTurnFoodDay", () => {
  it("locks conversation then turn, rechecks date, snapshots exact targets, and atomically binds a new day", async () => {
    const runner = new Runner([
      [{ user_id: userId }],
      [turn()],
      [],
      [
        {
          user_id: userId,
          calorie_target: "685.1075",
          protein_target: "41.0025",
          version: 0,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      [operation("PENDING")],
      (values) => [day(values[0] as string)],
      [operation("SUCCEEDED", result())],
      [{ id: turnId }],
    ]);
    const ready = await materializeAccountTurnFoodDay(runner, input);
    expect(ready).toMatchObject({ kind: "FOOD_DAY_READY", source: "CREATED" });
    expect(runner).toMatchObject({ commits: 1, rollbacks: 0 });
    const sql = runner.calls.map((call) =>
      call.sql.replaceAll(/\s+/g, " ").trim(),
    );
    expect(sql[0]).toContain(
      "from public.conversations where user_id = $1 for update",
    );
    expect(sql[1]).toContain(
      "from public.conversation_turns where id = $1 and user_id = $2 for update",
    );
    expect(sql[2]).toContain("where user_id = $1 and local_date = $2::date");
    expect(sql[2]).toContain("limit 2 for share");
    expect(runner.calls[2]?.values).toEqual([userId, date]);
    expect(runner.calls[3]?.values).toEqual([userId]);
    expect(runner.calls[4]?.values[2]).toBe(operationKey);
    expect(runner.calls[4]?.values[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(sql[5]).toContain("insert into public.food_days");
    expect(runner.calls[5]?.values).toMatchObject([
      ready.kind === "FOOD_DAY_READY" ? ready.foodDayId : "",
      userId,
      "OPEN",
      "UNKNOWN",
      "685.1075",
      "41.0025",
      null,
      null,
      date,
      null,
    ]);
    expect(runner.calls[6]?.values[2]).toMatchObject({
      turnId,
      localDate: date,
      source: "CREATED",
    });
    expect(runner.calls[7]?.values).toEqual([
      turnId,
      userId,
      ready.kind === "FOOD_DAY_READY" ? ready.foodDayId : "",
    ]);
    expect(sql.join(" ")).not.toContain("active_food_day_id =");
    expect(sql.join(" ")).not.toContain("execution_plan =");
    expect(sql.join(" ")).not.toContain("status = 'COMPLETED'");
  });

  it("returns TARGETS_REQUIRED without a claim, day, or link", async () => {
    const runner = new Runner([[{ user_id: userId }], [turn()], [], []]);
    expect(await materializeAccountTurnFoodDay(runner, input)).toEqual({
      kind: "TARGETS_REQUIRED",
    });
    expect(runner.calls).toHaveLength(4);
    expect(runner.commits).toBe(1);
  });

  it("canonicalizes trusted UUID text before SQL and operation identity", async () => {
    const runner = new Runner([[{ user_id: userId }], [turn()], [], []]);
    expect(
      await materializeAccountTurnFoodDay(runner, {
        trustedUserId: userId.toUpperCase(),
        turnId: turnId.toUpperCase(),
      }),
    ).toEqual({ kind: "TARGETS_REQUIRED" });
    expect(runner.calls[0]?.values).toEqual([userId]);
    expect(runner.calls[1]?.values).toEqual([turnId, userId]);
  });

  it("binds a sole CLOSED day without reading defaults or creating a day", async () => {
    const runner = new Runner([
      [{ user_id: userId }],
      [turn()],
      [day(dayId, "CLOSED")],
      [operation("PENDING")],
      [operation("SUCCEEDED", result(dayId, "EXISTING"))],
      [{ id: turnId }],
    ]);
    expect(await materializeAccountTurnFoodDay(runner, input)).toEqual({
      kind: "FOOD_DAY_READY",
      foodDayId: dayId,
      source: "EXISTING",
    });
    expect(runner.calls).toHaveLength(6);
    expect(runner.calls.map((call) => call.sql).join(" ")).not.toContain(
      "account_nutrition_targets",
    );
    expect(runner.calls.map((call) => call.sql).join(" ")).not.toContain(
      "insert into public.food_days",
    );
  });

  it("returns ambiguity with two canonical same-date days and no writes", async () => {
    const runner = new Runner([
      [{ user_id: userId }],
      [turn()],
      [day(), day(otherDayId)],
    ]);
    expect(await materializeAccountTurnFoodDay(runner, input)).toEqual({
      kind: "AMBIGUOUS_EXISTING_DAYS",
    });
    expect(runner.calls).toHaveLength(3);
  });

  it.each([
    ["COMPLETED", resolution, "TURN_COMPLETED"],
    [
      "PENDING",
      { schema: "account-routing-resolution-v1", kind: "DAYLESS" },
      "ROUTING_NOT_DATE_TARGET",
    ],
    ["PENDING", null, "ROUTING_NOT_DATE_TARGET"],
  ])("rejects ineligible turn: %s / %j", async (status, routing, reason) => {
    const runner = new Runner([
      [{ user_id: userId }],
      [turn({ status, routing_resolution: routing })],
    ]);
    await expect(
      materializeAccountTurnFoodDay(runner, input),
    ).rejects.toMatchObject({
      name: "AccountTurnMaterializationIneligibleError",
      reason,
    });
    expect(runner.calls).toHaveLength(2);
    expect(runner.rollbacks).toBe(1);
  });

  it("rejects an unknown or cross-owner turn before any canonical write", async () => {
    const runner = new Runner([[{ user_id: userId }], []]);
    await expect(
      materializeAccountTurnFoodDay(runner, input),
    ).rejects.toBeInstanceOf(AccountTurnMaterializationIneligibleError);
    expect(runner.calls).toHaveLength(2);
  });

  it("does not materialize a pending turn whose execution plan already exists", async () => {
    const runner = new Runner([
      [{ user_id: userId }],
      [turn({ execution_plan: { schema: "account-turn-plan-v1", slots: [] } })],
    ]);
    await expect(
      materializeAccountTurnFoodDay(runner, input),
    ).rejects.toMatchObject({
      reason: "EXECUTION_PLAN_EXISTS",
    });
    expect(runner.calls).toHaveLength(2);
  });

  it("replays the durable target and original source without candidate or default reads", async () => {
    const replayedOperation = operation("SUCCEEDED", result());
    const runner = new Runner([
      [{ user_id: userId }],
      [turn({ materialized_food_day_id: dayId })],
      [replayedOperation],
      [day()],
    ]);
    expect(await materializeAccountTurnFoodDay(runner, input)).toEqual({
      kind: "FOOD_DAY_READY",
      foodDayId: dayId,
      source: "CREATED",
    });
    expect(runner.calls).toHaveLength(4);
    expect(runner.calls.map((call) => call.sql).join(" ")).not.toContain(
      "local_date = $2::date",
    );
    expect(runner.calls.map((call) => call.sql).join(" ")).not.toContain(
      "account_nutrition_targets",
    );
  });

  it("rejects malformed replay operation data instead of trusting JSONB", async () => {
    const runner = new Runner([
      [{ user_id: userId }],
      [turn({ materialized_food_day_id: dayId })],
      [],
    ]);
    await expect(
      materializeAccountTurnFoodDay(runner, input),
    ).rejects.toBeInstanceOf(AccountTurnMaterializationIntegrityError);
    expect(runner.calls).toHaveLength(3);
  });

  it.each([
    { ...result(), schema: "wrong-v2" },
    { ...result(), source: "OTHER" },
    { ...result(), foodDayId: "not-a-uuid" },
    { ...result(), foodDayId: otherDayId },
    { ...result(), turnId: otherDayId },
    { ...result(), extra: true },
  ])(
    "rejects an inconsistent completed operation result: %j",
    async (storedResult) => {
      const runner = new Runner([
        [{ user_id: userId }],
        [turn({ materialized_food_day_id: dayId })],
        [operation("SUCCEEDED", storedResult)],
      ]);
      await expect(
        materializeAccountTurnFoodDay(runner, input),
      ).rejects.toBeInstanceOf(AccountTurnMaterializationIntegrityError);
      expect(runner.calls).toHaveLength(3);
    },
  );

  it("rolls back a failed FoodDay insert and its reserved operation claim", async () => {
    const runner = new Runner([
      [{ user_id: userId }],
      [turn()],
      [],
      [
        {
          user_id: userId,
          calorie_target: "685.1075",
          protein_target: "41.0025",
          version: 0,
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      [operation("PENDING")],
      new Error("insert failed"),
    ]);
    await expect(materializeAccountTurnFoodDay(runner, input)).rejects.toThrow(
      "insert failed",
    );
    expect(runner).toMatchObject({ commits: 0, rollbacks: 1 });
    expect(runner.calls).toHaveLength(6);
  });
});
