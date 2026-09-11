import {
  createFoodEntry,
  DomainValidationError,
  IncompatibleUnitError,
} from "@cal-calc/domain";
import {
  SemanticOperationIdempotencyConflictError,
  SemanticOperationStateConflictError,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFoodEntryMutation,
  type CreateFoodEntryCommand,
} from "../mutations/create-food-entry.js";
import { createApiApp } from "./app.js";

vi.mock("../mutations/create-food-entry.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../mutations/create-food-entry.js")
  >()),
  createFoodEntryMutation: vi.fn(),
}));
const mutation = vi.mocked(createFoodEntryMutation);
const userId = "10000000-0000-4000-8000-000000000001";
const headers = {
  authorization: "Bearer private-token",
  "idempotency-key": "private-retry",
};
const payload: CreateFoodEntryCommand = {
  foodDayId: "20000000-0000-4000-8000-000000000001",
  rawUserDescription: "Lunch",
  displayName: "Lunch",
  quantity: { amount: "1.0", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: {
      calories: "685.1075",
      protein: "41.0025",
      carbs: "249.13",
      fat: "0.1",
    },
  },
  evidenceClass: "SOURCED",
};
const entry = createFoodEntry({
  ...payload,
  id: "30000000-0000-4000-8000-000000000001",
  status: "CONFIRMED_CONSUMED",
});
const apps: ReturnType<typeof createApiApp>[] = [];
const errorBody = (code: string, message: string) => ({
  error: { code, message },
});

beforeEach(() => {
  mutation.mockReset();
  mutation.mockResolvedValue({ disposition: "CREATED", entry });
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture() {
  const authVerifier = { verifyAccessToken: vi.fn(async () => ({ userId })) };
  const postgres = { query: vi.fn(async () => ({ rows: [] })) };
  const transactionRunner: PostgresTransactionRunner = {
    runInTransaction: vi.fn(async () => {
      throw new Error("HTTP must delegate to application.");
    }),
  };
  const app = createApiApp({ authVerifier, postgres, transactionRunner });
  apps.push(app);
  return { app, authVerifier, postgres, transactionRunner };
}

describe("POST /v1/food-entries", () => {
  it("returns 201 with an explicit nested DTO and only forwards verified ownership", async () => {
    const { app, postgres, transactionRunner, authVerifier } = fixture();
    const internals = {
      userId: "private-owner",
      operationKey: "private-key",
      requestFingerprint: "private-fp",
      operationId: "private-id",
      lastOperationId: "private-id",
    };
    mutation.mockResolvedValueOnce({
      disposition: "CREATED",
      ...internals,
      entry: {
        ...entry,
        ...internals,
        quantity: { ...entry.quantity, ...internals },
        nutritionBasis: {
          ...entry.nutritionBasis,
          ...internals,
          nutrition: { ...entry.nutritionBasis.nutrition, ...internals },
        },
        derivedNutrition: { ...entry.derivedNutrition, ...internals },
        workingNutrition: { ...entry.workingNutrition, ...internals },
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/food-entries?userId=wrong-owner",
      headers: { ...headers, "x-user-id": "wrong-owner" },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(authVerifier.verifyAccessToken).toHaveBeenCalledWith(
      "private-token",
    );
    expect(mutation).toHaveBeenCalledExactlyOnceWith(
      { transactionRunner },
      {
        trustedUserId: userId,
        idempotencyKey: "private-retry",
        command: payload,
      },
    );
    expect(response.json()).toEqual({
      disposition: "CREATED",
      entry: {
        id: entry.id,
        foodDayId: payload.foodDayId,
        rawUserDescription: "Lunch",
        displayName: "Lunch",
        quantity: { amount: "1", unit: "SERVING" },
        nutritionBasis: payload.nutritionBasis,
        derivedNutrition: payload.nutritionBasis.nutrition,
        workingNutrition: payload.nutritionBasis.nutrition,
        evidenceClass: "SOURCED",
        status: "CONFIRMED_CONSUMED",
        revision: 1,
        deletedAt: null,
      },
    });
    expect(response.body).not.toContain("private");
    expect(response.body).not.toContain("wrong-owner");
    expect(postgres.query).not.toHaveBeenCalled();
    expect(transactionRunner.runInTransaction).not.toHaveBeenCalled();
  });

  it("maps the application replay to 200 and preserves authoritative current state", async () => {
    const { app } = fixture();
    mutation.mockResolvedValueOnce({
      disposition: "REPLAYED",
      entry: { ...entry, revision: 2, deletedAt: "2026-09-11T12:00:00Z" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/food-entries",
      headers,
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      disposition: "REPLAYED",
      entry: { id: entry.id, revision: 2, deletedAt: "2026-09-11T12:00:00Z" },
    });
  });

  it("forwards the same key and changed command, mapping application conflict to sanitized 409", async () => {
    const { app } = fixture();
    await app.inject({
      method: "POST",
      url: "/v1/food-entries",
      headers,
      payload,
    });
    mutation.mockRejectedValueOnce(
      new SemanticOperationIdempotencyConflictError(
        "private-key",
        "private-old",
        "private-new",
      ),
    );
    const changed = { ...payload, displayName: "Dinner" };
    const response = await app.inject({
      method: "POST",
      url: "/v1/food-entries",
      headers,
      payload: changed,
    });
    expect(mutation.mock.calls[1]![1]).toEqual({
      trustedUserId: userId,
      idempotencyKey: "private-retry",
      command: changed,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(
      errorBody(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used for a different request.",
      ),
    );
  });

  it.each([undefined, "invalid,private", ["same", "same"]])(
    "rejects missing/invalid/physically duplicated idempotency headers (%#)",
    async (key) => {
      const { app } = fixture();
      let occurrences = 0;
      app.addHook("onRequest", async (request) => {
        // inject() folds arrays into one comma-joined header. Model Node's raw
        // pairs explicitly so this case exercises physical-duplicate rejection.
        if (Array.isArray(key)) {
          const index = request.raw.rawHeaders.findIndex(
            (value, index) =>
              index % 2 === 0 && value.toLowerCase() === "idempotency-key",
          );
          request.raw.rawHeaders[index + 1] = key[0]!;
          request.raw.rawHeaders.push("Idempotency-Key", key[1]!);
        }
        occurrences = request.raw.rawHeaders.filter(
          (value, index) =>
            index % 2 === 0 && value.toLowerCase() === "idempotency-key",
        ).length;
      });
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-entries",
        headers: {
          authorization: headers.authorization,
          ...(key === undefined ? {} : { "Idempotency-Key": key }),
        },
        payload,
      });
      if (Array.isArray(key)) expect(occurrences).toBe(2);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(
        errorBody(
          "INVALID_IDEMPOTENCY_KEY",
          "A valid Idempotency-Key is required.",
        ),
      );
      expect(mutation).not.toHaveBeenCalled();
    },
  );

  it("rejects missing auth before command validation or application execution", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/food-entries",
      headers: { "idempotency-key": "retry" },
      payload: { userId: "wrong" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(
      errorBody("UNAUTHENTICATED", "Authentication required."),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it.each([
    "userId",
    "ownerId",
    "id",
    "revision",
    "status",
    "action",
    "operationId",
    "operationKey",
    "requestFingerprint",
    "unknown",
  ])("rejects forbidden body field %s", async (field) => {
    const { app } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/food-entries",
      headers,
      payload: { ...payload, [field]: "private-value" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(
      errorBody(
        "INVALID_CREATE_FOOD_ENTRY",
        "Invalid FoodEntry creation request.",
      ),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it.each([
    {},
    [],
    null,
    { ...payload, foodDayId: "not-a-uuid" },
    { ...payload, quantity: { amount: 1, unit: "SERVING" } },
    { ...payload, quantity: { ...payload.quantity, extra: "private" } },
    { ...payload, nutritionBasis: { ...payload.nutritionBasis, amount: 1 } },
    {
      ...payload,
      nutritionBasis: {
        ...payload.nutritionBasis,
        nutrition: { calories: 685.1075 },
      },
    },
    {
      ...payload,
      nutritionBasis: {
        ...payload.nutritionBasis,
        nutrition: { calories: "1", protein: null },
      },
    },
    {
      ...payload,
      nutritionBasis: {
        ...payload.nutritionBasis,
        nutrition: { calories: "1e100000000" },
      },
    },
    {
      ...payload,
      nutritionBasis: {
        ...payload.nutritionBasis,
        nutrition: { calories: "1", secret: "private" },
      },
    },
    { ...payload, evidenceClass: "OTHER" },
  ])(
    "rejects invalid nested wire structure without numeric coercion (%#)",
    async (body) => {
      const { app } = fixture();
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-entries",
        headers: { ...headers, "content-type": "application/json" },
        payload: JSON.stringify(body),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(
        errorBody(
          "INVALID_CREATE_FOOD_ENTRY",
          "Invalid FoodEntry creation request.",
        ),
      );
      expect(mutation).not.toHaveBeenCalled();
    },
  );

  it.each([
    new DomainValidationError("private invalid quantity"),
    new IncompatibleUnitError("GRAM", "SERVING"),
  ])(
    "sanitizes typed application/domain input errors (%#)",
    async (failure) => {
      const { app } = fixture();
      mutation.mockRejectedValueOnce(failure);
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-entries",
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(
        errorBody(
          "INVALID_CREATE_FOOD_ENTRY",
          "Invalid FoodEntry creation request.",
        ),
      );
    },
  );

  it.each(["PENDING", "FAILED"] as const)(
    "reuses the known %s non-replayable mapping",
    async (status) => {
      const { app } = fixture();
      mutation.mockRejectedValueOnce(
        new SemanticOperationStateConflictError("private-key", status),
      );
      const response = await app.inject({
        method: "POST",
        url: "/v1/food-entries",
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

  it("sanitizes unexpected application failures as 500", async () => {
    const { app } = fixture();
    mutation.mockRejectedValueOnce(
      new Error("private-token private-retry postgresql://secret"),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/food-entries",
      headers,
      payload,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(
      errorBody("INTERNAL_ERROR", "An internal error occurred."),
    );
  });
});
