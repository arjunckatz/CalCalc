import { createFoodDay } from "@cal-calc/domain";
import {
  createFoodDayExactlyOnce,
  SemanticOperationIdempotencyConflictError,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFoodDayMutation,
  parseCreateFoodDayCommand,
} from "./create-food-day.js";
import {
  deriveMutationIdentity,
  parseIdempotencyKey,
} from "./mutation-identity.js";

vi.mock("@cal-calc/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cal-calc/persistence")>()),
  createFoodDayExactlyOnce: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const retry = parseIdempotencyKey("opaque-retry");
const command = {
  calorieTarget: "2400.0",
  proteinTarget: "119.00",
  localDate: "2026-09-10",
  timezone: "UTC",
};
const runner: PostgresTransactionRunner = {
  async runInTransaction() {
    throw new Error("Mock workflow must not execute DB work.");
  },
};
const workflow = vi.mocked(createFoodDayExactlyOnce);
const timestamp = "2026-09-10T00:00:00Z";

beforeEach(() => {
  vi.clearAllMocks();
  workflow.mockImplementation(async (_runner, input) => ({
    disposition: "CREATED",
    foodDay: {
      userId: input.userId,
      foodDay: input.foodDay,
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
      result: { kind: "FOOD_DAY_CREATED", foodDayId: input.foodDay.id },
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    },
  }));
});

function run(value = command, key = retry) {
  return createFoodDayMutation(
    { transactionRunner: runner },
    { trustedUserId: userId, idempotencyKey: key, command: value },
  );
}

describe("createFoodDayMutation", () => {
  it("binds the trusted owner and hardcoded action to normalized semantics and generates IDs", async () => {
    const result = await run();
    const sent = workflow.mock.calls[0]![1];
    expect(workflow.mock.calls[0]![0]).toBe(runner);
    expect(sent.userId).toBe(userId);
    expect(sent).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "CREATE_FOOD_DAY",
        idempotencyKey: retry,
        semanticPayload: {
          calorieTarget: "2400",
          proteinTarget: "119",
          localDate: command.localDate,
          timezone: "UTC",
          status: "OPEN",
          completeness: "UNKNOWN",
        },
      }),
    );
    expect(sent.foodDay).toEqual(
      createFoodDay({
        id: sent.foodDay.id,
        status: "OPEN",
        calorieTarget: "2400",
        proteinTarget: "119",
      }),
    );
    for (const id of [sent.operationId, sent.foodDay.id])
      expect(id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    expect(sent.operationId).not.toBe(sent.foodDay.id);
    expect(sent).not.toHaveProperty("openedAt");
    expect(result).toEqual({
      disposition: "CREATED",
      foodDay: {
        id: sent.foodDay.id,
        status: "OPEN",
        completeness: "UNKNOWN",
        calorieTarget: "2400",
        proteinTarget: "119",
        localDate: command.localDate,
        timezone: "UTC",
        openedAt: timestamp,
        closedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    expect(result).not.toHaveProperty("operation");
    expect(result.foodDay).not.toHaveProperty("userId");
  });

  it("keeps retry identity stable across decimal spelling, generated candidates and DB timestamps", async () => {
    const first = await run();
    const original = workflow.mock.results[0]!;
    const stored = await original.value;
    workflow.mockResolvedValueOnce({
      ...stored,
      disposition: "REPLAYED",
      foodDay: { ...stored.foodDay, updatedAt: "2026-09-11T00:00:00Z" },
    });
    const replay = await run({
      ...command,
      calorieTarget: "2400.00",
      proteinTarget: "119",
    });
    const a = workflow.mock.calls[0]![1];
    const b = workflow.mock.calls[1]![1];
    expect(b.operationKey).toBe(a.operationKey);
    expect(b.requestFingerprint).toBe(a.requestFingerprint);
    expect(b.operationId).not.toBe(a.operationId);
    expect(b.foodDay.id).not.toBe(a.foodDay.id);
    expect(replay.disposition).toBe("REPLAYED");
    expect(replay.foodDay.id).toBe(first.foodDay.id);
    expect(replay.foodDay.openedAt).toBe(timestamp);
    expect(replay.foodDay.updatedAt).toBe("2026-09-11T00:00:00Z");
  });

  it("passes changed meaning to the workflow as the same key/different fingerprint and propagates conflict", async () => {
    await run();
    const first = workflow.mock.calls[0]![1];
    const failure = new SemanticOperationIdempotencyConflictError(
      first.operationKey,
      first.requestFingerprint,
      "different",
    );
    workflow.mockRejectedValueOnce(failure);
    await expect(run({ ...command, calorieTarget: "2500" })).rejects.toBe(
      failure,
    );
    const changed = workflow.mock.calls[1]![1];
    expect(changed.operationKey).toBe(first.operationKey);
    expect(changed.requestFingerprint).not.toBe(first.requestFingerprint);
  });

  it("permits fresh intent on the same date with a new key", async () => {
    const a = await run();
    const b = await run(command, parseIdempotencyKey("new-intent"));
    expect(a.foodDay.id).not.toBe(b.foodDay.id);
    expect(a.foodDay.localDate).toBe(b.foodDay.localDate);
    expect(workflow.mock.calls[0]![1].operationKey).not.toBe(
      workflow.mock.calls[1]![1].operationKey,
    );
    expect(workflow.mock.calls[0]![1].requestFingerprint).toBe(
      workflow.mock.calls[1]![1].requestFingerprint,
    );
  });

  it.each([
    "userId",
    "ownerId",
    "profileId",
    "id",
    "operationId",
    "operationKey",
    "requestFingerprint",
    "status",
    "completeness",
    "openedAt",
    "action",
  ])("rejects command field %s before workflow execution", async (field) => {
    await expect(run({ ...command, [field]: "private-value" })).rejects.toThrow(
      "Invalid FoodDay creation command.",
    );
    expect(workflow).not.toHaveBeenCalled();
  });

  it("ignores extra top-level persistence identity overrides", async () => {
    const result = await createFoodDayMutation(
      { transactionRunner: runner },
      {
        trustedUserId: userId,
        idempotencyKey: retry,
        command,
        ...{
          operationKey: "caller-key",
          requestFingerprint: "caller-fp",
          operationId: "caller-id",
          id: "caller-id",
          userId: "wrong-user",
          action: "OTHER",
        },
      },
    );
    expect(workflow.mock.calls[0]![1].userId).toBe(userId);
    expect(result.foodDay.id).not.toBe("caller-id");
    expect(workflow.mock.calls[0]![1].operationKey).toMatch(
      /^calcalc:v1:CREATE_FOOD_DAY:/,
    );
  });
});

describe("parseCreateFoodDayCommand", () => {
  it("normalizes exact target strings and omitted metadata without changing the input", () => {
    const raw = Object.freeze({
      calorieTarget: " 002400.00 ",
      proteinTarget: "0.1000",
    });
    expect(parseCreateFoodDayCommand(raw)).toEqual({
      calorieTarget: "2400",
      proteinTarget: "0.1",
      localDate: null,
      timezone: null,
    });
    expect(raw.calorieTarget).toBe(" 002400.00 ");
  });
  it.each([
    null,
    [],
    "private",
    {},
    { ...command, calorieTarget: 2400 },
    { ...command, proteinTarget: -1 },
    { ...command, calorieTarget: "NaN" },
    { ...command, calorieTarget: "-1" },
    { ...command, calorieTarget: "1e100000000" },
    { ...command, calorieTarget: "1".repeat(129) },
    { ...command, localDate: "2026-02-29" },
    { ...command, localDate: "0000-01-01" },
    { ...command, timezone: "invalid/private" },
  ])("rejects invalid command (%#)", (raw) => {
    expect(() => parseCreateFoodDayCommand(raw)).toThrow(
      "Invalid FoodDay creation command.",
    );
  });
  it("accepts leap dates and independently absent metadata", () => {
    expect(
      parseCreateFoodDayCommand({
        ...command,
        localDate: "2024-02-29",
        timezone: null,
      }).localDate,
    ).toBe("2024-02-29");
    expect(
      parseCreateFoodDayCommand({ ...command, localDate: null }).timezone,
    ).toBe("UTC");
  });
});
