import { describe, expect, it } from "vitest";

import type { FoodDayTurnResultRow } from "../types.js";
import type { PostgresExecutor } from "./food-entry-repository.js";
import {
  FoodDayTurnIdempotencyConflictError,
  MAX_RECENT_COMPLETED_FOOD_DAY_TURNS,
  PostgresFoodDayTurnResultRepository,
} from "./food-day-turn-result-repository.js";

const id = "30000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
const otherUserId = "10000000-0000-4000-8000-000000000002";
const foodDayId = "20000000-0000-4000-8000-000000000001";
const otherFoodDayId = "20000000-0000-4000-8000-000000000002";
const turnKey = "calcalc:food-day-turn:v1:turn-hash";
const fingerprint = "request-fingerprint-a";
const userMessage = "  Exact accepted message.  ";
const timestamp = "2026-09-28T00:00:00.000Z";

interface QueryCall {
  readonly queryText: string;
  readonly values: readonly unknown[];
}

class ScriptedExecutor implements PostgresExecutor {
  readonly calls: QueryCall[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: readonly (readonly unknown[])[]) {}

  async query(queryText: string, values: unknown[] = []) {
    this.calls.push({ queryText, values });
    const rows = this.responses[this.responseIndex] ?? [];
    this.responseIndex += 1;
    return { rows: [...rows] };
  }
}

describe("PostgresFoodDayTurnResultRepository", () => {
  it("returns an ownership-scoped matching completed result", async () => {
    const row = turnRow();
    const executor = new ScriptedExecutor([[row]]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    await expect(repository.findCompleted(findInput())).resolves.toEqual(
      persistedTurn(row),
    );
    expect(normalizeSql(executor.calls[0]?.queryText)).toContain(
      "where user_id = $1 and turn_key = $2",
    );
    expect(executor.calls[0]?.values).toEqual([userId, turnKey]);
  });

  it("returns a miss without exposing another user's row", async () => {
    const executor = new ScriptedExecutor([[]]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    await expect(
      repository.findCompleted(findInput({ userId: otherUserId })),
    ).resolves.toBeNull();
    expect(executor.calls[0]?.values).toEqual([otherUserId, turnKey]);
  });

  it("rejects a matching turn key with changed request meaning", async () => {
    const executor = new ScriptedExecutor([[turnRow()]]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    await expect(
      repository.findCompleted(
        findInput({ requestFingerprint: "request-fingerprint-b" }),
      ),
    ).rejects.toBeInstanceOf(FoodDayTurnIdempotencyConflictError);
  });

  it("does not replay a matching key across FoodDays", async () => {
    const executor = new ScriptedExecutor([[turnRow()]]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    await expect(
      repository.findCompleted(findInput({ foodDayId: otherFoodDayId })),
    ).rejects.toBeInstanceOf(FoodDayTurnIdempotencyConflictError);
  });

  it("inserts the first completed result without mutable update semantics", async () => {
    const row = turnRow();
    const executor = new ScriptedExecutor([[row]]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    await expect(repository.saveCompleted(saveInput())).resolves.toEqual({
      disposition: "CREATED",
      turn: persistedTurn(row),
    });
    expect(normalizeSql(executor.calls[0]?.queryText)).toContain(
      "on conflict (user_id, turn_key) do nothing",
    );
    expect(normalizeSql(executor.calls[0]?.queryText)).not.toContain("update");
    expect(executor.calls[0]?.values).toEqual([
      id,
      userId,
      foodDayId,
      turnKey,
      fingerprint,
      userMessage,
      "First durable response.",
    ]);
  });

  it("returns the first persisted response after an identical insert race", async () => {
    const winner = turnRow({ response: "Winner response." });
    const executor = new ScriptedExecutor([[], [winner]]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    const saved = await repository.saveCompleted(
      saveInput({ response: "Losing response." }),
    );

    expect(saved).toEqual({
      disposition: "EXISTING",
      turn: persistedTurn(winner),
    });
    expect(saved.turn.response).toBe("Winner response.");
  });

  it("rejects a duplicate save with a changed fingerprint", async () => {
    const executor = new ScriptedExecutor([[], [turnRow()]]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    await expect(
      repository.saveCompleted(
        saveInput({ requestFingerprint: "request-fingerprint-b" }),
      ),
    ).rejects.toBeInstanceOf(FoodDayTurnIdempotencyConflictError);
  });

  it("rejects blank completed responses before SQL", async () => {
    const executor = new ScriptedExecutor([]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    await expect(
      repository.saveCompleted(saveInput({ response: "   " })),
    ).rejects.toThrow("Completed FoodDay turn response must not be blank.");
    expect(executor.calls).toEqual([]);
  });

  it("rejects blank user messages before SQL", async () => {
    const executor = new ScriptedExecutor([]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    await expect(
      repository.saveCompleted(saveInput({ userMessage: "   " })),
    ).rejects.toThrow("Completed FoodDay turn user message must not be blank.");
    expect(executor.calls).toEqual([]);
  });

  it("hydrates a null message only for a legacy row", async () => {
    const row = turnRow({ userMessage: null });
    const repository = new PostgresFoodDayTurnResultRepository(
      new ScriptedExecutor([[row]]),
    );

    await expect(repository.findCompleted(findInput())).resolves.toEqual(
      persistedTurn(row),
    );
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_RECENT_COMPLETED_FOOD_DAY_TURNS + 1,
  ])("rejects invalid recent transcript limit %s before SQL", async (limit) => {
    const executor = new ScriptedExecutor([]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    await expect(
      repository.listRecentCompletedForFoodDay({
        userId,
        foodDayId,
        limit,
      }),
    ).rejects.toThrow(
      `Recent completed FoodDay turn limit must be an integer from 1 to ${MAX_RECENT_COMPLETED_FOOD_DAY_TURNS}.`,
    );
    expect(executor.calls).toEqual([]);
  });

  it("selects the newest bounded owned transcript and returns it oldest to newest", async () => {
    const executor = new ScriptedExecutor([
      [
        {
          user_message: "  Newest exact message.  ",
          response: "Newest exact response.",
          id: "private-newest-id",
          request_fingerprint: "private-newest-fingerprint",
        },
        {
          user_message: "Older exact message.",
          response: "  Older exact response.  ",
          id: "private-older-id",
          request_fingerprint: "private-older-fingerprint",
        },
      ],
    ]);
    const repository = new PostgresFoodDayTurnResultRepository(executor);

    await expect(
      repository.listRecentCompletedForFoodDay({
        userId,
        foodDayId,
        limit: 2,
      }),
    ).resolves.toEqual([
      {
        userMessage: "Older exact message.",
        response: "  Older exact response.  ",
      },
      {
        userMessage: "  Newest exact message.  ",
        response: "Newest exact response.",
      },
    ]);

    expect(executor.calls[0]?.values).toEqual([userId, foodDayId, 2]);
    const sql = normalizeSql(executor.calls[0]?.queryText);
    expect(sql).toContain(
      "where user_id = $1 and food_day_id = $2 and user_message is not null",
    );
    expect(sql).toContain("order by created_at desc, id desc limit $3");
    expect(sql).not.toContain("request_fingerprint");
    expect(sql).not.toContain("turn_key");
  });
});

function findInput(
  overrides: Partial<{
    userId: string;
    foodDayId: string;
    turnKey: string;
    requestFingerprint: string;
  }> = {},
) {
  return {
    userId: overrides.userId ?? userId,
    foodDayId: overrides.foodDayId ?? foodDayId,
    turnKey: overrides.turnKey ?? turnKey,
    requestFingerprint: overrides.requestFingerprint ?? fingerprint,
  };
}

function saveInput(
  overrides: Partial<{
    requestFingerprint: string;
    userMessage: string;
    response: string;
  }> = {},
) {
  return {
    id,
    ...findInput(
      overrides.requestFingerprint === undefined
        ? {}
        : { requestFingerprint: overrides.requestFingerprint },
    ),
    userMessage: overrides.userMessage ?? userMessage,
    response: overrides.response ?? "First durable response.",
  };
}

function turnRow(
  overrides: Partial<{ userMessage: string | null; response: string }> = {},
): FoodDayTurnResultRow {
  return {
    id,
    user_id: userId,
    food_day_id: foodDayId,
    turn_key: turnKey,
    request_fingerprint: fingerprint,
    user_message:
      overrides.userMessage === undefined ? userMessage : overrides.userMessage,
    response: overrides.response ?? "First durable response.",
    created_at: timestamp,
  };
}

function persistedTurn(row: FoodDayTurnResultRow) {
  return {
    id: row.id,
    userId: row.user_id,
    foodDayId: row.food_day_id,
    turnKey: row.turn_key,
    requestFingerprint: row.request_fingerprint,
    userMessage: row.user_message,
    response: row.response,
    createdAt: row.created_at,
  };
}

function normalizeSql(queryText: string | undefined): string {
  return queryText?.replaceAll(/\s+/g, " ").trim() ?? "";
}
