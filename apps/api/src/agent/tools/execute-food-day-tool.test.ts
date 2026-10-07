import { createFoodEntry, DomainValidationError } from "@cal-calc/domain";
import {
  FoodDayCompletenessConflictError,
  SemanticOperationIdempotencyConflictError,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFoodEntryMutation } from "../../mutations/create-food-entry.js";
import { changeFoodEntryStatusMutation } from "../../mutations/change-food-entry-status.js";
import { logBodyWeightMutation } from "../../mutations/log-body-weight.js";
import { deriveMutationIdentity } from "../../mutations/mutation-identity.js";
import { parseIdempotencyKey } from "../../mutations/mutation-identity.js";
import { removeFoodEntryMutation } from "../../mutations/remove-food-entry.js";
import { setFoodDayCompletenessMutation } from "../../mutations/set-food-day-completeness.js";
import { updateFoodEntryMutation } from "../../mutations/update-food-entry.js";
import { ToolValidationError } from "./food-day-tools.js";
import { executeFoodDayTool } from "./execute-food-day-tool.js";

vi.mock("../../mutations/create-food-entry.js", () => ({
  createFoodEntryMutation: vi.fn(),
}));
vi.mock("../../mutations/update-food-entry.js", () => ({
  updateFoodEntryMutation: vi.fn(),
}));
vi.mock("../../mutations/remove-food-entry.js", () => ({
  removeFoodEntryMutation: vi.fn(),
}));
vi.mock("../../mutations/change-food-entry-status.js", () => ({
  changeFoodEntryStatusMutation: vi.fn(),
}));
vi.mock("../../mutations/set-food-day-completeness.js", () => ({
  setFoodDayCompletenessMutation: vi.fn(),
}));
vi.mock("../../mutations/log-body-weight.js", () => ({
  logBodyWeightMutation: vi.fn(),
}));

const createMutation = vi.mocked(createFoodEntryMutation);
const updateMutation = vi.mocked(updateFoodEntryMutation);
const removeMutation = vi.mocked(removeFoodEntryMutation);
const statusMutation = vi.mocked(changeFoodEntryStatusMutation);
const completenessMutation = vi.mocked(setFoodDayCompletenessMutation);
const weightMutation = vi.mocked(logBodyWeightMutation);
const trustedContext = {
  trustedUserId: "10000000-0000-4000-8000-000000000001",
  foodDayId: "20000000-0000-4000-8000-000000000001",
  idempotencyKey: parseIdempotencyKey("trusted-retry-key"),
  stateCompleteness: "PARTIAL" as const,
  userMessage: "On 2026-10-05 I weighed 178.5 lb.",
};
const runner: PostgresTransactionRunner = {
  async runInTransaction() {
    throw new Error("The mocked mutation should own transaction execution.");
  },
};
const dependencies = { transactionRunner: runner };
const entry = createFoodEntry({
  id: "30000000-0000-4000-8000-000000000001",
  foodDayId: trustedContext.foodDayId,
  rawUserDescription: "Lunch",
  displayName: "Lunch",
  quantity: { amount: "1", unit: "SERVING" },
  nutritionBasis: {
    amount: "1",
    unit: "SERVING",
    nutrition: { calories: "685.1075", protein: "41.0025" },
  },
  evidenceClass: "EXACT",
  status: "CONFIRMED_CONSUMED",
});
const logCall = {
  name: "LOG_FOOD",
  arguments: {
    rawUserDescription: " Lunch ",
    displayName: " Lunch ",
    quantity: { amount: "01.00", unit: "SERVING" },
    nutritionBasis: {
      amount: "1.0",
      unit: "SERVING",
      nutrition: { calories: "685.107500", protein: "41.00250" },
    },
    evidenceClass: "EXACT",
  },
};
const updateCall = {
  name: "UPDATE_FOOD_QUANTITY",
  arguments: {
    entryId: entry.id,
    expectedRevision: 1,
    quantity: { amount: "2.00", unit: "SERVING" },
    overrideAction: { type: "PRESERVE" },
  },
};
const removeCall = {
  name: "REMOVE_FOOD",
  arguments: { entryId: entry.id, expectedRevision: 1 },
};
const statusCall = {
  name: "CHANGE_FOOD_STATUS",
  arguments: {
    entryId: entry.id,
    expectedRevision: 1,
    status: "PLANNED",
  },
};

function weightCall(localDate: string, sourceUnit: "KG" | "LB" = "KG") {
  return {
    name: "LOG_BODY_WEIGHT",
    arguments: { localDate, sourceValue: "80", sourceUnit },
  };
}

function mockWeightResult(localDate: string) {
  weightMutation.mockResolvedValueOnce({
    disposition: "CREATED",
    weightEntry: {
      id: "40000000-0000-4000-8000-000000000001",
      localDate,
      sourceValue: "80",
      sourceUnit: "KG",
      weightKg: "80",
      createdAt: "2026-10-06T12:00:00Z",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeFoodDayTool", () => {
  it("validates LOG_FOOD and injects trusted user, day, retry identity, and operation scope", async () => {
    const authoritative = { disposition: "CREATED" as const, entry };
    createMutation.mockResolvedValueOnce(authoritative);

    const output = await executeFoodDayTool(
      dependencies,
      trustedContext,
      logCall,
    );

    expect(createMutation).toHaveBeenCalledExactlyOnceWith(dependencies, {
      trustedUserId: trustedContext.trustedUserId,
      idempotencyKey: trustedContext.idempotencyKey,
      operationScope: "FOOD_DAY_TURN_TOOL",
      command: {
        foodDayId: trustedContext.foodDayId,
        rawUserDescription: "Lunch",
        displayName: "Lunch",
        quantity: { amount: "1", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "685.1075", protein: "41.0025" },
        },
        evidenceClass: "EXACT",
      },
    });
    expect(output).toEqual({ name: "LOG_FOOD", result: authoritative });
    expect(output.result).toBe(authoritative);
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
    expect(updateMutation).not.toHaveBeenCalled();
    expect(removeMutation).not.toHaveBeenCalled();
  });

  it("passes PLANNED through the existing create mutation and returns authoritative status and revision", async () => {
    const planned = { ...entry, status: "PLANNED" as const };
    const authoritative = { disposition: "CREATED" as const, entry: planned };
    createMutation.mockResolvedValueOnce(authoritative);
    const output = await executeFoodDayTool(dependencies, trustedContext, {
      ...logCall,
      arguments: { ...logCall.arguments, status: "PLANNED" },
    });
    expect(createMutation).toHaveBeenCalledExactlyOnceWith(dependencies, {
      trustedUserId: trustedContext.trustedUserId,
      idempotencyKey: trustedContext.idempotencyKey,
      operationScope: "FOOD_DAY_TURN_TOOL",
      command: {
        foodDayId: trustedContext.foodDayId,
        rawUserDescription: "Lunch",
        displayName: "Lunch",
        quantity: { amount: "1", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "685.1075", protein: "41.0025" },
        },
        evidenceClass: "EXACT",
        status: "PLANNED",
      },
    });
    expect(output).toEqual({ name: "LOG_FOOD", result: authoritative });
    expect(authoritative.entry).toMatchObject({
      id: entry.id,
      status: "PLANNED",
      revision: 1,
    });
  });

  it("delegates quantity correction with trusted day scope and validated override", async () => {
    const authoritative = {
      disposition: "APPLIED" as const,
      entry: { ...entry, revision: 2 },
      appliedRevision: 2,
    };
    updateMutation.mockResolvedValueOnce(authoritative);

    const output = await executeFoodDayTool(
      dependencies,
      trustedContext,
      updateCall,
    );

    expect(updateMutation).toHaveBeenCalledExactlyOnceWith(dependencies, {
      trustedUserId: trustedContext.trustedUserId,
      idempotencyKey: trustedContext.idempotencyKey,
      operationScope: "FOOD_DAY_TURN_TOOL",
      trustedFoodDayId: trustedContext.foodDayId,
      command: {
        entryId: entry.id,
        expectedRevision: 1,
        quantity: { amount: "2", unit: "SERVING" },
        overrideAction: { type: "PRESERVE" },
      },
    });
    expect(output).toEqual({
      name: "UPDATE_FOOD_QUANTITY",
      result: authoritative,
    });
    expect(output.result).toBe(authoritative);
    expect(createMutation).not.toHaveBeenCalled();
    expect(removeMutation).not.toHaveBeenCalled();
  });

  it("delegates removal with trusted day scope without generating deletedAt", async () => {
    const authoritative = {
      disposition: "REPLAYED" as const,
      entry: { ...entry, revision: 2, deletedAt: "2026-09-18T00:00:00Z" },
      appliedRevision: 2,
    };
    removeMutation.mockResolvedValueOnce(authoritative);

    const output = await executeFoodDayTool(
      dependencies,
      trustedContext,
      removeCall,
    );

    expect(removeMutation).toHaveBeenCalledExactlyOnceWith(dependencies, {
      trustedUserId: trustedContext.trustedUserId,
      idempotencyKey: trustedContext.idempotencyKey,
      operationScope: "FOOD_DAY_TURN_TOOL",
      trustedFoodDayId: trustedContext.foodDayId,
      command: { entryId: entry.id, expectedRevision: 1 },
    });
    expect(output).toEqual({ name: "REMOVE_FOOD", result: authoritative });
    expect(output.result).toBe(authoritative);
    expect(createMutation).not.toHaveBeenCalled();
    expect(updateMutation).not.toHaveBeenCalled();
  });

  it("delegates status change with parsed command and trusted context, preserving its authoritative result", async () => {
    const authoritative = {
      disposition: "APPLIED" as const,
      entry: { ...entry, status: "PLANNED" as const, revision: 2 },
      appliedRevision: 2,
    };
    statusMutation.mockResolvedValueOnce(authoritative);
    const output = await executeFoodDayTool(
      dependencies,
      trustedContext,
      statusCall,
    );
    expect(statusMutation).toHaveBeenCalledExactlyOnceWith(dependencies, {
      trustedUserId: trustedContext.trustedUserId,
      idempotencyKey: trustedContext.idempotencyKey,
      operationScope: "FOOD_DAY_TURN_TOOL",
      trustedFoodDayId: trustedContext.foodDayId,
      command: statusCall.arguments,
    });
    expect(output).toEqual({
      name: "CHANGE_FOOD_STATUS",
      result: authoritative,
    });
    expect(output.result).toBe(authoritative);
    expect(createMutation).not.toHaveBeenCalled();
    expect(updateMutation).not.toHaveBeenCalled();
    expect(removeMutation).not.toHaveBeenCalled();
  });

  it.each(["PARTIAL", "USER_DECLARED_COMPLETE"] as const)(
    "delegates completeness target %s with the trusted STATE precondition",
    async (targetCompleteness) => {
      const authoritative = {
        disposition: "APPLIED" as const,
        foodDayId: trustedContext.foodDayId,
        completeness: targetCompleteness,
      };
      completenessMutation.mockResolvedValueOnce(authoritative);
      const output = await executeFoodDayTool(dependencies, trustedContext, {
        name: "SET_FOOD_DAY_COMPLETENESS",
        arguments: { targetCompleteness },
      });
      expect(completenessMutation).toHaveBeenCalledExactlyOnceWith(
        dependencies,
        {
          trustedUserId: trustedContext.trustedUserId,
          trustedFoodDayId: trustedContext.foodDayId,
          idempotencyKey: trustedContext.idempotencyKey,
          operationScope: "FOOD_DAY_TURN_TOOL",
          command: {
            expectedCompleteness: "PARTIAL",
            targetCompleteness,
          },
        },
      );
      expect(output).toEqual({
        name: "SET_FOOD_DAY_COMPLETENESS",
        result: authoritative,
      });
      expect(output.result).toBe(authoritative);
      expect(JSON.parse(JSON.stringify(output))).toEqual(output);
    },
  );

  it("rejects model-supplied completeness scope and preconditions before mutation", async () => {
    for (const field of [
      "expectedCompleteness",
      "foodDayId",
      "trustedUserId",
      "idempotencyKey",
      "operationKey",
    ]) {
      await expect(
        executeFoodDayTool(dependencies, trustedContext, {
          name: "SET_FOOD_DAY_COMPLETENESS",
          arguments: {
            targetCompleteness: "USER_DECLARED_COMPLETE",
            [field]: "attacker",
          },
        }),
      ).rejects.toBeInstanceOf(ToolValidationError);
    }
    expect(completenessMutation).not.toHaveBeenCalled();
  });

  it("passes only validated weight data with trusted identity, child key, and tool scope", async () => {
    const authoritative = {
      disposition: "CREATED" as const,
      weightEntry: {
        id: "40000000-0000-4000-8000-000000000001",
        localDate: "2026-10-05",
        sourceValue: "178.5",
        sourceUnit: "LB" as const,
        weightKg: "80.966238045",
        createdAt: "2026-10-05T12:00:00Z",
      },
    };
    weightMutation.mockResolvedValueOnce(authoritative);
    const output = await executeFoodDayTool(dependencies, trustedContext, {
      name: "LOG_BODY_WEIGHT",
      arguments: {
        localDate: "2026-10-05",
        sourceValue: "178.5",
        sourceUnit: "LB",
      },
    });
    expect(weightMutation).toHaveBeenCalledExactlyOnceWith(dependencies, {
      trustedUserId: trustedContext.trustedUserId,
      idempotencyKey: trustedContext.idempotencyKey,
      operationScope: "FOOD_DAY_TURN_TOOL",
      command: {
        localDate: "2026-10-05",
        sourceValue: "178.5",
        sourceUnit: "LB",
      },
    });
    expect(output).toEqual({ name: "LOG_BODY_WEIGHT", result: authoritative });
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
  });

  it.each([
    "I weighed 178.5 lb today.",
    "Yesterday I was 178.5 lb.",
    "I weigh 178.5 lb.",
    "On 2026-10-04 I weighed 178.5 lb.",
    "On 2026-10-050 I weighed 178.5 lb.",
    "On 12026-10-05 I weighed 178.5 lb.",
    "On 2026-10-05abc I weighed 178.5 lb.",
    "On 2026-10-05-other I weighed 178.5 lb.",
  ])(
    "does not mutate without the same explicit date in the current message: %s",
    async (userMessage) => {
      await expect(
        executeFoodDayTool(
          dependencies,
          { ...trustedContext, userMessage },
          {
            name: "LOG_BODY_WEIGHT",
            arguments: {
              localDate: "2026-10-05",
              sourceValue: "178.5",
              sourceUnit: "LB",
            },
          },
        ),
      ).rejects.toBeInstanceOf(ToolValidationError);
      expect(weightMutation).not.toHaveBeenCalled();
    },
  );

  it("ignores a date supplied only by prior transcript data", async () => {
    const contextWithHistory = {
      ...trustedContext,
      userMessage: "I weighed 80 kg today.",
      recentTranscript: [
        { userMessage: "On 2026-10-05 I weighed 79 kg.", response: "Noted." },
      ],
    };
    await expect(
      executeFoodDayTool(dependencies, contextWithHistory, {
        name: "LOG_BODY_WEIGHT",
        arguments: {
          localDate: "2026-10-05",
          sourceValue: "80",
          sourceUnit: "KG",
        },
      }),
    ).rejects.toBeInstanceOf(ToolValidationError);
    expect(weightMutation).not.toHaveBeenCalled();
  });

  it.each([
    ["I weighed 80 on 2026-10-05.", "KG"],
    ["I weighed 80 lb on 2026-10-05.", "KG"],
    ["I weighed 80 kg on 2026-10-05.", "LB"],
    ["I weighed 80kgabc on 2026-10-05.", "KG"],
  ] as const)(
    "does not accept an absent or mismatched source unit: %s / %s",
    async (userMessage, sourceUnit) => {
      await expect(
        executeFoodDayTool(
          dependencies,
          { ...trustedContext, userMessage },
          {
            name: "LOG_BODY_WEIGHT",
            arguments: {
              localDate: "2026-10-05",
              sourceValue: "80",
              sourceUnit,
            },
          },
        ),
      ).rejects.toBeInstanceOf(ToolValidationError);
      expect(weightMutation).not.toHaveBeenCalled();
    },
  );

  it("passes the same trusted weight command and child key on execution retry", async () => {
    const authoritative = {
      disposition: "REPLAYED" as const,
      weightEntry: {
        id: "40000000-0000-4000-8000-000000000001",
        localDate: "2026-10-05",
        sourceValue: "178.5",
        sourceUnit: "LB" as const,
        weightKg: "80.966238045",
        createdAt: "2026-10-05T12:00:00Z",
      },
    };
    weightMutation.mockResolvedValue(authoritative);
    const call = {
      name: "LOG_BODY_WEIGHT",
      arguments: {
        localDate: "2026-10-05",
        sourceValue: "178.5",
        sourceUnit: "LB",
      },
    };
    await executeFoodDayTool(dependencies, trustedContext, call);
    const replay = await executeFoodDayTool(dependencies, trustedContext, call);
    expect(weightMutation).toHaveBeenCalledTimes(2);
    expect(weightMutation.mock.calls[0]?.[1]).toEqual(
      weightMutation.mock.calls[1]?.[1],
    );
    expect(replay).toEqual({ name: "LOG_BODY_WEIGHT", result: authoritative });
  });

  it.each(["today", "Today.", "(today)", '"today"'])(
    "accepts standalone %s only at currentLocalDate",
    async (word) => {
      mockWeightResult("2026-10-06");
      await executeFoodDayTool(
        dependencies,
        {
          ...trustedContext,
          userMessage: `I weighed 80 kg ${word}`,
          calendarContext: { currentLocalDate: "2026-10-06" },
        },
        weightCall("2026-10-06"),
      );
      expect(weightMutation).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["2026-10-06", "2026-10-05"],
    ["2026-03-01", "2026-02-28"],
    ["2024-03-01", "2024-02-29"],
    ["2026-01-01", "2025-12-31"],
  ])(
    "accepts yesterday across Gregorian boundary %s",
    async (today, yesterday) => {
      mockWeightResult(yesterday);
      await executeFoodDayTool(
        dependencies,
        {
          ...trustedContext,
          userMessage: "Yesterday, I weighed 80 kg.",
          calendarContext: { currentLocalDate: today },
        },
        weightCall(yesterday),
      );
      expect(weightMutation).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["I weighed 80 kg today.", "2026-10-05"],
    ["Yesterday I weighed 80 kg.", "2026-10-06"],
    ["I weighed 80 kg today.", "2026-10-07"],
    ["I weighed 80 kg todayish.", "2026-10-06"],
    ["I weighed 80 kg notyesterday.", "2026-10-05"],
    ["I weighed 80 kg yesterdays.", "2026-10-05"],
    ["I weighed 80 kg.", "2026-10-06"],
    ["I weighed 80 kg this morning.", "2026-10-06"],
    ["I weighed 80 today.", "2026-10-06"],
    ["Yesterday I was 178.", "2026-10-05"],
    ["I weighed 80 lb today.", "2026-10-06"],
  ])(
    "rejects unsupported date or missing unit evidence: %s",
    async (userMessage, localDate) => {
      await expect(
        executeFoodDayTool(
          dependencies,
          {
            ...trustedContext,
            userMessage,
            calendarContext: { currentLocalDate: "2026-10-06" },
          },
          weightCall(localDate),
        ),
      ).rejects.toBeInstanceOf(ToolValidationError);
      expect(weightMutation).not.toHaveBeenCalled();
    },
  );

  it("does not authorize yesterday outside the supported lower calendar bound", async () => {
    await expect(
      executeFoodDayTool(
        dependencies,
        {
          ...trustedContext,
          userMessage: "Yesterday I was 80 kg.",
          calendarContext: { currentLocalDate: "0001-01-01" },
        },
        weightCall("0000-12-31"),
      ),
    ).rejects.toBeInstanceOf(ToolValidationError);
    expect(weightMutation).not.toHaveBeenCalled();
  });

  it("accepts today at the supported upper calendar bound", async () => {
    mockWeightResult("9999-12-31");
    await executeFoodDayTool(
      dependencies,
      {
        ...trustedContext,
        userMessage: "Today I weighed 80 kg.",
        calendarContext: { currentLocalDate: "9999-12-31" },
      },
      weightCall("9999-12-31"),
    );
    expect(weightMutation).toHaveBeenCalledOnce();
  });

  it.each(["I weighed 80 kg today.", "Yesterday I weighed 80 kg."])(
    "rejects relative %s without accepted calendar context",
    async (userMessage) => {
      await expect(
        executeFoodDayTool(
          dependencies,
          { ...trustedContext, userMessage },
          weightCall("2026-10-06"),
        ),
      ).rejects.toBeInstanceOf(ToolValidationError);
      expect(weightMutation).not.toHaveBeenCalled();
    },
  );

  it("does not use relative words from transcript as current-message evidence", async () => {
    const contextWithHistory = {
      ...trustedContext,
      userMessage: "I weighed 80 kg.",
      calendarContext: { currentLocalDate: "2026-10-06" },
      recentTranscript: [
        { userMessage: "I weighed 79 kg today.", response: "Noted." },
      ],
    };
    await expect(
      executeFoodDayTool(
        dependencies,
        contextWithHistory,
        weightCall("2026-10-06"),
      ),
    ).rejects.toBeInstanceOf(ToolValidationError);
    expect(weightMutation).not.toHaveBeenCalled();
  });

  it("preserves explicit ISO evidence independent of calendar context", async () => {
    mockWeightResult("2026-10-05");
    await executeFoodDayTool(
      dependencies,
      {
        ...trustedContext,
        userMessage: "On 2026-10-05 I weighed 80 kg.",
        calendarContext: { currentLocalDate: "2026-10-06" },
      },
      weightCall("2026-10-05"),
    );
    expect(weightMutation).toHaveBeenCalledOnce();
  });

  it("checks token eligibility, not semantic attachment between clauses", async () => {
    mockWeightResult("2026-10-05");
    await executeFoodDayTool(
      dependencies,
      {
        ...trustedContext,
        userMessage: "My appointment was yesterday, but I weighed 80 kg today.",
        calendarContext: { currentLocalDate: "2026-10-06" },
      },
      weightCall("2026-10-05"),
    );
    expect(weightMutation).toHaveBeenCalledOnce();
  });

  it.each([
    ["On 2026-10-05 I weighed 80kg.", "KG"],
    ["On 2026-10-05 my scale showed 178 pounds.", "LB"],
  ] as const)(
    "accepts an explicit source unit in %s",
    async (userMessage, sourceUnit) => {
      weightMutation.mockResolvedValueOnce({
        disposition: "CREATED",
        weightEntry: {
          id: "40000000-0000-4000-8000-000000000001",
          localDate: "2026-10-05",
          sourceValue: sourceUnit === "KG" ? "80" : "178",
          sourceUnit,
          weightKg: sourceUnit === "KG" ? "80" : "80.73944186",
          createdAt: "2026-10-05T12:00:00Z",
        },
      });
      await executeFoodDayTool(
        dependencies,
        { ...trustedContext, userMessage },
        {
          name: "LOG_BODY_WEIGHT",
          arguments: {
            localDate: "2026-10-05",
            sourceValue: sourceUnit === "KG" ? "80" : "178",
            sourceUnit,
          },
        },
      );
      expect(weightMutation).toHaveBeenCalledOnce();
    },
  );

  it("propagates completeness stale-CAS and fresh same-value errors", async () => {
    const call = {
      name: "SET_FOOD_DAY_COMPLETENESS",
      arguments: { targetCompleteness: "PARTIAL" },
    };
    for (const error of [
      new FoodDayCompletenessConflictError(),
      new DomainValidationError("Food day completeness is already requested."),
    ]) {
      completenessMutation.mockRejectedValueOnce(error);
      await expect(
        executeFoodDayTool(dependencies, trustedContext, call),
      ).rejects.toBe(error);
    }
  });

  it("passes the same trusted child key on retry and leaves conflict detection to the application mutation", async () => {
    const applied = {
      disposition: "APPLIED" as const,
      entry: { ...entry, status: "PLANNED" as const, revision: 2 },
      appliedRevision: 2,
    };
    statusMutation.mockResolvedValueOnce(applied).mockResolvedValueOnce({
      ...applied,
      disposition: "REPLAYED",
    });
    await executeFoodDayTool(dependencies, trustedContext, statusCall);
    const replay = await executeFoodDayTool(
      dependencies,
      trustedContext,
      statusCall,
    );
    expect(replay).toEqual({
      name: "CHANGE_FOOD_STATUS",
      result: { ...applied, disposition: "REPLAYED" },
    });
    expect(statusMutation).toHaveBeenCalledTimes(2);
    expect(statusMutation.mock.calls[0]?.[1]).toEqual(
      statusMutation.mock.calls[1]?.[1],
    );
  });

  it("preserves typed same-status and idempotency errors from the application boundary", async () => {
    const error = new DomainValidationError(
      "Food entry status did not change.",
    );
    statusMutation.mockRejectedValueOnce(error);
    await expect(
      executeFoodDayTool(dependencies, trustedContext, statusCall),
    ).rejects.toBe(error);
    const conflict = new SemanticOperationIdempotencyConflictError(
      "private-operation",
      "old-fingerprint",
      "new-fingerprint",
    );
    statusMutation.mockRejectedValueOnce(conflict);
    await expect(
      executeFoodDayTool(dependencies, trustedContext, {
        ...statusCall,
        arguments: { ...statusCall.arguments, status: "DISCARDED" },
      }),
    ).rejects.toBe(conflict);
    const changed = {
      ...statusCall,
      arguments: { ...statusCall.arguments, status: "DISCARDED" },
    };
    const first = deriveMutationIdentity({
      trustedUserId: trustedContext.trustedUserId,
      action: "CHANGE_FOOD_ENTRY_STATUS",
      operationScope: "FOOD_DAY_TURN_TOOL",
      idempotencyKey: trustedContext.idempotencyKey,
      semanticPayload: {
        ...statusCall.arguments,
        trustedFoodDayId: trustedContext.foodDayId,
      },
    });
    const second = deriveMutationIdentity({
      trustedUserId: trustedContext.trustedUserId,
      action: "CHANGE_FOOD_ENTRY_STATUS",
      operationScope: "FOOD_DAY_TURN_TOOL",
      idempotencyKey: trustedContext.idempotencyKey,
      semanticPayload: {
        ...changed.arguments,
        trustedFoodDayId: trustedContext.foodDayId,
      },
    });
    const crossAction = deriveMutationIdentity({
      trustedUserId: trustedContext.trustedUserId,
      action: "REMOVE_FOOD_ENTRY",
      operationScope: "FOOD_DAY_TURN_TOOL",
      idempotencyKey: trustedContext.idempotencyKey,
      semanticPayload: {
        entryId: entry.id,
        expectedRevision: 1,
        trustedFoodDayId: trustedContext.foodDayId,
      },
    });
    expect(second.operationKey).toBe(first.operationKey);
    expect(second.requestFingerprint).not.toBe(first.requestFingerprint);
    expect(crossAction.operationKey).toBe(first.operationKey);
    expect(crossAction.requestFingerprint).not.toBe(first.requestFingerprint);
  });

  it.each([
    {
      ...logCall,
      arguments: { ...logCall.arguments, foodDayId: "attacker-day" },
    },
    {
      ...removeCall,
      arguments: { ...removeCall.arguments, deletedAt: "2026-09-18" },
    },
    {
      ...updateCall,
      arguments: { ...updateCall.arguments, trustedUserId: "attacker" },
    },
    { ...removeCall, idempotencyKey: "attacker-retry" },
    { ...logCall, operationScope: "FOOD_DAY_TURN_TOOL" },
    {
      ...logCall,
      arguments: { ...logCall.arguments, operationScope: "FOOD_DAY_TURN_TOOL" },
    },
    {
      ...updateCall,
      arguments: {
        ...updateCall.arguments,
        operationScope: "FOOD_DAY_TURN_TOOL",
      },
    },
    {
      ...removeCall,
      arguments: {
        ...removeCall.arguments,
        operationScope: "FOOD_DAY_TURN_TOOL",
      },
    },
    { ...updateCall, trustedFoodDayId: trustedContext.foodDayId },
    {
      ...updateCall,
      arguments: {
        ...updateCall.arguments,
        trustedFoodDayId: trustedContext.foodDayId,
      },
    },
    {
      ...removeCall,
      arguments: {
        ...removeCall.arguments,
        trustedFoodDayId: trustedContext.foodDayId,
      },
    },
  ])(
    "rejects model-supplied trusted/internal fields before mutation",
    async (call) => {
      await expect(
        executeFoodDayTool(dependencies, trustedContext, call),
      ).rejects.toBeInstanceOf(ToolValidationError);
      expect(createMutation).not.toHaveBeenCalled();
      expect(updateMutation).not.toHaveBeenCalled();
      expect(removeMutation).not.toHaveBeenCalled();
    },
  );

  it("propagates an existing typed application error unchanged", async () => {
    const error = new DomainValidationError("Invalid canonical correction.");
    updateMutation.mockRejectedValueOnce(error);

    await expect(
      executeFoodDayTool(dependencies, trustedContext, updateCall),
    ).rejects.toBe(error);
  });
});
