import { beforeEach, describe, expect, it, vi } from "vitest";

const { Pool } = vi.hoisted(() => ({
  Pool: vi.fn(
    class {
      connect = vi.fn();
      end = vi.fn(async () => {});
    },
  ),
}));
vi.mock("pg", () => ({ Pool }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("createPostgresRuntime", () => {
  it("does not construct a pool or open connections when the API module is imported", async () => {
    await import("../index.js");
    expect(Pool).not.toHaveBeenCalled();
  });

  it("constructs independent owned pools lazily and delegates shutdown to pool.end", async () => {
    const { createPostgresRuntime } = await import("./runtime.js");
    const config = { connectionString: "postgresql://unused.invalid/example" };
    const first = createPostgresRuntime(config);
    const second = createPostgresRuntime(config);

    expect(Pool).toHaveBeenCalledTimes(2);
    expect(Pool).toHaveBeenNthCalledWith(1, config);
    expect(Pool).toHaveBeenNthCalledWith(2, config);
    expect(first.pool).not.toBe(second.pool);
    expect(first.transactionRunner).not.toBe(second.transactionRunner);
    expect(first.pool.connect).not.toHaveBeenCalled();
    expect(second.pool.connect).not.toHaveBeenCalled();
    await first.close();
    expect(first.pool.end).toHaveBeenCalledTimes(1);
    expect(second.pool.end).not.toHaveBeenCalled();
    await second.close();
    expect(second.pool.end).toHaveBeenCalledTimes(1);
  });

  it.each(["", " \t\n"])(
    "rejects a blank connection string before constructing a pool: %j",
    async (connectionString) => {
      const { createPostgresRuntime } = await import("./runtime.js");

      expect(() => createPostgresRuntime({ connectionString })).toThrow(
        "PostgreSQL connectionString must not be blank.",
      );
      expect(Pool).not.toHaveBeenCalled();
    },
  );

  it("propagates pool shutdown failure", async () => {
    const { createPostgresRuntime } = await import("./runtime.js");
    const runtime = createPostgresRuntime({
      connectionString: "postgresql://unused.invalid/example",
    });
    const failure = new Error("Pool shutdown failed.");
    vi.mocked(runtime.pool.end).mockRejectedValueOnce(failure);

    await expect(runtime.close()).rejects.toBe(failure);
    expect(runtime.pool.end).toHaveBeenCalledTimes(1);
  });
});
