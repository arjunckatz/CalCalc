import { describe, expect, it } from "vitest";

import {
  parseAccountTurnCalendarSnapshot,
  parseAccountTurnPlan,
} from "./account-turn-values.js";

describe("account turn value boundaries", () => {
  it("preserves an exact accepted calendar date or explicit null", () => {
    expect(parseAccountTurnCalendarSnapshot(null)).toBeNull();
    expect(
      parseAccountTurnCalendarSnapshot({
        schema: "client-calendar-v1",
        currentLocalDate: "2026-10-13",
      }),
    ).toEqual({ schema: "client-calendar-v1", currentLocalDate: "2026-10-13" });
    expect(() =>
      parseAccountTurnCalendarSnapshot({
        schema: "client-calendar-v1",
        currentLocalDate: "2026-02-30",
      }),
    ).toThrow();
    expect(() =>
      parseAccountTurnCalendarSnapshot({
        schema: "client-calendar-v1",
        currentLocalDate: "2026-10-13",
        userId: "untrusted",
      }),
    ).toThrow();
  });

  it("round-trips the versioned accepted date-time snapshot through JSONB-shaped data", () => {
    const accepted = {
      schema: "client-calendar-v2",
      currentLocalDateTime: "2026-10-13T20:34:12.123+05:30",
      timeZone: "Asia/Calcutta",
    };
    expect(
      parseAccountTurnCalendarSnapshot(JSON.parse(JSON.stringify(accepted))),
    ).toEqual(accepted);
    expect(() =>
      parseAccountTurnCalendarSnapshot({ ...accepted, userId: "untrusted" }),
    ).toThrow();
    expect(() =>
      parseAccountTurnCalendarSnapshot({ ...accepted, timeZone: 42 }),
    ).toThrow();
  });

  it("accepts only bounded, ordered, JSON-data-only internal slots", () => {
    const parsed = parseAccountTurnPlan({
      schema: "account-turn-plan-v1",
      slots: [
        { index: 0, action: "LOG_FOOD", command: { amount: "0.1" } },
        { index: 1, action: "GET_BODY_WEIGHT_HISTORY", command: {} },
      ],
    });
    expect(parsed.slots.map((slot) => slot.index)).toEqual([0, 1]);
    expect(parsed.slots[0]?.command).toEqual({ amount: "0.1" });
    expect(() =>
      parseAccountTurnPlan({
        schema: "account-turn-plan-v1",
        slots: [{ index: 1, action: "LOG_FOOD", command: {} }],
      }),
    ).toThrow();
    expect(() =>
      parseAccountTurnPlan({
        schema: "account-turn-plan-v1",
        slots: [{ index: 0, action: "PROVIDER_SECRET", command: {} }],
      }),
    ).toThrow();
    expect(() =>
      parseAccountTurnPlan({
        schema: "account-turn-plan-v1",
        slots: [
          { index: 0, action: "LOG_FOOD", command: { value: Number.NaN } },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseAccountTurnPlan({
        schema: "account-turn-plan-v1",
        slots: [
          { index: 0, action: "LOG_FOOD", command: { value: new Date() } },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseAccountTurnPlan({ schema: "account-turn-plan-v1", slots: [] }),
    ).toThrow();
  });
});
