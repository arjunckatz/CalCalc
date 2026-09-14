import {
  createFoodEntry,
  DomainValidationError,
  IncompatibleUnitError,
  updateFoodEntryQuantity,
} from "@cal-calc/domain";
import {
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  SemanticOperationIdempotencyConflictError,
  SemanticOperationStateConflictError,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  updateFoodEntryMutation,
  type UpdateFoodEntryCommand,
} from "../mutations/update-food-entry.js";
import { createApiApp } from "./app.js";

vi.mock("../mutations/update-food-entry.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../mutations/update-food-entry.js")
  >()),
  updateFoodEntryMutation: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const entryId = "20000000-0000-4000-8000-000000000001";
const headers = {
  authorization: "Bearer private-token",
  "idempotency-key": "private-retry",
};
const body = {
  expectedRevision: 1,
  quantity: { amount: "0250.00", unit: "GRAM" },
  overrideAction: { type: "PRESERVE" },
} as const;
const source = createFoodEntry({
  id: entryId,
  foodDayId: "30000000-0000-4000-8000-000000000001",
  rawUserDescription: "200 g chicken and rice",
  displayName: "Chicken and rice",
  quantity: { amount: "200", unit: "GRAM" },
  nutritionBasis: {
    amount: "100",
    unit: "GRAM",
    nutrition: { calories: "249.13", protein: "14.91" },
  },
  evidenceClass: "EXACT",
  status: "CONFIRMED_CONSUMED",
});
const correction = updateFoodEntryQuantity(source, {
  expectedRevision: 1,
  quantity: { amount: "250", unit: "GRAM" },
  overrideAction: { type: "PRESERVE" },
});
if (!correction.ok) throw new Error("Unexpected correction fixture conflict.");
const entry = correction.value;
const mutation = vi.mocked(updateFoodEntryMutation);
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

describe("PATCH /v1/food-entries/:entryId/quantity", () => {
  it("returns 200 APPLIED through the explicit DTO and uses only verified ownership", async () => {
    const { app, authVerifier, postgres, transactionRunner } = fixture();
    const privateEntry = {
      ...entry,
      userId: "private-owner",
      operationKey: "private-operation",
      requestFingerprint: "private-fingerprint",
      lastOperationId: "private-operation-id",
      quantity: { ...entry.quantity, userId: "private-owner" },
      workingNutrition: {
        ...entry.workingNutrition,
        operationKey: "private-operation",
      },
    };
    mutation.mockResolvedValueOnce({
      disposition: "APPLIED",
      entry: privateEntry,
      appliedRevision: 2,
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/food-entries/${entryId}/quantity?userId=wrong-owner`,
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
        command: { entryId, ...body },
      },
    );
    expect(response.json()).toEqual({
      disposition: "APPLIED",
      appliedRevision: 2,
      entry: {
        id: entryId,
        foodDayId: source.foodDayId,
        rawUserDescription: "200 g chicken and rice",
        displayName: "Chicken and rice",
        quantity: { amount: "250", unit: "GRAM" },
        nutritionBasis: {
          amount: "100",
          unit: "GRAM",
          nutrition: { calories: "249.13", protein: "14.91" },
        },
        derivedNutrition: { calories: "622.825", protein: "37.275" },
        workingNutrition: { calories: "622.825", protein: "37.275" },
        evidenceClass: "EXACT",
        status: "CONFIRMED_CONSUMED",
        revision: 2,
        deletedAt: null,
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
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/food-entries/${entryId}/quantity`,
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      disposition: "REPLAYED",
      appliedRevision: 2,
      entry: { id: entryId, revision: 3 },
    });
  });

  it("maps stale revision to a fixed sanitized 409", async () => {
    const { app } = fixture();
    mutation.mockRejectedValueOnce(
      new FoodEntryRevisionConflictError(entryId, 1, 9),
    );
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/food-entries/${entryId}/quantity`,
      headers,
      payload: body,
    });
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

  it("maps same-key changed-command idempotency conflict to sanitized 409", async () => {
    const { app } = fixture();
    await app.inject({
      method: "PATCH",
      url: `/v1/food-entries/${entryId}/quantity`,
      headers,
      payload: body,
    });
    mutation.mockRejectedValueOnce(
      new SemanticOperationIdempotencyConflictError(
        "private-key",
        "private-old-fingerprint",
        "private-new-fingerprint",
      ),
    );
    const changed = { ...body, quantity: { ...body.quantity, amount: "300" } };
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/food-entries/${entryId}/quantity`,
      headers,
      payload: changed,
    });
    expect(mutation.mock.calls[1]![1]).toEqual({
      trustedUserId: userId,
      idempotencyKey: "private-retry",
      command: { entryId, ...changed },
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

  it("reuses the fixed conflict response for known non-replayable operation states", async () => {
    const { app } = fixture();
    for (const status of ["PENDING", "FAILED"] as const) {
      mutation.mockRejectedValueOnce(
        new SemanticOperationStateConflictError("private-key", status),
      );
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/food-entries/${entryId}/quantity`,
        headers,
        payload: body,
      });
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

  it("rejects missing and invalid idempotency keys with the fixed 400 response", async () => {
    const { app } = fixture();
    for (const key of [undefined, "invalid,key"]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/food-entries/${entryId}/quantity`,
        headers: {
          authorization: headers.authorization,
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(
        errorBody(
          "INVALID_IDEMPOTENCY_KEY",
          "A valid Idempotency-Key is required.",
        ),
      );
    }
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects physically duplicated idempotency headers", async () => {
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
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/food-entries/${entryId}/quantity`,
      headers,
      payload: body,
    });
    expect(occurrences).toBe(2);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(
      errorBody(
        "INVALID_IDEMPOTENCY_KEY",
        "A valid Idempotency-Key is required.",
      ),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects an invalid route entry ID before body parsing or mutation execution", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/food-entries/not-a-uuid/quantity",
      headers,
      payload: { userId: "private-owner" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(
      errorBody(
        "INVALID_UPDATE_FOOD_ENTRY",
        "Invalid FoodEntry quantity correction request.",
      ),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects missing authentication before idempotency and command validation", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/food-entries/not-a-uuid/quantity",
      payload: { userId: "private-owner" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual(
      errorBody("UNAUTHENTICATED", "Authentication required."),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects ownership and internal fields in the body", async () => {
    const { app } = fixture();
    for (const field of [
      "entryId",
      "userId",
      "ownerId",
      "action",
      "operationId",
      "operationKey",
      "requestFingerprint",
      "currentEntry",
      "resultingRevision",
    ]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/food-entries/${entryId}/quantity`,
        headers,
        payload: { ...body, [field]: "private-value" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(
        errorBody(
          "INVALID_UPDATE_FOOD_ENTRY",
          "Invalid FoodEntry quantity correction request.",
        ),
      );
    }
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects numeric quantity input without coercion", async () => {
    const { app } = fixture();
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/food-entries/${entryId}/quantity`,
      headers,
      payload: { ...body, quantity: { amount: 250, unit: "GRAM" } },
    });
    expect(response.statusCode).toBe(400);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects malformed override-action transport shapes", async () => {
    const { app } = fixture();
    for (const overrideAction of [
      { type: "OTHER" },
      { type: "PRESERVE", override: { calories: "1" } },
      { type: "REPLACE" },
      { type: "REPLACE", override: { calories: 1 } },
    ]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/food-entries/${entryId}/quantity`,
        headers,
        payload: { ...body, overrideAction },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(mutation).not.toHaveBeenCalled();
  });

  it("accepts distinct CLEAR and REPLACE transport shapes without interpreting them", async () => {
    const { app } = fixture();
    const actions = [
      { type: "CLEAR" as const },
      {
        type: "REPLACE" as const,
        override: { calories: "0600.00", protein: "37.50" },
      },
    ];
    for (const overrideAction of actions) {
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/food-entries/${entryId}/quantity`,
        headers,
        payload: { ...body, overrideAction },
      });
      expect(response.statusCode).toBe(200);
      expect(mutation.mock.calls.at(-1)![1]).toEqual({
        trustedUserId: userId,
        idempotencyKey: "private-retry",
        command: { entryId, ...body, overrideAction },
      });
    }
  });

  it("sanitizes typed application and domain validation failures", async () => {
    const { app } = fixture();
    for (const failure of [
      new DomainValidationError("private invalid correction"),
      new IncompatibleUnitError("GRAM", "SERVING"),
    ]) {
      mutation.mockRejectedValueOnce(failure);
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/food-entries/${entryId}/quantity`,
        headers,
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(
        errorBody(
          "INVALID_UPDATE_FOOD_ENTRY",
          "Invalid FoodEntry quantity correction request.",
        ),
      );
      expect(response.body).not.toContain("private invalid correction");
    }
  });

  it("preserves ownership-scoped missing resources as sanitized 404", async () => {
    const { app } = fixture();
    mutation.mockRejectedValueOnce(new FoodEntryNotFoundError(entryId));
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/food-entries/${entryId}/quantity`,
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(
      errorBody("NOT_FOUND", "Resource not found."),
    );
    expect(response.body).not.toContain(entryId);
  });

  it("sanitizes unexpected application failures as 500", async () => {
    const { app } = fixture();
    mutation.mockRejectedValueOnce(new Error("private database detail"));
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/food-entries/${entryId}/quantity`,
      headers,
      payload: body,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(
      errorBody("INTERNAL_ERROR", "An internal error occurred."),
    );
    expect(response.body).not.toContain("private database detail");
  });
});
