import {
  createBodyWeightExactlyOnce,
  SemanticOperationIdempotencyConflictError,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logBodyWeightMutation } from "./log-body-weight.js";
import {
  deriveMutationIdentity,
  parseIdempotencyKey,
} from "./mutation-identity.js";

vi.mock("@cal-calc/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cal-calc/persistence")>()),
  createBodyWeightExactlyOnce: vi.fn(),
}));

const workflow = vi.mocked(createBodyWeightExactlyOnce);
const userId = "10000000-0000-4000-8000-000000000001";
const key = parseIdempotencyKey("weigh-in-1");
const command = {
  localDate: "2026-10-05",
  sourceValue: "180.2500",
  sourceUnit: "LB" as const,
};
const runner: PostgresTransactionRunner = {
  async runInTransaction() {
    throw new Error("Mocked workflow must not run a transaction.");
  },
};

beforeEach(() => {
  workflow.mockReset();
  workflow.mockImplementation(async (_runner, input) => ({
    disposition: "CREATED",
    weightEntry: {
      entry: input.entry,
      userId: input.userId,
      createdAt: "2026-10-05T12:00:00Z",
    },
    operation: {
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
      status: "SUCCEEDED",
      result: { kind: "BODY_WEIGHT_ENTRY_CREATED", entryId: input.entry.id },
      error: null,
      createdAt: "2026-10-05T12:00:00Z",
      updatedAt: "2026-10-05T12:00:00Z",
      completedAt: "2026-10-05T12:00:00Z",
    },
  }));
});

function run(value: unknown = command, retryKey = key) {
  return logBodyWeightMutation(
    { transactionRunner: runner },
    {
      trustedUserId: userId,
      idempotencyKey: retryKey,
      command: value as typeof command,
    },
  );
}

describe("logBodyWeightMutation", () => {
  it("normalizes before deriving identity and returns only the authoritative observation", async () => {
    const result = await run();
    const sent = workflow.mock.calls[0]![1];
    expect(workflow.mock.calls[0]![0]).toBe(runner);
    expect(sent.userId).toBe(userId);
    expect(sent.entry).toMatchObject({
      localDate: command.localDate,
      sourceValue: "180.25",
      sourceUnit: "LB",
      weightKg: "81.7600246925",
    });
    expect(result).toEqual({
      disposition: "CREATED",
      weightEntry: { ...sent.entry, createdAt: "2026-10-05T12:00:00Z" },
    });
    expect(result.weightEntry).not.toHaveProperty("userId");
  });

  it("keeps exact retries independent of generated IDs and returns the original row", async () => {
    const first = await run();
    const firstCall = workflow.mock.calls[0]![1];
    workflow.mockResolvedValueOnce({
      ...(await workflow.mock.results[0]!.value),
      disposition: "REPLAYED",
    });
    const replay = await run({ ...command, sourceValue: "180.25" });
    const secondCall = workflow.mock.calls[1]![1];
    expect(secondCall.operationKey).toBe(firstCall.operationKey);
    expect(secondCall.requestFingerprint).toBe(firstCall.requestFingerprint);
    expect(secondCall.operationId).not.toBe(firstCall.operationId);
    expect(secondCall.entry.id).not.toBe(firstCall.entry.id);
    expect(replay).toEqual({
      disposition: "REPLAYED",
      weightEntry: first.weightEntry,
    });
  });

  it.each([
    { label: "value", changed: { ...command, sourceValue: "181" } },
    { label: "unit", changed: { ...command, sourceUnit: "KG" } },
    { label: "date", changed: { ...command, localDate: "2026-10-04" } },
  ])(
    "changes the fingerprint, not the operation key, for $label",
    async ({ changed }) => {
      await run();
      const first = workflow.mock.calls[0]![1];
      const conflict = new SemanticOperationIdempotencyConflictError(
        first.operationKey,
        first.requestFingerprint,
        "changed",
      );
      workflow.mockRejectedValueOnce(conflict);
      await expect(run(changed)).rejects.toBe(conflict);
      const second = workflow.mock.calls[1]![1];
      expect(second.operationKey).toBe(first.operationKey);
      expect(second.requestFingerprint).not.toBe(first.requestFingerprint);
    },
  );

  it("treats another retry key as distinct intent for the same local date", async () => {
    await run();
    await run(command, parseIdempotencyKey("weigh-in-2"));
    const first = workflow.mock.calls[0]![1];
    const second = workflow.mock.calls[1]![1];
    expect(second.operationKey).not.toBe(first.operationKey);
    expect(second.requestFingerprint).toBe(first.requestFingerprint);
    expect(second.entry.id).not.toBe(first.entry.id);
  });

  it("uses the shared turn-tool namespace when invoked by a trusted agent slot", async () => {
    await logBodyWeightMutation(
      { transactionRunner: runner },
      {
        trustedUserId: userId,
        idempotencyKey: key,
        operationScope: "FOOD_DAY_TURN_TOOL",
        command,
      },
    );
    const sent = workflow.mock.calls[0]![1];
    const anotherAction = deriveMutationIdentity({
      trustedUserId: userId,
      idempotencyKey: key,
      operationScope: "FOOD_DAY_TURN_TOOL",
      action: "CREATE_FOOD_ENTRY",
      semanticPayload: {},
    });
    expect(sent.operationKey).toBe(anotherAction.operationKey);
    expect(sent.requestFingerprint).not.toBe(anotherAction.requestFingerprint);
    expect(sent.entry.weightKg).toBe("81.7600246925");
  });

  it.each([
    { ...command, sourceValue: "0" },
    { ...command, sourceValue: "-1" },
    { ...command, sourceUnit: "STONE" },
    { ...command, localDate: "2026-02-30" },
    { ...command, userId: "attacker" },
    { ...command, operationId: "attacker" },
    { ...command, createdAt: "2000-01-01" },
  ])(
    "rejects an invalid or internal command before persistence (%#)",
    async (value) => {
      await expect(run(value)).rejects.toThrow();
      expect(workflow).not.toHaveBeenCalled();
    },
  );
});
