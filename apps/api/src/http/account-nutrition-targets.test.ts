import type { PostgresExecutor } from "@cal-calc/persistence";
import {
  AccountNutritionTargetsVersionConflictError,
  SemanticOperationIdempotencyConflictError,
  SemanticOperationStateConflictError,
} from "@cal-calc/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "../auth/authorization.js";
import { setAccountNutritionTargetsMutation } from "../mutations/set-account-nutrition-targets.js";
import { getAccountNutritionTargets } from "../queries/get-account-nutrition-targets.js";
import { createApiApp } from "./app.js";

vi.mock(
  "../queries/get-account-nutrition-targets.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../queries/get-account-nutrition-targets.js")
    >()),
    getAccountNutritionTargets: vi.fn(),
  }),
);
vi.mock(
  "../mutations/set-account-nutrition-targets.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../mutations/set-account-nutrition-targets.js")
    >()),
    setAccountNutritionTargetsMutation: vi.fn(),
  }),
);

const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const timestamp = "2026-10-17T00:00:00Z";
const targetsA = {
  userId: userA,
  calorieTarget: "685.1075",
  proteinTarget: "41.0025",
  version: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const body = {
  retryKey: "target-write-1",
  expectedVersion: null,
  calorieTarget: "0685.107500",
  proteinTarget: "041.002500",
};
const publicConfigured = {
  status: "CONFIGURED",
  calorieTarget: "685.1075",
  proteinTarget: "41.0025",
  version: 0,
};
const getTargets = vi.mocked(getAccountNutritionTargets);
const setTargets = vi.mocked(setAccountNutritionTargetsMutation);
const apps: ReturnType<typeof createApiApp>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  getTargets.mockResolvedValue({ kind: "NOT_CONFIGURED" });
  setTargets.mockResolvedValue({ disposition: "APPLIED", targets: targetsA });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const authVerifier = {
    verifyAccessToken: vi.fn(async (token: string) => {
      if (token === "token-a") return { userId: userA };
      if (token === "token-b") return { userId: userB };
      throw new AuthenticationError("INVALID_ACCESS_TOKEN");
    }),
  };
  const postgres = {
    query: vi.fn<PostgresExecutor["query"]>(async () => {
      throw new Error("The HTTP adapter must not issue SQL.");
    }),
  };
  const transactionRunner = {
    async runInTransaction() {
      throw new Error("The HTTP adapter must not own a transaction.");
    },
  };
  const app = createApiApp({ authVerifier, postgres, transactionRunner });
  apps.push(app);
  return { app, authVerifier, postgres, transactionRunner };
}

function get(
  app: ReturnType<typeof createApiApp>,
  token: string | null = "token-a",
  url = "/v1/account/nutrition-targets",
) {
  return app.inject({
    method: "GET",
    url,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

function put(
  app: ReturnType<typeof createApiApp>,
  value: unknown = body,
  token: string | null = "token-a",
  url = "/v1/account/nutrition-targets",
) {
  return app.inject({
    method: "PUT",
    url,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    payload: JSON.stringify(value),
  });
}

describe("authenticated account nutrition target HTTP adapter", () => {
  it("GET represents absence explicitly without inventing zero defaults", async () => {
    const { app, authVerifier, postgres } = fixture();
    const response = await get(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "NOT_CONFIGURED" });
    expect(authVerifier.verifyAccessToken).toHaveBeenCalledExactlyOnceWith(
      "token-a",
    );
    expect(getTargets).toHaveBeenCalledExactlyOnceWith(
      { targets: expect.anything() },
      { trustedUserId: userA },
    );
    expect(setTargets).not.toHaveBeenCalled();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("GET projects exact configured strings and current version, not internal fields", async () => {
    const { app } = fixture();
    getTargets.mockResolvedValue({ kind: "CONFIGURED", targets: targetsA });
    const response = await get(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(publicConfigured);
    expect(response.body).not.toContain(userA);
    expect(response.body).not.toContain(timestamp);
  });

  it("GET uses verified account identity, never a query-supplied owner", async () => {
    const { app } = fixture();
    getTargets.mockImplementation(async (_dependencies, input) =>
      input.trustedUserId === userA
        ? { kind: "CONFIGURED", targets: targetsA }
        : { kind: "NOT_CONFIGURED" },
    );
    expect((await get(app, "token-a")).json()).toEqual(publicConfigured);
    expect((await get(app, "token-b")).json()).toEqual({
      status: "NOT_CONFIGURED",
    });
    expect(getTargets.mock.calls.map((call) => call[1].trustedUserId)).toEqual([
      userA,
      userB,
    ]);
    const injected = await get(
      app,
      "token-b",
      `/v1/account/nutrition-targets?userId=${userA}`,
    );
    expect(injected.statusCode).toBe(400);
    expect(getTargets).toHaveBeenCalledTimes(2);
  });

  it("PUT first configuration passes exact normalized decimals and trusted identity", async () => {
    const { app, transactionRunner, postgres } = fixture();
    const response = await put(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(publicConfigured);
    expect(setTargets).toHaveBeenCalledExactlyOnceWith(
      { transactionRunner },
      {
        trustedUserId: userA,
        idempotencyKey: "target-write-1",
        command: {
          expectedVersion: null,
          calorieTarget: "685.1075",
          proteinTarget: "41.0025",
        },
      },
    );
    expect(postgres.query).not.toHaveBeenCalled();
    expect(getTargets).not.toHaveBeenCalled();
    expect(response.body).not.toContain(userA);
    expect(response.body).not.toContain("operation");
  });

  it("PUT update forwards expected-version CAS and returns the canonical next version", async () => {
    const { app } = fixture();
    setTargets.mockResolvedValue({
      disposition: "APPLIED",
      targets: { ...targetsA, calorieTarget: "700.1", version: 1 },
    });
    const response = await put(app, {
      ...body,
      retryKey: "target-write-2",
      expectedVersion: 0,
      calorieTarget: "0700.100",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "CONFIGURED",
      calorieTarget: "700.1",
      proteinTarget: "41.0025",
      version: 1,
    });
    expect(setTargets.mock.calls[0]?.[1]).toMatchObject({
      trustedUserId: userA,
      idempotencyKey: "target-write-2",
      command: { expectedVersion: 0, calorieTarget: "700.1" },
    });
  });

  it("PUT durable replay projects the same saved value, even if current defaults later differ", async () => {
    const { app } = fixture();
    const first = await put(app);
    setTargets.mockResolvedValueOnce({
      disposition: "REPLAYED",
      targets: targetsA,
    });
    const replay = await put(app);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(setTargets.mock.calls[1]?.[1]).toEqual(
      setTargets.mock.calls[0]?.[1],
    );
  });

  it("exposes configuration after an explicit PUT without invoking FoodDay work", async () => {
    const { app, postgres } = fixture();
    let configured = false;
    getTargets.mockImplementation(async () =>
      configured
        ? { kind: "CONFIGURED", targets: targetsA }
        : { kind: "NOT_CONFIGURED" },
    );
    setTargets.mockImplementation(async () => {
      configured = true;
      return { disposition: "APPLIED", targets: targetsA };
    });
    expect((await get(app)).json()).toEqual({ status: "NOT_CONFIGURED" });
    expect((await put(app)).json()).toEqual(publicConfigured);
    expect((await get(app)).json()).toEqual(publicConfigured);
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("PUT owner identity remains independently scoped despite a reused retry key", async () => {
    const { app } = fixture();
    setTargets.mockImplementation(async (_dependencies, input) => ({
      disposition: "APPLIED",
      targets: {
        ...targetsA,
        userId: input.trustedUserId,
        calorieTarget: input.trustedUserId === userA ? "685.1075" : "900.1",
      },
    }));
    const first = await put(app, body, "token-a");
    const second = await put(app, body, "token-b");
    expect(first.json().calorieTarget).toBe("685.1075");
    expect(second.json().calorieTarget).toBe("900.1");
    expect(setTargets.mock.calls.map((call) => call[1].trustedUserId)).toEqual([
      userA,
      userB,
    ]);
  });

  it.each(["GET", "PUT"])(
    "%s authenticates before target handling",
    async (method) => {
      const { app, authVerifier } = fixture();
      const missing =
        method === "GET" ? await get(app, null) : await put(app, {}, null);
      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Authentication required." },
      });
      const invalid =
        method === "GET"
          ? await get(app, "invalid")
          : await put(app, body, "invalid");
      expect(invalid.statusCode).toBe(401);
      expect(getTargets).not.toHaveBeenCalled();
      expect(setTargets).not.toHaveBeenCalled();
      expect(authVerifier.verifyAccessToken).toHaveBeenCalledExactlyOnceWith(
        "invalid",
      );
    },
  );

  it.each([
    { ...body, userId: userB },
    { ...body, foodDayId: userB },
    { ...body, operationId: userB },
    { ...body, requestFingerprint: "injected" },
    { ...body, createdAt: timestamp },
    { ...body, updatedAt: timestamp },
    { ...body, version: 4 },
    { ...body, calorieTarget: 685.1075 },
    { ...body, proteinTarget: 41.0025 },
    { ...body, calorieTarget: "1e3" },
    { ...body, proteinTarget: "-1" },
    { ...body, expectedVersion: -1 },
    { ...body, expectedVersion: 0.5 },
    { ...body, expectedVersion: "0" },
    { retryKey: body.retryKey, calorieTarget: "1", proteinTarget: "1" },
  ])(
    "rejects invalid or authority-bearing PUT body %# before mutation",
    async (invalid) => {
      const { app } = fixture();
      const response = await put(app, invalid);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "INVALID_ACCOUNT_NUTRITION_TARGETS",
          message: "Invalid account nutrition targets request.",
        },
      });
      expect(setTargets).not.toHaveBeenCalled();
    },
  );

  it.each(["", "bad key", "x".repeat(129), 42, null])(
    "rejects invalid retry key %# before mutation",
    async (retryKey) => {
      const { app } = fixture();
      const response = await put(app, { ...body, retryKey });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_IDEMPOTENCY_KEY");
      expect(setTargets).not.toHaveBeenCalled();
    },
  );

  it("rejects query-side authority on PUT and oversized bodies before mutation", async () => {
    const { app } = fixture();
    const query = await put(
      app,
      body,
      "token-a",
      `/v1/account/nutrition-targets?userId=${userB}`,
    );
    expect(query.statusCode).toBe(400);
    const oversized = await put(app, {
      ...body,
      calorieTarget: "1".repeat(17_000),
    });
    expect(oversized.statusCode).toBe(413);
    expect(setTargets).not.toHaveBeenCalled();
  });

  it.each([
    [
      new AccountNutritionTargetsVersionConflictError(),
      "ACCOUNT_NUTRITION_TARGET_VERSION_CONFLICT",
    ],
    [
      new SemanticOperationIdempotencyConflictError("secret-key", "old", "new"),
      "IDEMPOTENCY_CONFLICT",
    ],
    [
      new SemanticOperationStateConflictError("secret-key", "PENDING"),
      "OPERATION_NOT_REPLAYABLE",
    ],
  ])(
    "maps typed PUT conflicts without leaking internals: %#",
    async (error, code) => {
      const { app } = fixture();
      setTargets.mockRejectedValueOnce(error);
      const response = await put(app);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(code);
      expect(response.body).not.toContain("secret-key");
      expect(response.body).not.toContain(error.message);
    },
  );

  it("sanitizes unexpected target failures on GET and PUT", async () => {
    const { app } = fixture();
    getTargets.mockRejectedValueOnce(new Error("secret SQL GET detail"));
    setTargets.mockRejectedValueOnce(new Error("secret SQL PUT detail"));
    const getResponse = await get(app);
    const putResponse = await put(app);
    for (const response of [getResponse, putResponse]) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          code: "INTERNAL_ERROR",
          message: "An internal error occurred.",
        },
      });
      expect(response.body).not.toContain("secret SQL");
    }
  });
});
