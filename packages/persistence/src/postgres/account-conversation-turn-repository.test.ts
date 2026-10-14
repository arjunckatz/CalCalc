import { describe, expect, it } from "vitest";

import type { PostgresExecutor } from "./food-entry-repository.js";
import {
  AccountTurnIdempotencyConflictError,
  AccountTurnStateConflictError,
  PostgresAccountConversationTurnRepository,
} from "./account-conversation-turn-repository.js";

const userId = "10000000-0000-4000-8000-000000000001";
const id = "30000000-0000-4000-8000-000000000001";
const turnKey = "calcalc:account-turn:v1:hash";
const requestFingerprint = "fingerprint";
const timestamp = "2026-10-13T00:00:00.000Z";
const context = {
  schema: "client-calendar-v1" as const,
  currentLocalDate: "2026-10-13",
};
const plan = {
  schema: "account-turn-plan-v1" as const,
  slots: [
    { index: 0, action: "GET_BODY_WEIGHT_HISTORY" as const, command: {} },
  ],
};

class ScriptedExecutor implements PostgresExecutor {
  readonly calls: { sql: string; values: unknown[] }[] = [];
  constructor(private readonly results: readonly (readonly unknown[])[]) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: [...(this.results[this.calls.length - 1] ?? [])] };
  }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: userId,
    turn_key: turnKey,
    request_fingerprint: requestFingerprint,
    user_message: "  exact message  ",
    calendar_context: context,
    status: "PENDING",
    resolved_food_day_id: null,
    execution_plan: null,
    response: null,
    created_at: timestamp,
    completed_at: null,
    ...overrides,
  };
}

function key() {
  return { userId, turnKey, requestFingerprint };
}

describe("PostgresAccountConversationTurnRepository", () => {
  it("reads only bounded completed resolved target metadata in deterministic order", async () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      resolved_food_day_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      created_at: timestamp,
    }));
    const executor = new ScriptedExecutor([rows]);
    const result = await new PostgresAccountConversationTurnRepository(
      executor,
    ).listRecentResolvedTargets(userId);
    expect(result.items).toHaveLength(8);
    expect(result.hasMore).toBe(true);
    expect(result.items[0]).toEqual({
      turnId: rows[0]?.id,
      foodDayId: rows[0]?.resolved_food_day_id,
      createdAt: timestamp,
    });
    expect(executor.calls[0]?.sql.replaceAll(/\s+/g, " ")).toContain(
      "where user_id = $1 and status = 'COMPLETED' and resolved_food_day_id is not null order by created_at desc, id desc limit $2",
    );
    expect(executor.calls[0]?.values).toEqual([userId, 9]);
  });

  it("claims pending before future work and returns matching pending replay", async () => {
    const claim = {
      id,
      ...key(),
      userMessage: "  exact message  ",
      calendarContext: context,
    };
    const conversation = {
      user_id: userId,
      active_food_day_id: null,
      version: 0,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const inserted = new ScriptedExecutor([[], [conversation], [row()]]);
    const first = await new PostgresAccountConversationTurnRepository(
      inserted,
    ).claimPending(claim);
    expect(first).toMatchObject({
      disposition: "CREATED",
      turn: { status: "PENDING", response: null },
    });
    expect(inserted.calls[2]?.sql).toContain(
      "on conflict (user_id, turn_key) do nothing",
    );
    expect(inserted.calls[2]?.values[4]).toBe("  exact message  ");

    const existing = new ScriptedExecutor([[], [conversation], [], [row()]]);
    await expect(
      new PostgresAccountConversationTurnRepository(existing).claimPending(
        claim,
      ),
    ).resolves.toMatchObject({
      disposition: "EXISTING",
      turn: { status: "PENDING" },
    });
    const changed = new ScriptedExecutor([[], [conversation], [], [row()]]);
    await expect(
      new PostgresAccountConversationTurnRepository(changed).claimPending({
        ...claim,
        requestFingerprint: "different",
      }),
    ).rejects.toBeInstanceOf(AccountTurnIdempotencyConflictError);

    const inconsistent = new ScriptedExecutor([
      [],
      [conversation],
      [],
      [row()],
    ]);
    await expect(
      new PostgresAccountConversationTurnRepository(inconsistent).claimPending({
        ...claim,
        userMessage: "different exact message",
      }),
    ).rejects.toBeInstanceOf(AccountTurnIdempotencyConflictError);
  });

  it("sets a plan once, replays the same plan, and refuses replacement", async () => {
    const planned = row({ execution_plan: plan });
    const first = new ScriptedExecutor([[planned]]);
    await expect(
      new PostgresAccountConversationTurnRepository(first).setPlanOnce({
        ...key(),
        plan,
      }),
    ).resolves.toMatchObject({ executionPlan: plan });
    expect(first.calls[0]?.sql).toContain("execution_plan is null");

    const same = new ScriptedExecutor([[], [planned]]);
    await expect(
      new PostgresAccountConversationTurnRepository(same).setPlanOnce({
        ...key(),
        plan,
      }),
    ).resolves.toMatchObject({ executionPlan: plan });

    const different = new ScriptedExecutor([[], [planned]]);
    await expect(
      new PostgresAccountConversationTurnRepository(different).setPlanOnce({
        ...key(),
        plan: {
          schema: "account-turn-plan-v1",
          slots: [
            {
              index: 0,
              action: "SET_FOOD_DAY_COMPLETENESS",
              command: { targetCompleteness: "PARTIAL" },
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(AccountTurnStateConflictError);
  });

  it("completes once and returns the exact stored public response on replay", async () => {
    const completed = row({
      status: "COMPLETED",
      response: "  exact response  ",
      completed_at: timestamp,
    });
    const first = new ScriptedExecutor([[completed]]);
    await expect(
      new PostgresAccountConversationTurnRepository(first).markCompleted({
        ...key(),
        response: "  exact response  ",
      }),
    ).resolves.toMatchObject({
      disposition: "COMPLETED",
      turn: { response: "  exact response  " },
    });
    expect(first.calls[0]?.sql).not.toContain("completed_at =");

    const retry = new ScriptedExecutor([[], [completed]]);
    await expect(
      new PostgresAccountConversationTurnRepository(retry).markCompleted({
        ...key(),
        response: "different response",
      }),
    ).resolves.toMatchObject({
      disposition: "REPLAYED",
      turn: { response: "  exact response  " },
    });
  });

  it("selects owner-scoped completed rows only, newest eight then reverses presentation", async () => {
    const executor = new ScriptedExecutor([
      [
        { user_message: "newest", response: "  newest answer  " },
        { user_message: "  older  ", response: "older answer" },
      ],
    ]);
    await expect(
      new PostgresAccountConversationTurnRepository(
        executor,
      ).listRecentCompleted(userId),
    ).resolves.toEqual([
      { userMessage: "  older  ", response: "older answer" },
      { userMessage: "newest", response: "  newest answer  " },
    ]);
    expect(executor.calls[0]?.sql.replaceAll(/\s+/g, " ")).toContain(
      "where user_id = $1 and status = 'COMPLETED' order by created_at desc, id desc limit $2",
    );
    expect(executor.calls[0]?.values).toEqual([userId, 8]);
  });
});
