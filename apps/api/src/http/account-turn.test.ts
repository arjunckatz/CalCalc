import type { PostgresExecutor } from "@cal-calc/persistence";
import {
  AccountTurnIdempotencyConflictError,
  AccountTurnStateConflictError,
} from "@cal-calc/persistence";
import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActiveFoodDayPointerIntegrityError } from "../conversation/advance-active-food-day-from-completed-turn.js";
import { acceptCalendarContext } from "../conversation/calendar-context.js";
import type { DurableAccountConversationTurnRunner } from "../conversation/create-durable-account-conversation-turn-runner.js";
import { OpenAIFoodDayTargetModelError } from "../conversation/providers/openai/openai-food-day-target-model.js";
import { createApiApp } from "./app.js";

const userId = "10000000-0000-4000-8000-000000000001";
const calendar = {
  currentLocalDateTime: "2026-10-27T12:34:56+05:30",
  timeZone: "Asia/Kolkata",
};
const headers = {
  authorization: "Bearer user-token",
  "content-type": "application/json",
};
const apps: ReturnType<typeof createApiApp>[] = [];
const runTurn = vi.fn<DurableAccountConversationTurnRunner>();

beforeEach(() => {
  runTurn.mockReset();
  runTurn.mockResolvedValue({
    kind: "COMPLETED",
    response: "  Exact answer.  ",
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const authVerifier = {
    verifyAccessToken: vi.fn(async () => ({ userId })),
  };
  const postgres = {
    query: vi.fn<PostgresExecutor["query"]>(async () => {
      throw new Error("HTTP adapter must not query PostgreSQL directly.");
    }),
  };
  const app = createApiApp({
    authVerifier,
    postgres,
    transactionRunner: {
      async runInTransaction() {
        throw new Error("HTTP adapter must not own a transaction.");
      },
    },
    accountTurn: runTurn,
  });
  apps.push(app);
  return { app, authVerifier, postgres };
}

function post(
  app: ReturnType<typeof createApiApp>,
  body: unknown = { message: "How am I doing?", retryKey: "retry-1" },
  requestHeaders: Record<string, string> = headers,
) {
  return app.inject({
    method: "POST",
    url: "/v1/turns?userId=attacker",
    headers: requestHeaders,
    payload: JSON.stringify(body),
  });
}

describe("POST /v1/turns", () => {
  it("authenticates, accepts the existing calendar snapshot, and returns exact completed text", async () => {
    const { app, authVerifier, postgres } = fixture();
    const message = "  How am I doing?  ";
    const response = await post(app, {
      message,
      retryKey: "retry-1",
      calendar,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "COMPLETED",
      response: "  Exact answer.  ",
    });
    expect(authVerifier.verifyAccessToken).toHaveBeenCalledExactlyOnceWith(
      "user-token",
    );
    expect(runTurn).toHaveBeenCalledExactlyOnceWith({
      trustedUserId: userId,
      idempotencyKey: "retry-1",
      userMessage: message,
      calendarContext: acceptCalendarContext(calendar),
    });
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("passes the same exact request on retry without changing a stored response", async () => {
    const { app } = fixture();
    const first = await post(app);
    const retry = await post(app);
    expect(first.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[1]).toEqual(runTurn.mock.calls[0]);
  });

  it("normalizes equivalent accepted calendar spellings before the runner", async () => {
    const { app } = fixture();
    const first = await post(app, {
      message: "hi",
      retryKey: "retry-1",
      calendar,
    });
    const second = await post(app, {
      message: "hi",
      retryKey: "retry-1",
      calendar: {
        ...calendar,
        currentLocalDateTime: "2026-10-27t12:34:56.000+05:30",
      },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(runTurn.mock.calls[1]).toEqual(runTurn.mock.calls[0]);
  });

  it.each([undefined, null])(
    "accepts optional calendar %# as null",
    async (value) => {
      const { app } = fixture();
      const body = {
        message: "hi",
        retryKey: "retry-1",
        ...(value === null ? { calendar: null } : {}),
      };
      const response = await post(app, body);
      expect(response.statusCode).toBe(200);
      expect(runTurn).toHaveBeenCalledExactlyOnceWith({
        trustedUserId: userId,
        idempotencyKey: "retry-1",
        userMessage: "hi",
        calendarContext: null,
      });
    },
  );

  it("authenticates before parsing even a malformed body", async () => {
    const { app } = fixture();
    const response = await post(
      app,
      { userId: "attacker" },
      {
        "content-type": "application/json",
      },
    );
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Authentication required." },
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { retryKey: "retry-1" },
    { message: "hi" },
    { message: "", retryKey: "retry-1" },
    { message: 42, retryKey: "retry-1" },
    { message: "hi", retryKey: "retry-1", userId },
    { message: "hi", retryKey: "retry-1", foodDayId: userId },
    { message: "hi", retryKey: "retry-1", entryId: userId },
    { message: "hi", retryKey: "retry-1", activeFoodDayId: userId },
    { message: "hi", retryKey: "retry-1", expectedVersion: 1 },
  ])(
    "rejects malformed or authority-bearing request shape %#",
    async (body) => {
      const { app } = fixture();
      const response = await post(app, body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          code: "INVALID_ACCOUNT_TURN",
          message: "Invalid account turn request.",
        },
      });
      expect(runTurn).not.toHaveBeenCalled();
    },
  );

  it.each([null, "", "bad key", 42, "x".repeat(129)])(
    "rejects invalid retry identity %#",
    async (retryKey) => {
      const { app } = fixture();
      const response = await post(app, { message: "hi", retryKey });
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

  it.each([
    { currentLocalDateTime: "2026-10-27T12:34:56+05:30", timeZone: "Bad/Zone" },
    {
      currentLocalDateTime: "2026-10-27T12:34:56+00:00",
      timeZone: "Asia/Kolkata",
    },
    { currentLocalDateTime: "2026-10-27", timeZone: "Asia/Kolkata" },
    {
      currentLocalDateTime: "2026-10-27T12:34:56+05:30",
      timeZone: "Asia/Kolkata",
      userId,
    },
  ])("rejects invalid calendar context %#", async (invalidCalendar) => {
    const { app } = fixture();
    const response = await post(app, {
      message: "hi",
      retryKey: "retry-1",
      calendar: invalidCalendar,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_ACCOUNT_TURN",
        message: "Invalid account turn request.",
      },
    });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("bounds the request body like the legacy conversational route", async () => {
    const { app } = fixture();
    const response = await post(app, {
      message: "x".repeat(17_000),
      retryKey: "retry-1",
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(runTurn).not.toHaveBeenCalled();
  });

  it.each([
    [
      { kind: "TARGETS_REQUIRED", localDate: "2026-10-27" },
      "ACCOUNT_NUTRITION_TARGETS_REQUIRED",
    ],
    [
      { kind: "AMBIGUOUS_EXISTING_DAYS", localDate: "2026-10-27" },
      "AMBIGUOUS_FOOD_DAY",
    ],
    [
      {
        kind: "ENTRY_REFERENCE_STALE",
        turnId: userId,
        foodDayId: userId,
        entryId: userId,
        expectedRevision: 2,
      },
      "ENTRY_REFERENCE_STALE",
    ],
    [{ kind: "DAYLESS_READY" }, "DAYLESS_TURN_NOT_SUPPORTED"],
  ] as const)(
    "maps pending state %# to a sanitized 409",
    async (result, code) => {
      const { app } = fixture();
      runTurn.mockResolvedValue(result);
      const response = await post(app);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(code);
      expect(response.body).not.toContain(userId);
      expect(response.body).not.toContain("2026-10-27");
    },
  );

  it("returns a validated clarification question without completing the turn", async () => {
    const { app } = fixture();
    runTurn.mockResolvedValue({
      kind: "CLARIFICATION_READY",
      question: "Which day?",
    });
    const response = await post(app);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "CLARIFICATION_REQUIRED",
        message: "Clarification is required to continue this turn.",
        question: "Which day?",
      },
    });
  });

  it.each([
    [new AccountTurnIdempotencyConflictError(), 409, "IDEMPOTENCY_CONFLICT"],
    [new AccountTurnStateConflictError(), 409, "ACCOUNT_TURN_CONFLICT"],
    [
      new OpenAIFoodDayTargetModelError("PROVIDER_FAILURE"),
      502,
      "MODEL_PROVIDER_ERROR",
    ],
    [
      new APIError(503, {}, "sensitive provider payload", new Headers()),
      502,
      "MODEL_PROVIDER_ERROR",
    ],
    [new ActiveFoodDayPointerIntegrityError(), 500, "INTERNAL_ERROR"],
    [new Error("sensitive provider or SQL details"), 500, "INTERNAL_ERROR"],
  ])(
    "maps typed and unexpected failures without leaking details %#",
    async (error, status, code) => {
      const { app } = fixture();
      runTurn.mockRejectedValue(error);
      const response = await post(app);
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
      expect(response.body).not.toContain(error.message);
    },
  );
});
