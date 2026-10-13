import { describe, expect, it } from "vitest";

import type { PostgresExecutor } from "./food-entry-repository.js";
import {
  ConversationVersionConflictError,
  PostgresConversationRepository,
} from "./conversation-repository.js";

const userId = "10000000-0000-4000-8000-000000000001";
const dayId = "20000000-0000-4000-8000-000000000001";
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

    const stale = new ScriptedExecutor([[], [row(1, dayId)]]);
    await expect(
      new PostgresConversationRepository(stale).compareAndSetActiveDay({
        userId,
        expectedVersion: 0,
        activeFoodDayId: null,
      }),
    ).rejects.toBeInstanceOf(ConversationVersionConflictError);
  });
});
