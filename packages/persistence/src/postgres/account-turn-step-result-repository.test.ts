import { describe, expect, it, vi } from "vitest";

import { PostgresAccountTurnStepResultRepository } from "./account-turn-step-result-repository.js";

const userId = "10000000-0000-4000-8000-000000000001";
const turnId = "20000000-0000-4000-8000-000000000001";
const result = {
  schema: "account-turn-step-result-v1",
  action: "LOG_FOOD",
  outcome: { entryId: "30000000-0000-4000-8000-000000000001", revision: 1 },
} as const;
const row = {
  turn_id: turnId,
  user_id: userId,
  ordinal: 0,
  result,
  created_at: "2026-10-20T00:00:00Z",
};

describe("account turn step result repository", () => {
  it("lists only owner-scoped rows in ordinal order", async () => {
    const query = vi.fn(async () => ({ rows: [row] }));
    const repository = new PostgresAccountTurnStepResultRepository({ query });
    expect(await repository.listForTurn(userId, turnId)).toEqual([
      {
        turnId,
        userId,
        ordinal: 0,
        result,
        createdAt: row.created_at,
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("order by ordinal asc"),
      [userId, turnId],
    );
  });

  it("uses insert-on-conflict and returns the first stored winner", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresAccountTurnStepResultRepository({ query });
    expect(
      await repository.setOnce({ userId, turnId, ordinal: 0, result }),
    ).toMatchObject({ result });
    expect(query.mock.calls[0]?.[0]).toContain(
      "on conflict (turn_id, ordinal) do nothing",
    );
    expect(query.mock.calls[1]?.[1]).toEqual([userId, turnId, 0]);
  });

  it("rejects malformed results and ordinals before SQL", async () => {
    const query = vi.fn();
    const repository = new PostgresAccountTurnStepResultRepository({ query });
    await expect(
      repository.setOnce({ userId, turnId, ordinal: 8, result }),
    ).rejects.toThrow(RangeError);
    await expect(
      repository.setOnce({
        userId,
        turnId,
        ordinal: 0,
        result: { ...result, action: "UNSUPPORTED" } as never,
      }),
    ).rejects.toThrow(TypeError);
    expect(query).not.toHaveBeenCalled();
  });
});
