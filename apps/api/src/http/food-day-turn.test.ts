import {
  FoodDayNotFoundError,
  FoodDayTurnIdempotencyConflictError,
  SemanticOperationIdempotencyConflictError,
  SemanticOperationStateConflictError,
  type PostgresExecutor,
} from "@cal-calc/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAIFoodDayModelProtocolError } from "../agent/providers/openai/openai-food-day-turn-model.js";
import type { FoodDayTurnRunner } from "../agent/turn/create-food-day-turn-runner.js";
import type { FoodDayTurnResult } from "../agent/turn/food-day-turn-types.js";
import { FoodDayTurnValidationError } from "../agent/turn/run-food-day-turn.js";
import { createApiApp } from "./app.js";

const userId = "10000000-0000-4000-8000-000000000001";
const foodDayId = "20000000-0000-4000-8000-000000000001";
const headers = {
  authorization: "Bearer user-token",
  "idempotency-key": "turn-retry-1",
};
const publicResponse = { response: "Your confirmed total is 150 calories." };
const apps: ReturnType<typeof createApiApp>[] = [];
const runTurn = vi.fn<FoodDayTurnRunner>();

beforeEach(() => {
  runTurn.mockReset();
  runTurn.mockResolvedValue(turnResult(publicResponse.response));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function turnResult(response: string): FoodDayTurnResult {
  return {
    response,
    state: {
      foodDay: {
        id: foodDayId,
        localDate: "2026-09-28",
        status: "OPEN",
        completeness: "PARTIAL",
        targets: { calories: "2100", protein: "120" },
      },
      totals: {
        confirmed: {
          calories: "150",
          protein: "8",
          hasUnknownProtein: false,
        },
      },
      targetProgress: {
        calories: { remainingToTarget: "1950", overTargetBy: "0" },
        protein: { remainingToTarget: "112", overTargetBy: "0" },
      },
      entries: [],
    },
    toolResults: [],
  };
}

function fixture() {
  const authVerifier = {
    verifyAccessToken: vi.fn(async () => ({ userId })),
  };
  const postgres = {
    query: vi.fn<PostgresExecutor["query"]>(async () => {
      throw new Error(
        "Turn HTTP unit test must not query persistence directly.",
      );
    }),
  };
  const app = createApiApp({
    authVerifier,
    postgres,
    transactionRunner: {
      async runInTransaction() {
        throw new Error("Turn HTTP unit test must not open a transaction.");
      },
    },
    foodDayTurn: runTurn,
  });
  apps.push(app);
  return { app, authVerifier, postgres };
}

function post(
  app: ReturnType<typeof createApiApp>,
  options: {
    readonly body?: unknown;
    readonly requestHeaders?: Record<string, string | string[]>;
    readonly id?: string;
  } = {},
) {
  const payload = Object.prototype.hasOwnProperty.call(options, "body")
    ? options.body
    : { message: "How am I doing?" };
  return app.inject({
    method: "POST",
    url: `/v1/food-days/${options.id ?? foodDayId}/turns?userId=attacker`,
    headers: {
      "content-type": "application/json",
      ...(options.requestHeaders ?? headers),
    },
    payload: JSON.stringify(payload),
  });
}

describe("POST /v1/food-days/:foodDayId/turns", () => {
  it("passes only trusted identity, validated scope, retry key, and the unchanged message", async () => {
    const { app, authVerifier, postgres } = fixture();
    const message = "  Please summarize my day exactly as written.  ";
    const response = await post(app, {
      body: { message },
      requestHeaders: { ...headers, "x-user-id": "attacker" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(publicResponse);
    expect(authVerifier.verifyAccessToken).toHaveBeenCalledExactlyOnceWith(
      "user-token",
    );
    expect(runTurn).toHaveBeenCalledExactlyOnceWith({
      trustedUserId: userId,
      foodDayId,
      turnIdempotencyKey: "turn-retry-1",
      userMessage: message,
    });
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("passes an accepted client calendar date separately from FoodDay state", async () => {
    const { app } = fixture();
    const response = await post(app, {
      body: {
        message: "I weighed 80 kg today.",
        currentLocalDate: "2026-10-06",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(runTurn).toHaveBeenCalledExactlyOnceWith({
      trustedUserId: userId,
      foodDayId,
      turnIdempotencyKey: "turn-retry-1",
      userMessage: "I weighed 80 kg today.",
      calendarContext: { currentLocalDate: "2026-10-06" },
    });
  });

  it.each([
    "2026-2-05",
    "2026-02-5",
    "2026-02-30",
    "2026-13-01",
    "2026-00-01",
    " 2026-10-06",
    "2026-10-06 ",
    "2026-10-06T00:00:00Z",
    null,
    20261006,
  ])(
    "rejects malformed currentLocalDate %j before agent execution",
    async (date) => {
      const { app } = fixture();
      const response = await post(app, {
        body: { message: "I weighed 80 kg today.", currentLocalDate: date },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "INVALID_FOOD_DAY_TURN",
          message: "Invalid FoodDay turn request.",
        },
      });
      expect(runTurn).not.toHaveBeenCalled();
    },
  );

  it("projects a tool-based turn to response only", async () => {
    const { app } = fixture();
    runTurn.mockResolvedValueOnce({
      ...turnResult("Logged the yogurt."),
      toolResults: [
        {
          name: "LOG_FOOD",
          result: {
            disposition: "CREATED",
            entry: { id: "private-entry", revision: 1 },
          },
        },
      ],
      providerResponseId: "private-provider-id",
      operationKey: "private-operation-key",
    } as unknown as FoodDayTurnResult);

    const response = await post(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ response: "Logged the yogurt." });
    for (const internal of [
      "state",
      "toolResults",
      "private-entry",
      "private-provider-id",
      "private-operation-key",
    ]) {
      expect(response.body).not.toContain(internal);
    }
  });

  it("requires authentication before structural request handling", async () => {
    const { app, authVerifier } = fixture();
    const response = await post(app, {
      body: { message: "", userId: "attacker" },
      requestHeaders: { "idempotency-key": "turn-retry-1" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required." },
    });
    expect(authVerifier.verifyAccessToken).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("authenticates before checking malformed calendar context", async () => {
    const { app, authVerifier } = fixture();
    const response = await post(app, {
      body: { message: "Today", currentLocalDate: "2026-02-30" },
      requestHeaders: { "idempotency-key": "turn-retry-1" },
    });
    expect(response.statusCode).toBe(401);
    expect(authVerifier.verifyAccessToken).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { message: "" },
    { message: "   " },
    { message: 42 },
    { message: "hello", userId: userId },
    { message: "hello", operationKey: "private" },
    null,
    [],
  ])(
    "rejects an invalid strict body without invoking the turn (%#)",
    async (body) => {
      const { app } = fixture();
      const response = await post(app, { body });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "INVALID_FOOD_DAY_TURN",
          message: "Invalid FoodDay turn request.",
        },
      });
      expect(runTurn).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed FoodDay ID after authentication", async () => {
    const { app, authVerifier } = fixture();
    const response = await post(app, { id: "not-a-uuid" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_FOOD_DAY_ID",
        message: "Food day ID must be a UUID.",
      },
    });
    expect(authVerifier.verifyAccessToken).toHaveBeenCalledTimes(1);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it.each([undefined, "invalid key", ""])(
    "rejects missing or invalid idempotency key %#",
    async (key) => {
      const { app } = fixture();
      const response = await post(app, {
        requestHeaders: {
          authorization: "Bearer user-token",
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "A valid Idempotency-Key is required.",
        },
      });
      expect(runTurn).not.toHaveBeenCalled();
    },
  );

  it("rejects physically duplicated idempotency headers", async () => {
    const { app } = fixture();
    const response = await post(app, {
      requestHeaders: {
        authorization: "Bearer user-token",
        "idempotency-key": ["private-key-a", "private-key-b"],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "A valid Idempotency-Key is required.",
      },
    });
    expect(response.body).not.toContain("private-key");
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("maps missing and cross-user FoodDays to ownership-safe not found", async () => {
    const { app } = fixture();
    runTurn.mockRejectedValueOnce(new FoodDayNotFoundError(foodDayId));
    const response = await post(app);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Resource not found." },
    });
    expect(response.body).not.toContain(foodDayId);
  });

  it.each([
    new SemanticOperationIdempotencyConflictError(
      "private-operation",
      "old-fingerprint",
      "new-fingerprint",
    ),
    new SemanticOperationStateConflictError("private-operation", "PENDING"),
    new FoodDayTurnIdempotencyConflictError(
      "private-turn-key",
      "old-fingerprint",
      "new-fingerprint",
    ),
  ])("reuses existing sanitized conflict mapping (%#)", async (failure) => {
    const { app } = fixture();
    runTurn.mockRejectedValueOnce(failure);
    const response = await post(app);
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("private-operation");
    expect(response.body).not.toContain("private-turn-key");
    expect(response.body).not.toContain("fingerprint");
  });

  it.each([
    new OpenAIFoodDayModelProtocolError("INVALID_RESPONSE"),
    new FoodDayTurnValidationError("INVALID_MODEL_DECISION"),
    new FoodDayTurnValidationError("INVALID_FINAL_TEXT"),
  ])("sanitizes model protocol failure as 502 (%#)", async (failure) => {
    const { app } = fixture();
    runTurn.mockRejectedValueOnce(failure);
    const response = await post(app);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: "MODEL_PROVIDER_ERROR",
        message: "The conversational model could not complete the request.",
      },
    });
    expect(response.body).not.toContain(failure.message);
  });

  it("sanitizes unexpected provider failures without exposing request details", async () => {
    const { app } = fixture();
    runTurn.mockRejectedValueOnce(
      new Error("Bearer private-token openai-request-id private-retry-key"),
    );
    const response = await post(app);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred.",
      },
    });
    for (const secret of [
      "private-token",
      "openai-request-id",
      "private-retry-key",
    ]) {
      expect(response.body).not.toContain(secret);
    }
  });
});
