import { describe, expect, it } from "vitest";

import type { PostgresExecutor } from "./food-entry-repository.js";
import {
  ConversationVersionConflictError,
  PostgresConversationRepository,
} from "./conversation-repository.js";

const userId = "10000000-0000-4000-8000-000000000001";
const dayId = "20000000-0000-4000-8000-000000000001";
const turnId = "30000000-0000-4000-8000-000000000001";
const timestamp = "2026-10-13T00:00:00.000Z";

class ScriptedExecutor implements PostgresExecutor {
  readonly calls: { sql: string; values: unknown[] }[] = [];
  constructor(private readonly results: readonly (readonly unknown[])[]) {}
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: [...(this.results[this.calls.length - 1] ?? [])] };
  }
}

function row(version = 0, activeFoodDayId: string | null = null) {
  return {
    user_id: userId,
    active_food_day_id: activeFoodDayId,
    active_food_day_turn_id: null,
    version,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("PostgresConversationRepository", () => {
  it("creates or reads one nullable owner conversation", async () => {
    const executor = new ScriptedExecutor([[], [row()]]);
    const repository = new PostgresConversationRepository(executor);
    await expect(repository.getOrCreate(userId)).resolves.toMatchObject({
      userId,
      activeFoodDayId: null,
      version: 0,
    });
    expect(executor.calls[0]?.sql).toContain(
      "on conflict (user_id) do nothing",
    );
    expect(executor.calls[1]?.values).toEqual([userId]);
  });

  it("uses owner+expected-version CAS and rejects stale versions", async () => {
    const successful = new ScriptedExecutor([[row(1, dayId)]]);
    await expect(
      new PostgresConversationRepository(successful).compareAndSetActiveDay({
        userId,
        expectedVersion: 0,
        activeFoodDayId: dayId,
      }),
    ).resolves.toMatchObject({ version: 1, activeFoodDayId: dayId });
    expect(successful.calls[0]?.sql.replaceAll(/\s+/g, " ")).toContain(
      "where user_id = $1 and version = $2",
    );
    expect(successful.calls[0]?.values).toEqual([userId, 0, dayId]);
    expect(successful.calls[0]?.sql).toContain(
      "active_food_day_turn_id = null",
    );

    const stale = new ScriptedExecutor([[], [row(1, dayId)]]);
    await expect(
      new PostgresConversationRepository(stale).compareAndSetActiveDay({
        userId,
        expectedVersion: 0,
        activeFoodDayId: null,
      }),
    ).rejects.toBeInstanceOf(ConversationVersionConflictError);
  });

  it("advances only from a completed owner turn with a durable food effect and newer source", async () => {
    const executor = new ScriptedExecutor([
      [{ ...row(2, dayId), active_food_day_turn_id: turnId }],
    ]);
    const repository = new PostgresConversationRepository(executor);
    await expect(
      repository.advanceActiveFoodDayFromCompletedTurn({ userId, turnId }),
    ).resolves.toMatchObject({
      activeFoodDayId: dayId,
      activeFoodDayTurnId: turnId,
      version: 2,
    });
    const sql = executor.calls[0]!.sql.replaceAll(/\s+/g, " ");
    expect(sql).toContain("t.status = 'COMPLETED'");
    expect(sql).toContain("from public.account_turn_step_results r");
    expect(sql).toContain("(t.created_at, t.id) >");
    expect(sql).toContain("version = c.version + 1");
    expect(executor.calls[0]?.values).toEqual([userId, turnId]);

    const older = new PostgresConversationRepository(
      new ScriptedExecutor([[]]),
    );
    await expect(
      older.advanceActiveFoodDayFromCompletedTurn({ userId, turnId }),
    ).resolves.toBeNull();
  });
});
