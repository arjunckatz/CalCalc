import { describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  InMemoryIdempotencyStore,
} from "../index.js";

describe("in-memory idempotency reference semantics", () => {
  it("executes a new operation once and replays the stored result for an exact retry", () => {
    const store = new InMemoryIdempotencyStore<{ readonly revision: number }>();
    let invocations = 0;

    const first = store.execute("operation-1", "entry-1:revision-1", () => {
      invocations += 1;
      return { revision: invocations };
    });
    const retry = store.execute("operation-1", "entry-1:revision-1", () => {
      invocations += 1;
      return { revision: invocations };
    });

    expect(first).toEqual({ result: { revision: 1 }, replayed: false });
    expect(retry).toEqual({ result: { revision: 1 }, replayed: true });
    expect(invocations).toBe(1);
  });

  it("rejects an operation-id collision without executing the new request", () => {
    const store = new InMemoryIdempotencyStore<string>();
    let invocations = 0;
    store.execute("operation-1", "fingerprint-a", () => {
      invocations += 1;
      return "first";
    });

    expect(() =>
      store.execute("operation-1", "fingerprint-b", () => {
        invocations += 1;
        return "second";
      }),
    ).toThrow(IdempotencyConflictError);
    expect(invocations).toBe(1);
  });
});
