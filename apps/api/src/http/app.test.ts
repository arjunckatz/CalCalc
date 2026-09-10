import { Server } from "node:http";
import { Socket } from "node:net";

import type { FoodDayRow, PostgresExecutor } from "@cal-calc/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthenticationError } from "../auth/authorization.js";
import { createApiApp } from "./app.js";

const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const dayA = "20000000-0000-4000-8000-000000000001";
const dayB = "20000000-0000-4000-8000-000000000002";
const absentDay = "20000000-0000-4000-8000-000000000003";
const timestamp = "2026-09-08T12:00:00.000Z";
const unauthenticated = {
  error: { code: "UNAUTHENTICATED", message: "Authentication required." },
};
const notFound = {
  error: { code: "NOT_FOUND", message: "Resource not found." },
};
const internalError = {
  error: { code: "INTERNAL_ERROR", message: "An internal error occurred." },
};
const apps: ReturnType<typeof createApiApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function row(overrides: Partial<FoodDayRow> = {}): FoodDayRow {
  return {
    id: dayA,
    user_id: userA,
    status: "OPEN",
    completeness: "PARTIAL",
    calorie_target: "2100.125",
    protein_target: "120.005",
    maintenance_snapshot: "2400.75",
    goal_version_id: "internal-goal-version",
    local_date: "2026-09-08",
    timezone: "UTC",
    opened_at: timestamp,
    closed_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function fixture(
  rows: FoodDayRow[] = [row(), row({ id: dayB, user_id: userB })],
) {
  const authVerifier = {
    verifyAccessToken: vi.fn(async (token: string) => ({
      userId: token === "token-b" ? userB : userA,
    })),
  };
  const postgres = {
    query: vi.fn<PostgresExecutor["query"]>(async (_sql, values) => ({
      rows: rows.filter(
        (item) => item.id === values?.[0] && item.user_id === values?.[1],
      ),
    })),
  };
  const app = createApiApp({
    authVerifier,
    postgres,
    transactionRunner: {
      async runInTransaction() {
        throw new Error("Unexpected transaction in GET test.");
      },
    },
  });
  apps.push(app);
  return { app, authVerifier, postgres };
}

describe("GET /v1/food-days/:foodDayId", () => {
  it("authenticates, performs one ownership-scoped SELECT, and returns only the explicit DTO", async () => {
    const { app, authVerifier, postgres } = fixture();
    const response = await app.inject({
      method: "GET",
      url: `/v1/food-days/${dayA}`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(response.statusCode).toBe(200);
    expect(authVerifier.verifyAccessToken).toHaveBeenCalledExactlyOnceWith(
      "token-a",
    );
    expect(postgres.query).toHaveBeenCalledTimes(1);
    const call = postgres.query.mock.calls[0];
    expect(call?.[0].replace(/\s+/g, " ").trim()).toMatch(
      /^select .* from public\.food_days where id = \$1 and user_id = \$2$/,
    );
    expect(call?.[1]).toEqual([dayA, userA]);
    expect(response.json()).toEqual({
      id: dayA,
      status: "OPEN",
      completeness: "PARTIAL",
      calorieTarget: "2100.125",
      proteinTarget: "120.005",
      localDate: "2026-09-08",
      timezone: "UTC",
      openedAt: timestamp,
      closedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(response.body).not.toContain("userId");
    expect(response.body).not.toContain("internal-goal-version");
    expect(response.body).not.toContain("maintenanceSnapshot");
  });

  it("uses explicit nulls for all absent optional DTO fields", async () => {
    const { app } = fixture([row({ local_date: null, timezone: null })]);
    const response = await app.inject({
      url: `/v1/food-days/${dayA}`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      localDate: null,
      timezone: null,
      closedAt: null,
    });
    expect(Object.keys(response.json())).toHaveLength(11);
  });

  it("preserves a present closedAt and zero decimal strings", async () => {
    const { app } = fixture([
      row({
        status: "CLOSED",
        closed_at: timestamp,
        calorie_target: "0",
        protein_target: "0",
      }),
    ]);
    const response = await app.inject({
      url: `/v1/food-days/${dayA}`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      closedAt: timestamp,
      calorieTarget: "0",
      proteinTarget: "0",
    });
  });

  it("rejects missing authorization before verification or SQL", async () => {
    const { app, authVerifier, postgres } = fixture();
    const response = await app.inject(`/v1/food-days/${dayA}`);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(unauthenticated);
    expect(authVerifier.verifyAccessToken).not.toHaveBeenCalled();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "Bearer ",
    "Basic private-token",
    "Bearer private-token, Bearer other-token",
    "Bearer private-token extra",
  ])(
    "rejects malformed credentials without leaking them (%#)",
    async (authorization) => {
      const { app, authVerifier, postgres } = fixture();
      const response = await app.inject({
        url: `/v1/food-days/${dayA}`,
        headers: { authorization },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(unauthenticated);
      expect(response.body).not.toContain("private-token");
      expect(authVerifier.verifyAccessToken).not.toHaveBeenCalled();
      expect(postgres.query).not.toHaveBeenCalled();
    },
  );

  it.each(["Authorization", "aUtHoRiZaTiOn"])(
    "rejects duplicate %s headers instead of trusting Node's collapsed value",
    async (headerName) => {
      const { app, authVerifier, postgres } = fixture();
      const response = await app.inject({
        url: `/v1/food-days/${dayA}`,
        headers: { [headerName]: ["Bearer token-a", "Bearer token-b"] },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(unauthenticated);
      expect(response.body).not.toContain("token-a");
      expect(response.body).not.toContain("token-b");
      expect(authVerifier.verifyAccessToken).not.toHaveBeenCalled();
      expect(postgres.query).not.toHaveBeenCalled();
    },
  );

  it.each(["INVALID_ACCESS_TOKEN", "INVALID_VERIFIED_IDENTITY"] as const)(
    "maps %s to the same sanitized 401",
    async (reason) => {
      const { app, authVerifier, postgres } = fixture();
      const error = new AuthenticationError(reason);
      error.cause = new Error("Supabase detail private-token");
      authVerifier.verifyAccessToken.mockRejectedValueOnce(error);
      const response = await app.inject({
        url: `/v1/food-days/${dayA}`,
        headers: { authorization: "Bearer private-token" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(unauthenticated);
      expect(response.body).not.toContain("private-token");
      expect(postgres.query).not.toHaveBeenCalled();
    },
  );

  it.each([
    "bad-id",
    "00000000000000000000000000000000",
    `${dayA}x`,
    `${dayA}\n`,
    "'; select 1; --",
  ])("rejects malformed UUID before SQL (%#)", async (id) => {
    const { app, postgres } = fixture();
    const response = await app.inject({
      url: `/v1/food-days/${encodeURIComponent(id)}`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_FOOD_DAY_ID",
        message: "Food day ID must be a UUID.",
      },
    });
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("returns indistinguishable 404s for absent and other-account rows", async () => {
    const { app, postgres } = fixture();
    const missing = await app.inject({
      url: `/v1/food-days/${absentDay}`,
      headers: { authorization: "Bearer token-a" },
    });
    const crossAccount = await app.inject({
      url: `/v1/food-days/${dayB}?userId=${userB}`,
      headers: { authorization: "Bearer token-a", "x-user-id": userB },
    });
    expect(missing.statusCode).toBe(404);
    expect(crossAccount.statusCode).toBe(404);
    expect(missing.json()).toEqual(notFound);
    expect(crossAccount.body).toBe(missing.body);
    expect(postgres.query.mock.calls.map((call) => call[1])).toEqual([
      [absentDay, userA],
      [dayB, userA],
    ]);
  });

  it("ignores request-supplied userId on an otherwise successful owned read", async () => {
    const { app, postgres } = fixture();
    const response = await app.inject({
      url: `/v1/food-days/${dayA}?userId=${userB}`,
      headers: { authorization: "Bearer token-a", "x-user-id": userB },
    });
    expect(response.statusCode).toBe(200);
    expect(postgres.query.mock.calls[0]?.[1]).toEqual([dayA, userA]);
  });

  it("keeps identities local to simultaneous requests", async () => {
    const { app, postgres } = fixture();
    const responses = await Promise.all([
      app.inject({
        url: `/v1/food-days/${dayA}`,
        headers: { authorization: "Bearer token-a" },
      }),
      app.inject({
        url: `/v1/food-days/${dayB}`,
        headers: { authorization: "Bearer token-b" },
      }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200,
    ]);
    expect(postgres.query.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        [dayA, userA],
        [dayB, userB],
      ]),
    );
  });

  it.each([false, true])(
    "reads one raw Authorization without mutating transport metadata (additional headers: %s)",
    async (additionalHeaders) => {
      const { app, authVerifier, postgres } = fixture();
      let before: unknown;
      let after: unknown;
      app.addHook("onRequest", async (request) => {
        if (additionalHeaders) {
          // Exercise Fastify's merged getter without changing the raw credential.
          request.headers = { authorization: "Bearer token-b" };
        }
        before = {
          headers: { ...request.headers },
          parsedRawHeaders: { ...request.raw.headers },
          rawHeaders: [...request.raw.rawHeaders],
        };
      });
      app.addHook("preSerialization", async (request, _reply, payload) => {
        after = {
          headers: { ...request.headers },
          parsedRawHeaders: { ...request.raw.headers },
          rawHeaders: [...request.raw.rawHeaders],
        };
        return payload;
      });
      const response = await app.inject({
        url: `/v1/food-days/${dayA}?userId=${userB}`,
        headers: {
          aUtHoRiZaTiOn: "Bearer private-token",
          "x-user-id": userB,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(before).toBeDefined();
      expect(after).toEqual(before);
      expect(after).toMatchObject({
        headers: {
          authorization: additionalHeaders
            ? "Bearer token-b"
            : "Bearer private-token",
        },
        parsedRawHeaders: { authorization: "Bearer private-token" },
        rawHeaders: expect.arrayContaining(["Bearer private-token"]),
      });
      expect(authVerifier.verifyAccessToken).toHaveBeenCalledExactlyOnceWith(
        "private-token",
      );
      expect(postgres.query).toHaveBeenCalledTimes(1);
      expect(postgres.query.mock.calls[0]?.[1]).toEqual([dayA, userA]);
      expect(response.body).not.toContain("private-token");
      expect(response.body).not.toContain("token-b");
    },
  );

  it.each(["private-path-%", "private-path-%GG", "private-path-%E0%A4%A"])(
    "sanitizes malformed URL encoding before authentication or SQL (%#)",
    async (malformed) => {
      const { app, authVerifier, postgres } = fixture();
      const response = await app.inject({
        url: `/v1/food-days/${malformed}`,
        headers: { authorization: "Bearer private-token" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toBe(
        "application/json; charset=utf-8",
      );
      expect(response.json()).toEqual({
        error: { code: "INVALID_REQUEST", message: "Invalid request." },
      });
      expect(response.body).not.toContain(malformed);
      expect(response.body).not.toContain("private-path");
      expect(response.body).not.toContain("private-token");
      expect(authVerifier.verifyAccessToken).not.toHaveBeenCalled();
      expect(postgres.query).not.toHaveBeenCalled();
    },
  );

  it("sanitizes an oversized route parameter before authentication or SQL", async () => {
    const { app, authVerifier, postgres } = fixture();
    const oversized = "private-path-".repeat(100);
    const response = await app.inject({
      url: `/v1/food-days/${oversized}`,
      headers: { authorization: "Bearer private-token" },
    });
    expect(response.statusCode).toBe(414);
    expect(response.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.json()).toEqual({
      error: { code: "URI_TOO_LONG", message: "Request URI is too long." },
    });
    expect(response.body).not.toContain(oversized);
    expect(response.body).not.toContain("private-path");
    expect(response.body).not.toContain("private-token");
    expect(authVerifier.verifyAccessToken).not.toHaveBeenCalled();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it.each(["database", "verifier"])(
    "sanitizes unexpected %s failures as 500, not 401",
    async (source) => {
      const { app, authVerifier, postgres } = fixture();
      const failure = new Error(
        "SQL/private-token/postgresql://secret-host Supabase internal detail",
      );
      if (source === "database") postgres.query.mockRejectedValueOnce(failure);
      else authVerifier.verifyAccessToken.mockRejectedValueOnce(failure);
      const response = await app.inject({
        url: `/v1/food-days/${dayA}`,
        headers: { authorization: "Bearer private-token" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(internalError);
      for (const secret of [
        "SQL",
        "private-token",
        "secret-host",
        "Supabase",
        "stack",
      ])
        expect(response.body).not.toContain(secret);
    },
  );

  it.each(["POST", "PATCH", "DELETE"] as const)(
    "does not expose a %s mutation",
    async (method) => {
      const { app, postgres } = fixture();
      const response = await app.inject({
        method,
        url: `/v1/food-days/${dayA}`,
        headers: { authorization: "Bearer token-a" },
      });
      expect(response.statusCode).toBe(404);
      expect(postgres.query).not.toHaveBeenCalled();
    },
  );
});

describe("createApiApp lifecycle", () => {
  it("does not listen or connect to a host when the API module is imported", async () => {
    const listen = vi
      .spyOn(Server.prototype, "listen")
      .mockImplementation(() => {
        throw new Error("Unexpected listen.");
      });
    const connect = vi
      .spyOn(Socket.prototype, "connect")
      .mockImplementation(() => {
        throw new Error("Unexpected network connection.");
      });
    vi.resetModules();
    await import("../index.js");
    expect(listen).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("creates independent, non-listening apps with no eager IO and caller-owned lifecycle", async () => {
    const first = fixture();
    const second = fixture();
    expect(first.app).not.toBe(second.app);
    for (const { app, authVerifier, postgres } of [first, second]) {
      expect(app.server.listening).toBe(false);
      expect(authVerifier.verifyAccessToken).not.toHaveBeenCalled();
      expect(postgres.query).not.toHaveBeenCalled();
    }
    const closed = vi.fn();
    first.app.addHook("onClose", async () => {
      closed();
    });
    await first.app.close();
    expect(closed).toHaveBeenCalledTimes(1);
    const response = await second.app.inject(`/v1/food-days/${dayA}`);
    expect(response.statusCode).toBe(401);
    expect(second.app.server.listening).toBe(false);
  });

  it("emits no default logger/request output", async () => {
    const { app } = fixture();
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    app.log.info("private-token should never be written");
    await app.inject({
      url: `/v1/food-days/${dayA}`,
      headers: { authorization: "Bearer private-token" },
    });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
