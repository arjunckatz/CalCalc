import { describe, expect, it, vi } from "vitest";

import { AccountTurnIdempotencyConflictError } from "@cal-calc/persistence";

import { parseIdempotencyKey } from "../mutations/mutation-identity.js";
import { claimAccountTurn, deriveAccountTurnIdentity } from "./account-turn.js";

const user = "10000000-0000-4000-8000-000000000001";
const key = parseIdempotencyKey("retry-one");
const request = {
  trustedUserId: user,
  idempotencyKey: key,
  userMessage: "  Today I ate oats.  ",
  calendarContext: {
    schema: "client-calendar-v1" as const,
    currentLocalDate: "2026-10-13",
  },
};

describe("account turn identity and claim", () => {
  it("uses an account-only versioned key and exact accepted request meaning", () => {
    const first = deriveAccountTurnIdentity(request);
    expect(first.turnKey).toMatch(/^calcalc:account-turn:v1:[a-f0-9]{64}$/);
    expect(first.turnKey).toBe(
      deriveAccountTurnIdentity({ ...request, userMessage: "changed" }).turnKey,
    );
    expect(first.requestFingerprint).not.toBe(
      deriveAccountTurnIdentity({
        ...request,
        userMessage: "Today I ate oats.",
      }).requestFingerprint,
    );
    expect(first.requestFingerprint).not.toBe(
      deriveAccountTurnIdentity({ ...request, calendarContext: null })
        .requestFingerprint,
    );
    expect(first.turnKey).not.toBe(
      deriveAccountTurnIdentity({
        ...request,
        idempotencyKey: parseIdempotencyKey("retry-two"),
      }).turnKey,
    );
    expect(first.userMessage).toBe("  Today I ate oats.  ");
  });

  it("snapshots calendar context before asynchronous claim", async () => {
    const claimPending = vi.fn(async (input: { calendarContext: unknown }) => {
      request.calendarContext.currentLocalDate = "2026-10-14";
      expect(input.calendarContext).toEqual({
        schema: "client-calendar-v1",
        currentLocalDate: "2026-10-13",
      });
      return { disposition: "CREATED" as const, turn: {} as never };
    });
    await claimAccountTurn({ claimPending }, request);
    expect(claimPending).toHaveBeenCalledOnce();
    request.calendarContext.currentLocalDate = "2026-10-13";
  });

  it("rejects invalid context and blank messages before any claim", async () => {
    const claimPending = vi.fn();
    await expect(
      claimAccountTurn({ claimPending }, { ...request, userMessage: " " }),
    ).rejects.toThrow();
    await expect(
      claimAccountTurn(
        { claimPending },
        {
          ...request,
          calendarContext: {
            schema: "client-calendar-v1",
            currentLocalDate: "2026-02-30",
          },
        },
      ),
    ).rejects.toThrow();
    expect(claimPending).not.toHaveBeenCalled();
  });

  it("lets the repository's typed changed-request conflict propagate", async () => {
    const claimPending = vi.fn(async () => {
      throw new AccountTurnIdempotencyConflictError();
    });
    await expect(
      claimAccountTurn({ claimPending }, request),
    ).rejects.toBeInstanceOf(AccountTurnIdempotencyConflictError);
  });
});
