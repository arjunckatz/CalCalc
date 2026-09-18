import { describe, expect, it } from "vitest";

import {
  MutationIdentityError,
  parseIdempotencyKey,
  type IdempotencyKey,
} from "../../mutations/mutation-identity.js";
import { deriveFoodDayToolIdempotencyKey } from "./turn-idempotency.js";

const turnKey = parseIdempotencyKey("trusted-turn-key");

describe("deriveFoodDayToolIdempotencyKey", () => {
  it("derives the same child key for the same trusted turn and zero-based slot", () => {
    expect(deriveFoodDayToolIdempotencyKey(turnKey, 0)).toBe(
      deriveFoodDayToolIdempotencyKey(turnKey, 0),
    );
  });

  it("keeps its versioned SHA-256 framing stable", () => {
    expect(deriveFoodDayToolIdempotencyKey(turnKey, 0)).toBe(
      "turn-tool-v1-9271f61905d18d041506450f79dcedd4c469ee0d5e55653717512d597504f0aa",
    );
  });

  it("derives different child keys for different slots", () => {
    expect(deriveFoodDayToolIdempotencyKey(turnKey, 0)).not.toBe(
      deriveFoodDayToolIdempotencyKey(turnKey, 1),
    );
  });

  it("derives different child keys for different trusted turn keys", () => {
    expect(deriveFoodDayToolIdempotencyKey(turnKey, 0)).not.toBe(
      deriveFoodDayToolIdempotencyKey(parseIdempotencyKey("another-turn"), 0),
    );
  });

  it("returns a canonical key even for a maximum-length trusted turn key", () => {
    const child = deriveFoodDayToolIdempotencyKey(
      parseIdempotencyKey("x".repeat(128)),
      Number.MAX_SAFE_INTEGER,
    );

    expect(parseIdempotencyKey(child)).toBe(child);
    expect(child.length).toBeLessThanOrEqual(128);
  });

  it("does not incorporate model-generated semantic arguments", () => {
    const firstModelArguments = { quantity: "1" };
    const retriedModelArguments = { quantity: "2" };

    // Both attempts target the same trusted slot. The mutation fingerprint,
    // not this key, must detect changed arguments on retry.
    expect(firstModelArguments).not.toEqual(retriedModelArguments);
    expect(deriveFoodDayToolIdempotencyKey(turnKey, 0)).toBe(
      deriveFoodDayToolIdempotencyKey(turnKey, 0),
    );
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects an invalid tool index %s",
    (toolIndex) => {
      expect(() => deriveFoodDayToolIdempotencyKey(turnKey, toolIndex)).toThrow(
        RangeError,
      );
    },
  );

  it("revalidates the trusted root key at runtime", () => {
    expect(() =>
      deriveFoodDayToolIdempotencyKey("bad key" as IdempotencyKey, 0),
    ).toThrow(MutationIdentityError);
  });
});
