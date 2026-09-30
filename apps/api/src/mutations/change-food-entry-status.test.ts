import {
  changeFoodEntryStatus,
  createFoodEntry,
  DomainValidationError,
  type FoodEntry,
  type FoodEntryStatus,
} from "@cal-calc/domain";
import {
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
  SemanticOperationIdempotencyConflictError,
  updateFoodEntryExactlyOnce,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  changeFoodEntryStatusMutation,
  type ChangeFoodEntryStatusCommand,
} from "./change-food-entry-status.js";
import {
  deriveMutationIdentity,
  parseIdempotencyKey,
} from "./mutation-identity.js";

vi.mock("@cal-calc/persistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cal-calc/persistence")>()),
  updateFoodEntryExactlyOnce: vi.fn(),
}));

const userId = "10000000-0000-4000-8000-000000000001";
const entryId = "20000000-0000-4000-8000-000000000001";
const foodDayId = "30000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-29T00:00:00Z";
const key = parseIdempotencyKey("change-status");
const command: ChangeFoodEntryStatusCommand = {
  entryId: ` ${entryId} `,
  expectedRevision: 1,
  status: "CONFIRMED_CONSUMED",
};
const current = createFoodEntry({
  id: entryId,
  foodDayId,
  rawUserDescription: "  pasta later  ",
  displayName: "  Pasta  ",
  quantity: { amount: "1.5", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "400", protein: "20" },
  },
  evidenceClass: "SOURCED",
  status: "PLANNED",
});
const runner: PostgresTransactionRunner = {
  async runInTransaction() {
    throw new Error("Mock workflow must not execute a transaction.");
  },
};
const workflow = vi.mocked(updateFoodEntryExactlyOnce);

function workflowResult(
  input: Parameters<typeof updateFoodEntryExactlyOnce>[1],
  entry: FoodEntry,
  disposition: "APPLIED" | "REPLAYED" = "APPLIED",
) {
  return {
    disposition,
    entry: {
      entry,
      userId: input.userId,
      reportedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    operation: {
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
      status: "SUCCEEDED" as const,
      result: {
        kind: "FOOD_ENTRY_UPDATED",
        entryId: entry.id,
        appliedRevision: entry.revision,
      },
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    },
    appliedRevision: entry.revision,
  };
}

function applyCreated(
  input: Parameters<typeof updateFoodEntryExactlyOnce>[1],
  canonical: FoodEntry = current,
) {
  // Mock only the CREATED branch; persistence ordering is covered elsewhere.
  input.validateCurrent?.(canonical);
  if (canonical.revision !== input.expectedRevision) {
    throw new FoodEntryRevisionConflictError(
      input.entryId,
      input.expectedRevision,
      canonical.revision,
    );
  }
  return workflowResult(input, input.transform(canonical));
}

beforeEach(() => {
  workflow.mockReset();
  workflow.mockImplementation(async (_runner, input) => applyCreated(input));
});

function run(value: ChangeFoodEntryStatusCommand = command, retry = key) {
  return changeFoodEntryStatusMutation(
    { transactionRunner: runner },
    { trustedUserId: userId, idempotencyKey: retry, command: value },
  );
}

describe("changeFoodEntryStatusMutation", () => {
  it("hardcodes status action and applies PLANNED to CONFIRMED_CONSUMED using the canonical entry", async () => {
    const result = await run();
    const sent = workflow.mock.calls[0]![1];
    expect(workflow.mock.calls[0]![0]).toBe(runner);
    expect(sent.userId).toBe(userId);
    expect(sent.entryId).toBe(entryId);
    expect(sent.expectedRevision).toBe(1);
    expect(sent).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "CHANGE_FOOD_ENTRY_STATUS",
        idempotencyKey: key,
        semanticPayload: {
          entryId,
          expectedRevision: 1,
          status: "CONFIRMED_CONSUMED",
        },
      }),
    );
    expect(sent.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result).toEqual({
      disposition: "APPLIED",
      entry: {
        ...current,
        status: "CONFIRMED_CONSUMED",
        revision: 2,
      },
      appliedRevision: 2,
    });
    expect(Object.keys(result).sort()).toEqual([
      "appliedRevision",
      "disposition",
      "entry",
    ]);
  });

  it("changes confirmed to planned and another non-confirmed status without changing content", async () => {
    const confirmed = { ...current, status: "CONFIRMED_CONSUMED" as const };
    workflow.mockImplementationOnce(async (_runner, input) =>
      applyCreated(input, confirmed),
    );
    const planned = await run({ ...command, status: "PLANNED" });
    expect(planned.entry).toEqual({
      ...confirmed,
      status: "PLANNED",
      revision: 2,
    });

    const considered = { ...current, status: "CONSIDERED" as const };
    workflow.mockImplementationOnce(async (_runner, input) =>
      applyCreated(input, considered),
    );
    const discarded = await run({ ...command, status: "DISCARDED" });
    expect(discarded.entry).toEqual({
      ...considered,
      status: "DISCARDED",
      revision: 2,
    });
  });

  it("preserves the domain's same-status rejection, with no update result", async () => {
    await expect(run({ ...command, status: "PLANNED" })).rejects.toThrow(
      DomainValidationError,
    );
    expect(() => workflow.mock.calls[0]![1].transform(current)).toThrow(
      "Food entry status did not change.",
    );
  });

  it("propagates stale revision conflict before the transform", async () => {
    const advanced = changeFoodEntryStatus(current, {
      expectedRevision: 1,
      status: "CONSIDERED",
    });
    if (!advanced.ok) throw new Error("Unexpected fixture conflict.");
    const transform = vi.fn();
    workflow.mockImplementationOnce(async (_runner, input) => {
      expect(input.expectedRevision).toBe(1);
      if (advanced.value.revision !== input.expectedRevision) {
        throw new FoodEntryRevisionConflictError(
          input.entryId,
          input.expectedRevision,
          advanced.value.revision,
        );
      }
      transform(input.transform(advanced.value));
      throw new Error("Unexpected success.");
    });
    await expect(run()).rejects.toMatchObject({
      name: "FoodEntryRevisionConflictError",
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(transform).not.toHaveBeenCalled();
  });

  it("keeps retry identity stable for equivalent commands and changes fingerprint for changed meaning", async () => {
    workflow.mockImplementation(async (_runner, input) =>
      workflowResult(input, current),
    );
    await run();
    await run({ ...command, entryId });
    await run({ ...command, status: "DISCARDED" });
    await run({ ...command, expectedRevision: 2 });
    const [first, same, differentStatus, differentRevision] =
      workflow.mock.calls.map((call) => call[1]);
    expect(same?.operationKey).toBe(first?.operationKey);
    expect(same?.requestFingerprint).toBe(first?.requestFingerprint);
    expect(differentStatus?.operationKey).toBe(first?.operationKey);
    expect(differentStatus?.requestFingerprint).not.toBe(
      first?.requestFingerprint,
    );
    expect(differentRevision?.operationKey).toBe(first?.operationKey);
    expect(differentRevision?.requestFingerprint).not.toBe(
      first?.requestFingerprint,
    );
  });

  it("maps the workflow's exact replay without re-running the domain transform", async () => {
    workflow.mockImplementationOnce(async (_runner, input) =>
      workflowResult(
        input,
        { ...current, status: "CONFIRMED_CONSUMED", revision: 2 },
        "REPLAYED",
      ),
    );
    const replayed = await run();
    expect(replayed).toMatchObject({
      disposition: "REPLAYED",
      appliedRevision: 2,
      entry: { status: "CONFIRMED_CONSUMED", revision: 2 },
    });
  });

  it("propagates an idempotency conflict and ownership-scoped missing entry", async () => {
    workflow.mockRejectedValueOnce(
      new SemanticOperationIdempotencyConflictError(
        "private-operation",
        "old-fingerprint",
        "new-fingerprint",
      ),
    );
    await expect(run()).rejects.toBeInstanceOf(
      SemanticOperationIdempotencyConflictError,
    );
    workflow.mockRejectedValueOnce(new FoodEntryNotFoundError(entryId));
    await expect(run()).rejects.toBeInstanceOf(FoodEntryNotFoundError);
  });

  it("binds trusted FoodDay scope and rejects a foreign canonical FoodDay before revision disclosure", async () => {
    const scoped = {
      trustedUserId: userId,
      idempotencyKey: key,
      operationScope: "FOOD_DAY_TURN_TOOL" as const,
      trustedFoodDayId: foodDayId,
      command,
    };
    await changeFoodEntryStatusMutation({ transactionRunner: runner }, scoped);
    const sent = workflow.mock.calls[0]![1];
    expect(sent.operationKey).toMatch(/^calcalc:v1:FOOD_DAY_TURN_TOOL:/);
    expect(sent).toMatchObject(
      deriveMutationIdentity({
        trustedUserId: userId,
        action: "CHANGE_FOOD_ENTRY_STATUS",
        idempotencyKey: key,
        operationScope: "FOOD_DAY_TURN_TOOL",
        semanticPayload: {
          entryId,
          expectedRevision: 1,
          status: "CONFIRMED_CONSUMED",
          trustedFoodDayId: foodDayId,
        },
      }),
    );
    const foreign = {
      ...current,
      foodDayId: "40000000-0000-4000-8000-000000000001",
      revision: 3,
    };
    workflow.mockImplementationOnce(async (_runner, input) =>
      applyCreated(input, foreign),
    );
    await expect(
      changeFoodEntryStatusMutation({ transactionRunner: runner }, scoped),
    ).rejects.toBeInstanceOf(FoodEntryNotFoundError);
  });

  it("rejects malformed, unknown, and internal caller fields before calling persistence", async () => {
    for (const invalid of [
      { ...command, status: "UNKNOWN" as FoodEntryStatus },
      { ...command, expectedRevision: 0 },
      { ...command, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...command, operationKey: "forged" },
      { ...command, userId },
      { ...command, resultingRevision: 20 },
    ]) {
      await expect(run(invalid)).rejects.toBeInstanceOf(DomainValidationError);
    }
    expect(workflow).not.toHaveBeenCalled();
  });
});
