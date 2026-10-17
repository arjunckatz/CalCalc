import {
  setAccountNutritionTargetsExactlyOnce,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveMutationIdentity,
  parseIdempotencyKey,
} from "./mutation-identity.js";
import {
  InvalidSetAccountNutritionTargetsCommandError,
  parseSetAccountNutritionTargetsCommand,
  setAccountNutritionTargetsMutation,
} from "./set-account-nutrition-targets.js";

vi.mock("@cal-calc/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cal-calc/persistence")>()),
  setAccountNutritionTargetsExactlyOnce: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const retry = parseIdempotencyKey("target-retry");
const runner: PostgresTransactionRunner = {
  async runInTransaction() {
    throw new Error("Unexpected DB call.");
  },
};
const workflow = vi.mocked(setAccountNutritionTargetsExactlyOnce);
const timestamp = "2026-10-17T00:00:00Z";
const command = {
  expectedVersion: null,
  calorieTarget: "0685.107500",
  proteinTarget: "041.002500",
};

beforeEach(() => {
  vi.clearAllMocks();
  workflow.mockImplementation(async (_runner, input) => ({
    disposition: "APPLIED",
    targets: {
      userId: input.userId,
      calorieTarget: input.calorieTarget,
      proteinTarget: input.proteinTarget,
      version: input.expectedVersion === null ? 0 : input.expectedVersion + 1,
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

function run(value: unknown = command, key = retry) {
  return setAccountNutritionTargetsMutation(
    { transactionRunner: runner },
    {
      trustedUserId: userId,
      idempotencyKey: key,
      command: value as typeof command,
    },
  );
}

describe("setAccountNutritionTargetsMutation", () => {
  it("parses both exact targets as one complete configuration", () => {
    expect(parseSetAccountNutritionTargetsCommand(command)).toEqual({
      expectedVersion: null,
      calorieTarget: "685.1075",
      proteinTarget: "41.0025",
    });
    expect(() =>
      parseSetAccountNutritionTargetsCommand({
        expectedVersion: null,
        calorieTarget: "1",
      }),
    ).toThrow(InvalidSetAccountNutritionTargetsCommandError);
  });

  it("normalizes exact decimals before application-owned operation identity", async () => {
    const result = await run();
    const sent = workflow.mock.calls[0]![1];
    expect(workflow.mock.calls[0]![0]).toBe(runner);
    expect(sent).toMatchObject({
      userId,
      expectedVersion: null,
      calorieTarget: "685.1075",
      proteinTarget: "41.0025",
    });
    expect(sent).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "SET_ACCOUNT_NUTRITION_TARGETS",
        idempotencyKey: retry,
        semanticPayload: {
          expectedVersion: null,
          calorieTarget: "685.1075",
          proteinTarget: "41.0025",
        },
      }),
    );
    expect(sent.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result).toEqual({
      disposition: "APPLIED",
      targets: {
        userId,
        calorieTarget: "685.1075",
        proteinTarget: "41.0025",
        version: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    expect(result).not.toHaveProperty("operation");
  });

  it("equivalent spellings reuse identity; changed values conflict by fingerprint; fresh key is fresh intent", async () => {
    await run();
    await run({
      expectedVersion: null,
      calorieTarget: "685.1075",
      proteinTarget: "41.0025",
    });
    await run({
      expectedVersion: null,
      calorieTarget: "685.1076",
      proteinTarget: "41.0025",
    });
    await run(command, parseIdempotencyKey("new-intent"));
    const sent = workflow.mock.calls.map((call) => call[1]);
    expect(sent[0]?.operationKey).toBe(sent[1]?.operationKey);
    expect(sent[0]?.requestFingerprint).toBe(sent[1]?.requestFingerprint);
    expect(sent[0]?.operationKey).toBe(sent[2]?.operationKey);
    expect(sent[0]?.requestFingerprint).not.toBe(sent[2]?.requestFingerprint);
    expect(sent[0]?.operationKey).not.toBe(sent[3]?.operationKey);
    expect(sent[0]?.operationId).not.toBe(sent[1]?.operationId);
  });

  it("accepts zero and update-version meaning", async () => {
    await run({
      expectedVersion: 0,
      calorieTarget: "0.00",
      proteinTarget: "0",
    });
    expect(workflow.mock.calls[0]?.[1]).toMatchObject({
      expectedVersion: 0,
      calorieTarget: "0",
      proteinTarget: "0",
    });
    expect(workflow.mock.calls[0]?.[1].requestFingerprint).not.toBe(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "SET_ACCOUNT_NUTRITION_TARGETS",
        idempotencyKey: retry,
        semanticPayload: {
          expectedVersion: null,
          calorieTarget: "0",
          proteinTarget: "0",
        },
      }).requestFingerprint,
    );
  });

  it.each([
    { expectedVersion: -1, calorieTarget: "1", proteinTarget: "1" },
    { expectedVersion: 0.5, calorieTarget: "1", proteinTarget: "1" },
    { expectedVersion: null, calorieTarget: "-1", proteinTarget: "1" },
    { expectedVersion: null, calorieTarget: "1e2", proteinTarget: "1" },
    { expectedVersion: null, calorieTarget: 1, proteinTarget: "1" },
    { expectedVersion: null, calorieTarget: "1", proteinTarget: "NaN" },
    { ...command, userId },
    { ...command, operationId: "caller" },
  ])(
    "rejects invalid or internal fields before any workflow call: %j",
    async (invalid) => {
      await expect(run(invalid)).rejects.toBeInstanceOf(
        InvalidSetAccountNutritionTargetsCommandError,
      );
      expect(workflow).not.toHaveBeenCalled();
    },
  );

  it("does not convert expected conflicts into success", async () => {
    const conflict = new Error("stale");
    workflow.mockRejectedValueOnce(conflict);
    await expect(run()).rejects.toBe(conflict);
  });
});
