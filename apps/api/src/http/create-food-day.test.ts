import {
  createFoodDayExactlyOnce,
  CreateFoodDayIntegrityError,
  SemanticOperationIdempotencyConflictError,
  SemanticOperationStateConflictError,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "../auth/authorization.js";
import { createApiApp } from "./app.js";

vi.mock("@cal-calc/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cal-calc/persistence")>()),
  createFoodDayExactlyOnce: vi.fn(),
}));
const workflow = vi.mocked(createFoodDayExactlyOnce);
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const payload = {
  calorieTarget: "2400.0",
  proteinTarget: "119.00",
  localDate: "2026-09-10",
  timezone: "UTC",
};
const headers = {
  authorization: "Bearer private-token",
  "idempotency-key": "private-retry",
};
const apps: ReturnType<typeof createApiApp>[] = [];
const timestamp = "2026-09-10T00:00:00Z";
const errorBody = (code: string, message: string) => ({
  error: { code, message },
});
const invalidKey = errorBody(
  "INVALID_IDEMPOTENCY_KEY",
  "A valid Idempotency-Key is required.",
);

beforeEach(() => {
  vi.clearAllMocks();
  workflow.mockImplementation(async (_runner, input) => ({
    disposition: "CREATED",
    foodDay: {
      foodDay: input.foodDay,
      userId: input.userId,
      completeness: input.completeness,
      localDate: input.localDate!,
      timezone: input.timezone!,
      openedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    operation: {
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
      status: "SUCCEEDED",
      result: {},
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    },
  }));
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const authVerifier = {
    verifyAccessToken: vi.fn(async () => ({ userId: userA })),
  };
  const postgres = { query: vi.fn(async () => ({ rows: [] })) };
  const transactionRunner: PostgresTransactionRunner = {
    async runInTransaction() {
      throw new Error("Workflow mock should intercept.");
    },
  };
  const app = createApiApp({ authVerifier, postgres, transactionRunner });
  apps.push(app);
  return { app, authVerifier, postgres, transactionRunner };
}

describe("POST /v1/food-days", () => {
  it("returns an explicit 201 DTO and binds only verified ownership", async () => {
    const { app, transactionRunner, postgres } = fixture();
    const response = await app.inject({
      method: "POST",
      url: `/v1/food-days?userId=${userB}`,
      headers: { ...headers, "x-user-id": userB },
      payload,
    });
    expect(response.statusCode).toBe(201);
    const sent = workflow.mock.calls[0]![1];
    expect(workflow.mock.calls[0]![0]).toBe(transactionRunner);
    expect(sent.userId).toBe(userA);
    expect(response.json()).toEqual({
      disposition: "CREATED",
      foodDay: {
        id: sent.foodDay.id,
        status: "OPEN",
        completeness: "UNKNOWN",
        calorieTarget: "2400",
        proteinTarget: "119",
        localDate: payload.localDate,
        timezone: "UTC",
        openedAt: timestamp,
        closedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    for (const secret of [
      userA,
      userB,
      sent.operationId,
      sent.operationKey,
      sent.requestFingerprint,
      "private-token",
      "private-retry",
    ])
      expect(response.body).not.toContain(secret);
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("returns 200 with the original authoritative day on a normalized retry", async () => {
    const { app } = fixture();
    const first = await app.inject({
      method: "POST",
      url: "/v1/food-days",
      headers,
      payload,
    });
    const stored = await workflow.mock.results[0]!.value;
    workflow.mockResolvedValueOnce({ ...stored, disposition: "REPLAYED" });
    const replay = await app.inject({
      method: "POST",
      url: "/v1/food-days",
      headers,
      payload: { ...payload, calorieTarget: "2400.00" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...first.json(), disposition: "REPLAYED" });
    expect(workflow.mock.calls[0]![1].requestFingerprint).toBe(
      workflow.mock.calls[1]![1].requestFingerprint,
    );
  });

  it("allows a distinct day on the same date with a new explicit retry token", async () => {
    const { app } = fixture();
    const a = await app.inject({
      method: "POST",
      url: "/v1/food-days",
      headers,
      payload,
    });
    const b = await app.inject({
      method: "POST",
      url: "/v1/food-days",
      headers: { ...headers, "idempotency-key": "another-retry" },
      payload,
    });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().foodDay.id).not.toBe(b.json().foodDay.id);
    expect(workflow.mock.calls[0]![1].operationKey).not.toBe(
      workflow.mock.calls[1]![1].operationKey,
    );
  });

  it("sanitizes the real idempotency conflict error as 409", async () => {
    const { app } = fixture();
    workflow.mockRejectedValueOnce(
      new SemanticOperationIdempotencyConflictError(
        "private-key",
        "private-old",
        "private-new",
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/food-days",
      headers,
      payload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(
      errorBody(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used for a different request.",
      ),
    );
    expect(response.body).not.toContain("private");
  });

  it.each(["PENDING", "FAILED"] as const)(
    "maps a known %s operation to a sanitized conflict",
    async (status) => {
      const { app } = fixture();
      workflow.mockRejectedValueOnce(
        new SemanticOperationStateConflictError("private-key", status),
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-days",
        headers,
        payload,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(
        errorBody(
          "OPERATION_NOT_REPLAYABLE",
          "This operation cannot currently be replayed.",
        ),
      );
    },
  );

  it.each([
    undefined,
    "",
    " bad",
    "bad ",
    "a,b",
    "bad\nkey",
    "x".repeat(129),
    ["a", "b"],
  ])("rejects missing/invalid/duplicate raw retry header (%#)", async (key) => {
    const { app, postgres } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/food-days",
      headers: {
        authorization: headers.authorization,
        ...(key === undefined ? {} : { "iDeMpOtEnCy-KeY": key }),
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(invalidKey);
    expect(workflow).not.toHaveBeenCalled();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("accepts header-name casing and leaves parsed/raw retry and auth headers untouched", async () => {
    const { app } = fixture();
    let before: unknown;
    let after: unknown;
    app.addHook("onRequest", async (request) => {
      before = {
        headers: { ...request.headers },
        raw: [...request.raw.rawHeaders],
      };
    });
    app.addHook("preSerialization", async (request, _reply, body) => {
      after = {
        headers: { ...request.headers },
        raw: [...request.raw.rawHeaders],
      };
      return body;
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/food-days",
      headers: {
        authorization: headers.authorization,
        "iDeMpOtEnCy-KeY": "Exact-Case",
      },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(before).toBeDefined();
    expect(after).toEqual(before);
    expect(response.body).not.toContain("Exact-Case");
  });

  it.each([
    null,
    [],
    "private-body",
    {},
    { ...payload, calorieTarget: 2400 },
    { ...payload, proteinTarget: "NaN" },
    { ...payload, userId: userB },
    { ...payload, operationKey: "private-key" },
    { ...payload, id: "private-id" },
    { ...payload, unknown: "private-body" },
  ])("rejects invalid or unknown command fields (%#)", async (body) => {
    const { app } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/food-days",
      headers: { ...headers, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(
      errorBody("INVALID_CREATE_FOOD_DAY", "Invalid FoodDay creation request."),
    );
    expect(workflow).not.toHaveBeenCalled();
  });

  it.each([
    [
      "application/json",
      '{"private-body":',
      400,
      "INVALID_REQUEST",
      "Invalid request.",
    ],
    ["application/json", "", 400, "INVALID_REQUEST", "Invalid request."],
    [
      "application/private",
      "private-body",
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Unsupported media type.",
    ],
    [
      "application/json",
      JSON.stringify({ value: "private-body".repeat(2000) }),
      413,
      "PAYLOAD_TOO_LARGE",
      "Request body is too large.",
    ],
  ] as const)(
    "sanitizes parser failure (%#)",
    async (type, body, status, code, message) => {
      const { app, authVerifier, postgres } = fixture();
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-days",
        headers: { ...headers, "content-type": type },
        payload: body,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual(errorBody(code, message));
      expect(response.body).not.toContain("private");
      expect(workflow).not.toHaveBeenCalled();
      expect(authVerifier.verifyAccessToken).not.toHaveBeenCalled();
      expect(postgres.query).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "rejects missing or verifier-rejected credentials (%#)",
    async (invalid) => {
      const { app, authVerifier } = fixture();
      if (invalid)
        authVerifier.verifyAccessToken.mockRejectedValueOnce(
          new AuthenticationError("INVALID_ACCESS_TOKEN"),
        );
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-days",
        headers: {
          "idempotency-key": "retry",
          ...(invalid ? { authorization: "Bearer tampered-token" } : {}),
        },
        payload,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(
        errorBody("UNAUTHENTICATED", "Authentication required."),
      );
      expect(workflow).not.toHaveBeenCalled();
    },
  );

  it.each([
    new Error("private-key private-token postgresql://secret SQL"),
    new CreateFoodDayIntegrityError(
      "private-key",
      "MALFORMED_OPERATION_RESULT",
    ),
    new CreateFoodDayIntegrityError(
      "private-key",
      "REFERENCED_FOOD_DAY_NOT_FOUND",
    ),
    new SemanticOperationStateConflictError("private-key", "SUCCEEDED"),
  ])(
    "keeps unknown/corrupt state failures as sanitized 500 (%#)",
    async (failure) => {
      const { app } = fixture();
      workflow.mockRejectedValueOnce(failure);
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-days",
        headers,
        payload,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(
        errorBody("INTERNAL_ERROR", "An internal error occurred."),
      );
    },
  );
});
