import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  PostgresSemanticOperationRepository,
  SemanticOperationIdempotencyConflictError,
  type PostgresExecutor,
} from "@cal-calc/persistence";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  deriveMutationIdentity,
  MutationIdentityError,
  parseIdempotencyKey,
  type MutationIdentityInput,
  type SemanticValue,
} from "./mutation-identity.js";

const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const retry = "20000000-0000-4000-8000-000000000001";

function input(
  overrides: Partial<MutationIdentityInput> = {},
): MutationIdentityInput {
  return {
    trustedUserId: userA,
    action: "CREATE_FOOD_DAY",
    idempotencyKey: parseIdempotencyKey(retry),
    semanticPayload: { calorieTarget: "685.1075", proteinTarget: "41.0025" },
    ...overrides,
  };
}

function fingerprint(semanticPayload: SemanticValue): string {
  return deriveMutationIdentity(input({ semanticPayload })).requestFingerprint;
}

describe("application-owned mutation identity", () => {
  it("derives identical replay identity from separately constructed inputs", () => {
    expect(deriveMutationIdentity(input())).toEqual(
      deriveMutationIdentity(input()),
    );
  });

  it("binds v1, purpose, action and user in unambiguous hash material", () => {
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
    const derived = deriveMutationIdentity(input());
    expect(derived).toEqual({
      operationKey: `calcalc:v1:CREATE_FOOD_DAY:${hash([
        "calcalc:operation-key",
        "v1",
        "CREATE_FOOD_DAY",
        userA,
        retry,
      ])}`,
      requestFingerprint: hash([
        "calcalc:request-fingerprint",
        "v1",
        "CREATE_FOOD_DAY",
        userA,
        '{"calorieTarget":"685.1075","proteinTarget":"41.0025"}',
      ]),
    });
    expect(derived.operationKey).toMatch(
      /^calcalc:v1:CREATE_FOOD_DAY:[a-f0-9]{64}$/,
    );
    expect(derived.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(derived.operationKey.length).toBeLessThan(128);
    expect(derived.requestFingerprint).toHaveLength(64);
  });

  it("retains the same operation key but changes the fingerprint for changed meaning", () => {
    const first = deriveMutationIdentity(input());
    const changed = deriveMutationIdentity(
      input({ semanticPayload: { calorieTarget: "119" } }),
    );
    expect(changed.operationKey).toBe(first.operationKey);
    expect(changed.requestFingerprint).not.toBe(first.requestFingerprint);
  });

  it("represents new intent with a new retry key, independent of identical command content", () => {
    const first = deriveMutationIdentity(input());
    const second = deriveMutationIdentity(
      input({ idempotencyKey: parseIdempotencyKey("new-intent") }),
    );
    expect(second.operationKey).not.toBe(first.operationKey);
    expect(second.requestFingerprint).toBe(first.requestFingerprint);
  });

  it("binds both derived values to the trusted user", () => {
    const first = deriveMutationIdentity(input());
    const second = deriveMutationIdentity(input({ trustedUserId: userB }));
    expect(second.operationKey).not.toBe(first.operationKey);
    expect(second.requestFingerprint).not.toBe(first.requestFingerprint);
  });

  it("rejects arbitrary action namespaces at runtime without enlarging the vocabulary", () => {
    expect(() =>
      deriveMutationIdentity(
        input({ action: "private-action" as MutationIdentityInput["action"] }),
      ),
    ).toThrow("Unsupported mutation action.");
  });

  it("cannot take operation identity or ownership overrides from extra transport fields", () => {
    const extra = {
      ...input(),
      userId: userB,
      operationKey: "caller-key",
      fingerprint: "caller-fingerprint",
      requestFingerprint: "caller-fingerprint",
      version: "v999",
    };
    expect(deriveMutationIdentity(extra)).toEqual(
      deriveMutationIdentity(input()),
    );
  });

  it.each(["", " \t", null, undefined, 123])(
    "rejects unusable trusted identity (%#)",
    (value) => {
      expect(() =>
        deriveMutationIdentity(input({ trustedUserId: value as string })),
      ).toThrow("Invalid trusted user identity.");
    },
  );

  it("is invariant to object insertion order recursively", () => {
    expect(
      fingerprint({ b: { y: "2", x: "1" }, a: [{ d: false, c: null }] }),
    ).toBe(fingerprint({ a: [{ c: null, d: false }], b: { x: "1", y: "2" } }));
  });

  it("preserves array ordering", () => {
    expect(fingerprint({ values: ["a", "b"] })).not.toBe(
      fingerprint({ values: ["b", "a"] }),
    );
  });

  it("preserves exact decimal strings instead of performing domain normalization", () => {
    expect(
      new Set(
        ["119", "119.0", "119.00"].map((calorieTarget) =>
          fingerprint({ calorieTarget }),
        ),
      ).size,
    ).toBe(3);
    expect(
      fingerprint({ calorieTarget: "685.1075", proteinTarget: "41.0025" }),
    ).toBe(deriveMutationIdentity(input()).requestFingerprint);
  });

  it("preserves string/type distinctions and uses finite JSON number semantics", () => {
    const values = [null, false, true, 0, "0", "", " ", "é", "e\u0301", 0.1];
    expect(new Set(values.map(fingerprint)).size).toBe(values.length);
    expect(fingerprint(-0)).toBe(fingerprint(0));
    expect(fingerprint({ absent: null })).not.toBe(fingerprint({}));
  });

  it("supports null-prototype records, escaped keys and repeated non-cyclic references without mutation", () => {
    const record = Object.create(null) as Record<string, SemanticValue>;
    record.__proto__ = "literal-key";
    record['quote"'] = "line\nvalue";
    const ordinary = {
      ["__proto__"]: "literal-key",
      ['quote"']: "line\nvalue",
    };
    expect(fingerprint(record)).toBe(fingerprint(ordinary));
    const nested = Object.freeze({ calorieTarget: "119" });
    const repeated = Object.freeze([nested, nested]);
    expect(fingerprint(repeated)).toBe(
      fingerprint([{ calorieTarget: "119" }, { calorieTarget: "119" }]),
    );
  });

  it.each([
    undefined,
    { nested: undefined },
    [undefined],
    NaN,
    Infinity,
    -Infinity,
    new Date("2026-09-09T00:00:00Z"),
    new (class Command {})(),
    () => "secret-payload",
    Symbol("secret-payload"),
    1n,
    new Map(),
    new Set(),
    new String("secret-payload"),
    { [Symbol("secret-payload")]: "secret-payload" },
    Array(1),
    Object.assign([], { extra: "secret-payload" }),
    Object.defineProperty({}, "hidden", { value: "secret-payload" }),
  ])(
    "rejects unsupported semantic values with a sanitized error (%#)",
    (payload) => {
      expect(() => fingerprint(payload as SemanticValue)).toThrow(
        "Invalid semantic command representation.",
      );
    },
  );

  it("rejects cycles and accessors without executing getters/toJSON or retaining causes", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const getter = vi.fn(() => {
      throw new Error("secret-payload");
    });
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: getter,
    });
    const toJSON = vi.fn(() => "secret-payload");
    for (const value of [cyclic, accessor, { toJSON }]) {
      let caught: unknown;
      try {
        fingerprint(value as SemanticValue);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MutationIdentityError);
      expect(caught).toMatchObject({
        reason: "INVALID_SEMANTIC_PAYLOAD",
      });
      expect(caught).not.toHaveProperty("cause");
      expect(String(caught)).not.toContain("secret-payload");
    }
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("does not embed raw retry, user or command values in either output", () => {
    const result = deriveMutationIdentity(
      input({
        idempotencyKey: parseIdempotencyKey("private-retry-value"),
        semanticPayload: { label: "private-command-value" },
      }),
    );
    for (const output of Object.values(result)) {
      for (const raw of [userA, "private-retry-value", "private-command-value"])
        expect(output).not.toContain(raw);
    }
  });

  it("has only built-in hashing imports and no time, randomness, environment or IO references", () => {
    const source = readFileSync(
      new URL("./mutation-identity.ts", import.meta.url),
      "utf8",
    );
    const tree = ts.createSourceFile(
      "mutation-identity.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = tree.statements.filter(ts.isImportDeclaration);
    expect(imports.map((node) => node.getText(tree))).toEqual([
      'import { createHash } from "node:crypto";',
    ]);
    const forbidden = new Set([
      "Date",
      "Math",
      "process",
      "fetch",
      "require",
      "globalThis",
      "performance",
      "randomUUID",
      "randomBytes",
      "eval",
      "Function",
    ]);
    function inspect(node: ts.Node) {
      if (ts.isIdentifier(node)) expect(forbidden.has(node.text)).toBe(false);
      if (ts.isCallExpression(node))
        expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
      ts.forEachChild(node, inspect);
    }
    inspect(tree);
    // No executor, client, environment or clock dependency is supplied to derivation.
    expect(deriveMutationIdentity(input())).toEqual(
      deriveMutationIdentity(input()),
    );
  });
});

describe("opaque idempotency keys", () => {
  it.each(["a", retry, "A_z-9.~", "a".repeat(128)])(
    "accepts the exact supported value (%#)",
    (key) => {
      expect(parseIdempotencyKey(key)).toBe(key);
    },
  );

  it.each([
    "",
    " ",
    "\t",
    "private-key\r",
    "private-key\n",
    "private\0key",
    "private\x7fkey",
    "a".repeat(129),
    "é",
    "a/b",
    "a:b",
    " key",
    "key ",
    null,
    1,
  ])(
    "rejects invalid retry values without reflection or normalization (%#)",
    (key) => {
      let caught: unknown;
      try {
        parseIdempotencyKey(key);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MutationIdentityError);
      expect(caught).toMatchObject({
        message: "Invalid idempotency key.",
        reason: "INVALID_IDEMPOTENCY_KEY",
      });
      expect(caught).not.toHaveProperty("cause");
      expect(String(caught)).not.toContain("private");
    },
  );

  it("revalidates keys supplied through an unsafe cast", () => {
    expect(() =>
      deriveMutationIdentity(
        input({
          idempotencyKey: "bad key" as MutationIdentityInput["idempotencyKey"],
        }),
      ),
    ).toThrow("Invalid idempotency key.");
  });
});

describe("existing persistence compatibility without a database", () => {
  it("passes derived text to claim, recognizes a retry, and rejects changed meaning", async () => {
    const derived = deriveMutationIdentity(input());
    const operationId = "30000000-0000-4000-8000-000000000001";
    const row = {
      id: operationId,
      user_id: userA,
      operation_key: derived.operationKey,
      request_fingerprint: derived.requestFingerprint,
      status: "PENDING",
      result: null,
      error: null,
      created_at: "2026-09-09T00:00:00Z",
      updated_at: "2026-09-09T00:00:00Z",
      completed_at: null,
    };
    const query = vi
      .fn<PostgresExecutor["query"]>()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresSemanticOperationRepository({ query });
    const claimInput = { id: operationId, userId: userA, ...derived };
    expect((await repository.claim(claimInput)).disposition).toBe("CREATED");
    expect(query.mock.calls[0]?.[1]).toEqual([
      operationId,
      userA,
      derived.operationKey,
      derived.requestFingerprint,
    ]);
    expect((await repository.claim(claimInput)).disposition).toBe("EXISTING");
    const changed = deriveMutationIdentity(
      input({ semanticPayload: { calorieTarget: "119" } }),
    );
    await expect(
      repository.claim({ ...claimInput, ...changed }),
    ).rejects.toBeInstanceOf(SemanticOperationIdempotencyConflictError);
  });
});
