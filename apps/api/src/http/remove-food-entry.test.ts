import {
  createFoodEntry,
  deleteFoodEntry,
  DomainValidationError,
} from "@cal-calc/domain";
import {
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  SemanticOperationIdempotencyConflictError,
  SemanticOperationStateConflictError,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeFoodEntryMutation } from "../mutations/remove-food-entry.js";
import { createApiApp } from "./app.js";

vi.mock("../mutations/remove-food-entry.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../mutations/remove-food-entry.js")
  >()),
  removeFoodEntryMutation: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const entryId = "20000000-0000-4000-8000-000000000001";
const deletedAt = "2026-09-16T12:00:00Z";
const headers = {
  authorization: "Bearer private-token",
  "idempotency-key": "private-retry",
};
const body = { expectedRevision: 1 };
const source = createFoodEntry({
  id: entryId,
  foodDayId: "30000000-0000-4000-8000-000000000001",
  rawUserDescription: "Lunch",
  displayName: "Lunch",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "685.1075", protein: "41.0025" },
  },
  evidenceClass: "SOURCED",
  status: "CONFIRMED_CONSUMED",
});
const removal = deleteFoodEntry(source, { expectedRevision: 1, deletedAt });
if (!removal.ok) throw new Error("Unexpected removal fixture conflict.");
const entry = removal.value;
const mutation = vi.mocked(removeFoodEntryMutation);
const apps: ReturnType<typeof createApiApp>[] = [];
const errorBody = (code: string, message: string) => ({
  error: { code, message },
});

beforeEach(() => {
  mutation.mockReset();
  mutation.mockResolvedValue({
    disposition: "APPLIED",
    entry,
    appliedRevision: 2,
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const authVerifier = { verifyAccessToken: vi.fn(async () => ({ userId })) };
  const postgres = { query: vi.fn(async () => ({ rows: [] })) };
  const transactionRunner: PostgresTransactionRunner = {
    runInTransaction: vi.fn(async () => {
      throw new Error("HTTP must delegate to the application mutation.");
    }),
  };
  const app = createApiApp({ authVerifier, postgres, transactionRunner });
  apps.push(app);
  return { app, authVerifier, postgres, transactionRunner };
}

function remove(
  app: ReturnType<typeof createApiApp>,
  options: {
    readonly entry?: string;
    readonly requestBody?: unknown;
    readonly requestHeaders?: Record<string, string>;
  } = {},
) {
  const requestBody = Object.hasOwn(options, "requestBody")
    ? options.requestBody
    : body;
  return app.inject({
    method: "DELETE",
    url: `/v1/food-entries/${options.entry ?? entryId}`,
    headers: {
      ...(options.requestHeaders ?? headers),
      "content-type": "application/json",
    },
    payload: JSON.stringify(requestBody),
  });
}

describe("DELETE /v1/food-entries/:entryId", () => {
  it("returns 200 APPLIED through the explicit DTO and uses only verified ownership", async () => {
    const { app, authVerifier, postgres, transactionRunner } = fixture();
    const privateEntry = {
      ...entry,
      userId: "private-owner",
      operationKey: "private-operation",
      quantity: { ...entry.quantity, userId: "private-owner" },
    };
    mutation.mockResolvedValueOnce({
      disposition: "APPLIED",
      appliedRevision: 2,
      entry: privateEntry,
    });
    const response = await app.inject({
      method: "DELETE",
      url: `/v1/food-entries/${entryId}?userId=wrong-owner`,
      headers: { ...headers, "x-user-id": "wrong-owner" },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(authVerifier.verifyAccessToken).toHaveBeenCalledWith(
      "private-token",
    );
    expect(mutation).toHaveBeenCalledExactlyOnceWith(
      { transactionRunner },
      {
        trustedUserId: userId,
        idempotencyKey: "private-retry",
        command: { entryId, expectedRevision: 1 },
      },
    );
    expect(response.json()).toEqual({
      disposition: "APPLIED",
      appliedRevision: 2,
      entry: {
        id: entryId,
        foodDayId: source.foodDayId,
        rawUserDescription: "Lunch",
        displayName: "Lunch",
        quantity: { amount: "1", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "685.1075", protein: "41.0025" },
        },
        derivedNutrition: { calories: "685.1075", protein: "41.0025" },
        workingNutrition: { calories: "685.1075", protein: "41.0025" },
        evidenceClass: "SOURCED",
        status: "CONFIRMED_CONSUMED",
        revision: 2,
        deletedAt,
      },
    });
    expect(response.body).not.toContain("private");
    expect(response.body).not.toContain("wrong-owner");
    expect(postgres.query).not.toHaveBeenCalled();
    expect(transactionRunner.runInTransaction).not.toHaveBeenCalled();
  });

  it("returns 200 REPLAYED with the authoritative entry and original applied revision", async () => {
    const { app } = fixture();
    mutation.mockResolvedValueOnce({
      disposition: "REPLAYED",
      entry: { ...entry, revision: 3 },
      appliedRevision: 2,
    });
    const response = await remove(app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      disposition: "REPLAYED",
      appliedRevision: 2,
      entry: { id: entryId, revision: 3, deletedAt },
    });
  });

  it("maps stale revision to the existing fixed sanitized 409", async () => {
    const { app } = fixture();
    mutation.mockRejectedValueOnce(
      new FoodEntryRevisionConflictError(entryId, 1, 9),
    );
    const response = await remove(app);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(
      errorBody(
        "FOOD_ENTRY_REVISION_CONFLICT",
        "Food entry revision conflict.",
      ),
    );
    expect(response.body).not.toContain(entryId);
    expect(response.body).not.toContain("9");
  });

  it("maps same-key changed-revision conflict to sanitized 409", async () => {
    const { app } = fixture();
    await remove(app);
    mutation.mockRejectedValueOnce(
      new SemanticOperationIdempotencyConflictError(
        "private-key",
        "private-old",
        "private-new",
      ),
    );
    const response = await remove(app, {
      requestBody: { expectedRevision: 2 },
    });
    expect(mutation.mock.calls[1]![1]).toEqual({
      trustedUserId: userId,
      idempotencyKey: "private-retry",
      command: { entryId, expectedRevision: 2 },
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

  it("maps known non-replayable operations to the existing sanitized 409", async () => {
    const { app } = fixture();
    for (const status of ["PENDING", "FAILED"] as const) {
      mutation.mockRejectedValueOnce(
        new SemanticOperationStateConflictError("private-key", status),
      );
      const response = await remove(app);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(
        errorBody(
          "OPERATION_NOT_REPLAYABLE",
          "This operation cannot currently be replayed.",
        ),
      );
      expect(response.body).not.toContain("private-key");
    }
  });

  it("rejects a missing Idempotency-Key with the existing sanitized 400", async () => {
    const { app } = fixture();
    const response = await remove(app, {
      requestHeaders: { authorization: headers.authorization },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(
      errorBody(
        "INVALID_IDEMPOTENCY_KEY",
        "A valid Idempotency-Key is required.",
      ),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects physically duplicated Idempotency-Key headers", async () => {
    const { app } = fixture();
    let occurrences = 0;
    app.addHook("onRequest", async (request) => {
      const index = request.raw.rawHeaders.findIndex(
        (value, rawIndex) =>
          rawIndex % 2 === 0 && value.toLowerCase() === "idempotency-key",
      );
      request.raw.rawHeaders[index + 1] = "same";
      request.raw.rawHeaders.push("Idempotency-Key", "same");
      occurrences = request.raw.rawHeaders.filter(
        (value, rawIndex) =>
          rawIndex % 2 === 0 && value.toLowerCase() === "idempotency-key",
      ).length;
    });
    const response = await remove(app);
    expect(occurrences).toBe(2);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects an invalid route entry ID before body parsing or mutation execution", async () => {
    const { app } = fixture();
    const response = await remove(app, {
      entry: "not-a-uuid",
      requestBody: { userId: "private-owner" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(
      errorBody(
        "INVALID_REMOVE_FOOD_ENTRY",
        "Invalid FoodEntry removal request.",
      ),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects missing authentication before idempotency and request validation", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/food-entries/not-a-uuid",
      payload: { userId: "private-owner" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(
      errorBody("UNAUTHENTICATED", "Authentication required."),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects invalid expectedRevision values without coercion", async () => {
    const { app } = fixture();
    for (const expectedRevision of ["1", 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await remove(app, { requestBody: { expectedRevision } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_REMOVE_FOOD_ENTRY");
    }
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects ownership and internal body fields", async () => {
    const { app } = fixture();
    for (const field of [
      "userId",
      "deletedAt",
      "currentEntry",
      "resultingRevision",
      "action",
      "operationKey",
      "requestFingerprint",
      "operationId",
    ]) {
      const response = await remove(app, {
        requestBody: { ...body, [field]: "private-value" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(
        errorBody(
          "INVALID_REMOVE_FOOD_ENTRY",
          "Invalid FoodEntry removal request.",
        ),
      );
    }
    expect(mutation).not.toHaveBeenCalled();
  });

  it("preserves ownership-scoped missing resources as sanitized 404", async () => {
    const { app } = fixture();
    mutation.mockRejectedValueOnce(new FoodEntryNotFoundError(entryId));
    const response = await remove(app);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(
      errorBody("NOT_FOUND", "Resource not found."),
    );
    expect(response.body).not.toContain(entryId);
  });

  it("maps already-deleted domain validation to the route's sanitized 400", async () => {
    const { app } = fixture();
    mutation.mockRejectedValueOnce(
      new DomainValidationError("Food entry is already deleted."),
    );
    const response = await remove(app);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(
      errorBody(
        "INVALID_REMOVE_FOOD_ENTRY",
        "Invalid FoodEntry removal request.",
      ),
    );
    expect(response.body).not.toContain("already deleted");
  });

  it("rejects an absent or non-object body as a sanitized invalid request", async () => {
    const { app } = fixture();
    for (const requestBody of [undefined, null, []]) {
      const response =
        requestBody === undefined
          ? await app.inject({
              method: "DELETE",
              url: `/v1/food-entries/${entryId}`,
              headers,
            })
          : await remove(app, { requestBody });
      expect(response.statusCode).toBe(400);
      expect(["INVALID_REQUEST", "INVALID_REMOVE_FOOD_ENTRY"]).toContain(
        response.json().error.code,
      );
    }
    expect(mutation).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected mutation failures as 500", async () => {
    const { app } = fixture();
    mutation.mockRejectedValueOnce(new Error("private SQL detail"));
    const response = await remove(app);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(
      errorBody("INTERNAL_ERROR", "An internal error occurred."),
    );
    expect(response.body).not.toContain("private SQL detail");
  });
});
