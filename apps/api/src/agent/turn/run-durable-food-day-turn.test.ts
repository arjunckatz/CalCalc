import {
  FoodDayTurnIdempotencyConflictError,
  type CompletedFoodDayTurnStore,
  type PersistedFoodDayTurnResult,
} from "@cal-calc/persistence";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseIdempotencyKey } from "../../mutations/mutation-identity.js";
import type { FoodDayTurnInput } from "./food-day-turn-types.js";
import { deriveFoodDayTurnIdentity } from "./food-day-turn-identity.js";
import { runDurableFoodDayTurn } from "./run-durable-food-day-turn.js";

const input: FoodDayTurnInput = {
  trustedUserId: "10000000-0000-4000-8000-000000000001",
  foodDayId: "20000000-0000-4000-8000-000000000001",
  turnIdempotencyKey: parseIdempotencyKey("trusted-turn-key"),
  userMessage: "  Log my lunch.  ",
};
const stored: PersistedFoodDayTurnResult = {
  id: "30000000-0000-4000-8000-000000000001",
  userId: input.trustedUserId,
  foodDayId: input.foodDayId,
  turnKey: deriveFoodDayTurnIdentity(input).turnKey,
  requestFingerprint: deriveFoodDayTurnIdentity(input).requestFingerprint,
  userMessage: input.userMessage,
  response: "Stored response.",
  createdAt: "2026-09-28T00:00:00.000Z",
};

const findCompleted = vi.fn<CompletedFoodDayTurnStore["findCompleted"]>();
const saveCompleted = vi.fn<CompletedFoodDayTurnStore["saveCompleted"]>();
const loadRecentTranscript = vi.fn(async () => []);
const runTurn = vi.fn(async () => {
  await loadRecentTranscript();
  return { response: "Generated response." };
});

beforeEach(() => {
  vi.resetAllMocks();
  findCompleted.mockResolvedValue(null);
  saveCompleted.mockImplementation(async (saved) => ({
    disposition: "CREATED",
    turn: {
      id: saved.id,
      userId: saved.userId,
      foodDayId: saved.foodDayId,
      turnKey: saved.turnKey,
      requestFingerprint: saved.requestFingerprint,
      userMessage: saved.userMessage,
      response: saved.response,
      createdAt: "2026-09-28T00:00:00.000Z",
    },
  }));
});

function dependencies() {
  return {
    completedTurns: { findCompleted, saveCompleted },
    runTurn,
  };
}

describe("runDurableFoodDayTurn", () => {
  it("runs a missed turn once and persists its exact message with the public response", async () => {
    await expect(runDurableFoodDayTurn(dependencies(), input)).resolves.toEqual(
      { response: "Generated response." },
    );

    const identity = deriveFoodDayTurnIdentity(input);
    expect(findCompleted).toHaveBeenCalledExactlyOnceWith({
      userId: identity.canonicalUserId,
      foodDayId: identity.canonicalFoodDayId,
      turnKey: identity.turnKey,
      requestFingerprint: identity.requestFingerprint,
    });
    expect(runTurn).toHaveBeenCalledExactlyOnceWith(input);
    expect(saveCompleted).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(String),
      userId: identity.canonicalUserId,
      foodDayId: identity.canonicalFoodDayId,
      turnKey: identity.turnKey,
      requestFingerprint: identity.requestFingerprint,
      userMessage: input.userMessage,
      response: "Generated response.",
    });
  });

  it("returns an existing completed response without running or saving", async () => {
    findCompleted.mockResolvedValueOnce(stored);

    await expect(runDurableFoodDayTurn(dependencies(), input)).resolves.toEqual(
      { response: "Stored response." },
    );
    expect(runTurn).not.toHaveBeenCalled();
    expect(loadRecentTranscript).not.toHaveBeenCalled();
    expect(saveCompleted).not.toHaveBeenCalled();
  });

  it("replays the same dated request without invoking the model or tools", async () => {
    const dated = {
      ...input,
      userMessage: "I weighed 80 kg today.",
      calendarContext: { currentLocalDate: "2026-10-06" },
    };
    const identity = deriveFoodDayTurnIdentity(dated);
    findCompleted.mockResolvedValueOnce({
      ...stored,
      requestFingerprint: identity.requestFingerprint,
      userMessage: dated.userMessage,
    });
    await expect(runDurableFoodDayTurn(dependencies(), dated)).resolves.toEqual(
      { response: "Stored response." },
    );
    expect(findCompleted).toHaveBeenCalledExactlyOnceWith({
      userId: identity.canonicalUserId,
      foodDayId: identity.canonicalFoodDayId,
      turnKey: identity.turnKey,
      requestFingerprint: identity.requestFingerprint,
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(loadRecentTranscript).not.toHaveBeenCalled();
    expect(saveCompleted).not.toHaveBeenCalled();
  });

  it("conflicts on a changed calendar date before any model or tool work", async () => {
    const original = {
      ...input,
      userMessage: "I weighed 80 kg today.",
      calendarContext: { currentLocalDate: "2026-10-06" },
    };
    const changed = {
      ...original,
      calendarContext: { currentLocalDate: "2026-10-07" },
    };
    const firstIdentity = deriveFoodDayTurnIdentity(original);
    const changedIdentity = deriveFoodDayTurnIdentity(changed);
    expect(changedIdentity.turnKey).toBe(firstIdentity.turnKey);
    expect(changedIdentity.requestFingerprint).not.toBe(
      firstIdentity.requestFingerprint,
    );
    findCompleted.mockRejectedValueOnce(
      new FoodDayTurnIdempotencyConflictError(
        changedIdentity.turnKey,
        firstIdentity.requestFingerprint,
        changedIdentity.requestFingerprint,
      ),
    );
    await expect(
      runDurableFoodDayTurn(dependencies(), changed),
    ).rejects.toBeInstanceOf(FoodDayTurnIdempotencyConflictError);
    expect(findCompleted).toHaveBeenCalledExactlyOnceWith({
      userId: changedIdentity.canonicalUserId,
      foodDayId: changedIdentity.canonicalFoodDayId,
      turnKey: changedIdentity.turnKey,
      requestFingerprint: changedIdentity.requestFingerprint,
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(loadRecentTranscript).not.toHaveBeenCalled();
    expect(saveCompleted).not.toHaveBeenCalled();
  });

  it("keeps the accepted date fixed across lookup and execution", async () => {
    const dated = {
      ...input,
      calendarContext: { currentLocalDate: "2026-10-06" },
    };
    const identity = deriveFoodDayTurnIdentity(dated);
    findCompleted.mockImplementationOnce(async () => {
      dated.calendarContext.currentLocalDate = "2026-10-07";
      return null;
    });
    await runDurableFoodDayTurn(dependencies(), dated);
    expect(findCompleted.mock.calls[0]?.[0].requestFingerprint).toBe(
      identity.requestFingerprint,
    );
    expect(runTurn).toHaveBeenCalledExactlyOnceWith({
      ...dated,
      calendarContext: { currentLocalDate: "2026-10-06" },
    });
  });

  it("returns the first persisted response when a concurrent save loses", async () => {
    saveCompleted.mockResolvedValueOnce({
      disposition: "EXISTING",
      turn: stored,
    });

    await expect(runDurableFoodDayTurn(dependencies(), input)).resolves.toEqual(
      { response: "Stored response." },
    );
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("propagates changed-message idempotency conflicts before model execution", async () => {
    const changed = { ...input, userMessage: "Log a different lunch." };
    const identity = deriveFoodDayTurnIdentity(changed);
    findCompleted.mockRejectedValueOnce(
      new FoodDayTurnIdempotencyConflictError(
        identity.turnKey,
        stored.requestFingerprint,
        identity.requestFingerprint,
      ),
    );

    await expect(
      runDurableFoodDayTurn(dependencies(), changed),
    ).rejects.toBeInstanceOf(FoodDayTurnIdempotencyConflictError);
    expect(runTurn).not.toHaveBeenCalled();
    expect(loadRecentTranscript).not.toHaveBeenCalled();
    expect(saveCompleted).not.toHaveBeenCalled();
  });

  it("does not cross-replay the same external key across FoodDays", async () => {
    const changed = {
      ...input,
      foodDayId: "20000000-0000-4000-8000-000000000002",
    };
    await runDurableFoodDayTurn(dependencies(), input);
    await runDurableFoodDayTurn(dependencies(), changed);

    expect(findCompleted.mock.calls[0]?.[0].turnKey).not.toBe(
      findCompleted.mock.calls[1]?.[0].turnKey,
    );
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it("does not cross-replay the same external key across users", async () => {
    const changed = {
      ...input,
      trustedUserId: "10000000-0000-4000-8000-000000000002",
    };
    await runDurableFoodDayTurn(dependencies(), input);
    await runDurableFoodDayTurn(dependencies(), changed);

    expect(findCompleted.mock.calls[0]?.[0].turnKey).not.toBe(
      findCompleted.mock.calls[1]?.[0].turnKey,
    );
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it("does not persist a completed result when the underlying runner fails", async () => {
    const failure = new Error("model failed");
    runTurn.mockRejectedValueOnce(failure);

    await expect(runDurableFoodDayTurn(dependencies(), input)).rejects.toBe(
      failure,
    );
    expect(saveCompleted).not.toHaveBeenCalled();
  });

  it("propagates persistence failure after successful model execution", async () => {
    const failure = new Error("completed-result insert failed");
    saveCompleted.mockRejectedValueOnce(failure);

    await expect(runDurableFoodDayTurn(dependencies(), input)).rejects.toBe(
      failure,
    );
    expect(runTurn).toHaveBeenCalledTimes(1);
  });
});

describe("deriveFoodDayTurnIdentity", () => {
  it("preserves the legacy request fingerprint when calendar context is omitted", () => {
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          "calcalc:food-day-turn:request",
          "v1",
          input.trustedUserId,
          input.foodDayId,
          input.userMessage,
        ]),
        "utf8",
      )
      .digest("hex");
    expect(deriveFoodDayTurnIdentity(input).requestFingerprint).toBe(expected);
  });

  it.each(["2026-02-30", "2026-2-05", " 2026-10-06", "2026-10-06T00:00:00Z"])(
    "rejects malformed calendar context %s before durable lookup",
    (currentLocalDate) => {
      expect(() =>
        deriveFoodDayTurnIdentity({
          ...input,
          calendarContext: { currentLocalDate },
        }),
      ).toThrowError(
        expect.objectContaining({ reason: "INVALID_CALENDAR_CONTEXT" }),
      );
    },
  );

  it("canonicalizes UUID text before deriving the same logical identity", () => {
    const upper = deriveFoodDayTurnIdentity({
      ...input,
      trustedUserId: input.trustedUserId.toUpperCase(),
      foodDayId: input.foodDayId.toUpperCase(),
    });
    expect(upper).toEqual(deriveFoodDayTurnIdentity(input));
  });

  it("binds exact accepted message text only to the request fingerprint", () => {
    const changed = deriveFoodDayTurnIdentity({
      ...input,
      userMessage: ` ${input.userMessage} `,
    });
    const original = deriveFoodDayTurnIdentity(input);
    expect(changed.turnKey).toBe(original.turnKey);
    expect(changed.requestFingerprint).not.toBe(original.requestFingerprint);
  });

  it("keeps the key stable for the same scope and changes only the fingerprint for a changed message", () => {
    const changed = deriveFoodDayTurnIdentity({
      ...input,
      userMessage: "Corrected semantic request.",
    });
    const original = deriveFoodDayTurnIdentity(input);
    expect(changed.turnKey).toBe(original.turnKey);
    expect(changed.requestFingerprint).not.toBe(original.requestFingerprint);
  });
});
