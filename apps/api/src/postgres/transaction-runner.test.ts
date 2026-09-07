import type { PostgresExecutor } from "@cal-calc/persistence";
import { describe, expect, it, vi } from "vitest";

import { PostgresPoolTransactionRunner } from "./transaction-runner.js";

function fixture(failures: Readonly<Record<string, Error>> = {}) {
  const events: string[] = [];
  const client = {
    query: vi.fn<PostgresExecutor["query"]>(async (sql) => {
      events.push(sql);
      const failure = failures[sql];
      if (failure !== undefined) throw failure;
      return { rows: [] };
    }),
    release: vi.fn((discard?: Error | boolean) => {
      events.push(discard ? "DISCARD" : "RELEASE");
    }),
  };
  const pool = {
    connect: vi.fn(async () => {
      events.push("CONNECT");
      return client;
    }),
    query: vi.fn(),
  };
  return {
    events,
    client,
    pool,
    runner: new PostgresPoolTransactionRunner(pool),
  };
}

describe("PostgresPoolTransactionRunner", () => {
  it("acquires once, uses the same client for BEGIN/work/COMMIT, and releases once", async () => {
    const { events, client, pool, runner } = fixture();
    const value = { completed: true };
    const work = vi.fn(async (executor: PostgresExecutor) => {
      expect(executor).toBe(client);
      await executor.query("WORK");
      return value;
    });

    expect(await runner.runInTransaction(work)).toBe(value);
    expect(events).toEqual(["CONNECT", "BEGIN", "WORK", "COMMIT", "RELEASE"]);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledExactlyOnceWith(client);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("rolls back callback failure and preserves the original error", async () => {
    const { events, client, pool, runner } = fixture();
    const failure = new Error("Work failed.");

    await expect(
      runner.runInTransaction(async (executor) => {
        expect(executor).toBe(client);
        await executor.query("WORK");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual(["CONNECT", "BEGIN", "WORK", "ROLLBACK", "RELEASE"]);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("discards after BEGIN failure without invoking work or assuming a transaction exists", async () => {
    const failure = new Error("BEGIN failed.");
    const { events, client, pool, runner } = fixture({ BEGIN: failure });
    const work = vi.fn(async () => "unused");

    await expect(runner.runInTransaction(work)).rejects.toBe(failure);
    expect(events).toEqual(["CONNECT", "BEGIN", "DISCARD"]);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("propagates COMMIT failure, attempts rollback, and discards even if cleanup succeeds", async () => {
    const failure = new Error("COMMIT outcome uncertain.");
    const { events, client, pool, runner } = fixture({ COMMIT: failure });

    await expect(
      runner.runInTransaction(async (executor) => {
        await executor.query("WORK");
        return "must not be returned";
      }),
    ).rejects.toBe(failure);
    expect(events).toEqual([
      "CONNECT",
      "BEGIN",
      "WORK",
      "COMMIT",
      "ROLLBACK",
      "DISCARD",
    ]);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(["work", "commit"] as const)(
    "exposes both %s and rollback failures and discards the client",
    async (phase) => {
      const failure = new Error("Original failure.");
      const rollbackFailure = new Error("ROLLBACK failed.");
      const { events, client, runner } = fixture({
        ROLLBACK: rollbackFailure,
        ...(phase === "commit" ? { COMMIT: failure } : {}),
      });
      const attempt = runner.runInTransaction(async () => {
        events.push("WORK");
        if (phase === "work") throw failure;
        return "must not be returned";
      });

      await expect(attempt).rejects.toBeInstanceOf(AggregateError);
      await expect(attempt).rejects.toMatchObject({
        cause: rollbackFailure,
        errors: [failure, rollbackFailure],
      });
      expect(events).toEqual([
        "CONNECT",
        "BEGIN",
        "WORK",
        ...(phase === "commit" ? ["COMMIT"] : []),
        "ROLLBACK",
        "DISCARD",
      ]);
      expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );

  it("propagates acquisition failure without invoking work or releasing an unacquired client", async () => {
    const { client, pool, runner } = fixture();
    const failure = new Error("Connect failed.");
    pool.connect.mockRejectedValueOnce(failure);
    const work = vi.fn(async () => "unused");

    await expect(runner.runInTransaction(work)).rejects.toBe(failure);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).not.toHaveBeenCalled();
  });

  it("acquires a client independently for each transaction attempt", async () => {
    const first = fixture();
    const second = fixture();
    const pool = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(first.client)
        .mockResolvedValueOnce(second.client),
    };
    const runner = new PostgresPoolTransactionRunner(pool);

    await runner.runInTransaction(async (executor) => {
      expect(executor).toBe(first.client);
    });
    await runner.runInTransaction(async (executor) => {
      expect(executor).toBe(second.client);
    });
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(first.client.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(second.client.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
