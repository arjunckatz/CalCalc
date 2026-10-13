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
    currentLocalDateTime: "2026-10-13T20:34:12+05:30",
    timeZone: "Asia/Kolkata",
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
    expect(first.calendarContext).toMatchObject({
      schema: "client-calendar-v2",
      currentLocalDateTime: "2026-10-13T20:34:12+05:30",
    });
  });

  it("snapshots calendar context before asynchronous claim", async () => {
    const claimPending = vi.fn(async (input: { calendarContext: unknown }) => {
      request.calendarContext.currentLocalDateTime =
        "2026-10-14T20:34:12+05:30";
      expect(input.calendarContext).toMatchObject({
        schema: "client-calendar-v2",
        currentLocalDateTime: "2026-10-13T20:34:12+05:30",
      });
      return { disposition: "CREATED" as const, turn: {} as never };
    });
    await claimAccountTurn({ claimPending }, request);
    expect(claimPending).toHaveBeenCalledOnce();
    request.calendarContext.currentLocalDateTime = "2026-10-13T20:34:12+05:30";
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
            currentLocalDateTime: "2026-02-30T20:34:12+05:30",
            timeZone: "Asia/Kolkata",
          },
        },
      ),
    ).rejects.toThrow();
    expect(claimPending).not.toHaveBeenCalled();
  });

  it("fingerprints canonical accepted context, not raw spelling or any FoodDay", () => {
    const base = deriveAccountTurnIdentity(request);
    const equivalent = deriveAccountTurnIdentity({
      ...request,
      calendarContext: {
        currentLocalDateTime: "2026-10-13t20:34:12.000+05:30",
        timeZone: "ASIA/KOLKATA",
      },
    });
    expect(equivalent.requestFingerprint).toBe(base.requestFingerprint);
    expect(equivalent.calendarContext).toEqual(base.calendarContext);
    expect(
      deriveAccountTurnIdentity({
        ...request,
        calendarContext: {
          ...request.calendarContext,
          currentLocalDateTime: "2026-10-13T20:34:13+05:30",
        },
      }).requestFingerprint,
    ).not.toBe(base.requestFingerprint);
    const repeatedWallTime = {
      ...request,
      calendarContext: {
        currentLocalDateTime: "2026-11-01T01:30:00-04:00",
        timeZone: "America/New_York",
      },
    };
    expect(
      deriveAccountTurnIdentity(repeatedWallTime).requestFingerprint,
    ).not.toBe(
      deriveAccountTurnIdentity({
        ...repeatedWallTime,
        calendarContext: {
          ...repeatedWallTime.calendarContext,
          currentLocalDateTime: "2026-11-01T01:30:00-05:00",
        },
      }).requestFingerprint,
    );
    expect(
      deriveAccountTurnIdentity({
        ...request,
        calendarContext: {
          ...request.calendarContext,
          timeZone: "Asia/Colombo",
        },
      }).requestFingerprint,
    ).not.toBe(base.requestFingerprint);
    expect(
      deriveAccountTurnIdentity({
        ...request,
        userMessage: "  Today I ate oats!  ",
      }).requestFingerprint,
    ).not.toBe(base.requestFingerprint);
    const requestWithUnrelatedDay = {
      ...request,
      foodDayId: "30000000-0000-4000-8000-000000000001",
    };
    expect(
      deriveAccountTurnIdentity(requestWithUnrelatedDay).requestFingerprint,
    ).toBe(base.requestFingerprint);
  });

  it("represents optional context as null without a server-clock fallback", () => {
    const absent = deriveAccountTurnIdentity({
      trustedUserId: user,
      idempotencyKey: key,
      userMessage: request.userMessage,
    });
    expect(absent.calendarContext).toBeNull();
    expect(absent.requestFingerprint).toBe(
      deriveAccountTurnIdentity({ ...request, calendarContext: null })
        .requestFingerprint,
    );
    expect(absent.requestFingerprint).not.toBe(
      deriveAccountTurnIdentity(request).requestFingerprint,
    );
  });

  it("keeps the original accepted snapshot across a physical midnight retry", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-13T18:29:59Z"));
      const original = deriveAccountTurnIdentity({
        ...request,
        calendarContext: {
          currentLocalDateTime: "2026-10-13T23:59:58+05:30",
          timeZone: "Asia/Kolkata",
        },
      });
      vi.setSystemTime(new Date("2026-10-13T18:30:02Z"));
      const retry = deriveAccountTurnIdentity({
        ...request,
        calendarContext: {
          currentLocalDateTime: "2026-10-13T23:59:58+05:30",
          timeZone: "Asia/Kolkata",
        },
      });
      expect(retry).toEqual(original);
    } finally {
      vi.useRealTimers();
    }
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
