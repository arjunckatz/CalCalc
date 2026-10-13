import { describe, expect, it } from "vitest";

import { parseAccountTurnCalendarSnapshot } from "@cal-calc/persistence";

import {
  CalendarContextValidationError,
  acceptCalendarContext,
  deriveCalendarFacts,
  previousCalendarDate,
  type CalendarContextErrorCode,
} from "./calendar-context.js";

function accept(currentLocalDateTime: string, timeZone: string) {
  const result = acceptCalendarContext({ currentLocalDateTime, timeZone });
  expect(result).not.toBeNull();
  return result!;
}

describe("accepted calendar context", () => {
  it.each([
    [
      "2026-10-13T20:34:12+05:30",
      "Asia/Kolkata",
      "2026-10-13",
      "20:34:12",
      330,
    ],
    ["2026-01-01T00:00:00+00:00", "UTC", "2026-01-01", "00:00:00", 0],
    [
      "2026-07-01T12:00:00+01:00",
      "Europe/London",
      "2026-07-01",
      "12:00:00",
      60,
    ],
    [
      "2026-01-15T12:00:00-05:00",
      "America/New_York",
      "2026-01-15",
      "12:00:00",
      -300,
    ],
    [
      "2026-07-01T12:00:00-04:00",
      "America/New_York",
      "2026-07-01",
      "12:00:00",
      -240,
    ],
    [
      "2024-02-29T23:59:59+05:30",
      "Asia/Kolkata",
      "2024-02-29",
      "23:59:59",
      330,
    ],
    ["2025-12-31T23:59:59+00:00", "UTC", "2025-12-31", "23:59:59", 0],
    [
      "2026-10-13T20:34:12.123+05:30",
      "Asia/Kolkata",
      "2026-10-13",
      "20:34:12.123",
      330,
    ],
  ] as const)(
    "derives exact civil facts from %s in %s",
    (
      currentLocalDateTime,
      timeZone,
      localDate,
      localTime,
      utcOffsetMinutes,
    ) => {
      const snapshot = accept(currentLocalDateTime, timeZone);
      expect(deriveCalendarFacts(snapshot)).toEqual({
        localDate,
        localTime,
        utcOffsetMinutes,
      });
    },
  );

  it("normalizes equivalent accepted timestamp and IANA spellings", () => {
    expect(accept("2026-10-13t20:34:12.1+05:30", "ASIA/KOLKATA")).toEqual(
      accept("2026-10-13T20:34:12.100+05:30", "Asia/Kolkata"),
    );
    expect(accept("2026-01-01T00:00:00.000-00:00", "Etc/UTC")).toEqual(
      accept("2026-01-01T00:00:00+00:00", "UTC"),
    );
  });

  it("disambiguates repeated fall-back wall time with the explicit offset", () => {
    const first = accept("2026-11-01T01:30:00-04:00", "America/New_York");
    const second = accept("2026-11-01T01:30:00-05:00", "America/New_York");
    expect(deriveCalendarFacts(first).localTime).toBe("01:30:00");
    expect(deriveCalendarFacts(second).localTime).toBe("01:30:00");
    expect(deriveCalendarFacts(first).utcOffsetMinutes).toBe(-240);
    expect(deriveCalendarFacts(second).utcOffsetMinutes).toBe(-300);
    expect(first).not.toEqual(second);
  });

  it.each([
    [
      { currentLocalDateTime: "2026-10-13", timeZone: "Asia/Kolkata" },
      "INVALID_TIMESTAMP",
    ],
    [
      { currentLocalDateTime: "2026-10-13T20:34:12", timeZone: "Asia/Kolkata" },
      "MISSING_OFFSET",
    ],
    [
      {
        currentLocalDateTime: "2026-10-13T20:34+05:30",
        timeZone: "Asia/Kolkata",
      },
      "INVALID_TIMESTAMP",
    ],
    [
      {
        currentLocalDateTime: "2026-02-30T12:00:00+05:30",
        timeZone: "Asia/Kolkata",
      },
      "INVALID_DATE_TIME",
    ],
    [
      {
        currentLocalDateTime: "2026-10-13T24:00:00+05:30",
        timeZone: "Asia/Kolkata",
      },
      "INVALID_DATE_TIME",
    ],
    [
      {
        currentLocalDateTime: "2026-10-13T20:60:00+05:30",
        timeZone: "Asia/Kolkata",
      },
      "INVALID_DATE_TIME",
    ],
    [
      {
        currentLocalDateTime: "2026-10-13T20:34:12+24:00",
        timeZone: "Asia/Kolkata",
      },
      "INVALID_OFFSET",
    ],
    [
      {
        currentLocalDateTime: "2026-10-13T20:34:12+05:60",
        timeZone: "Asia/Kolkata",
      },
      "INVALID_OFFSET",
    ],
    [
      { currentLocalDateTime: "2026-10-13T20:34:12Z", timeZone: "UTC" },
      "INVALID_TIMESTAMP",
    ],
    [
      {
        currentLocalDateTime: "2026-10-13T20:34:12+05:30junk",
        timeZone: "Asia/Kolkata",
      },
      "INVALID_TIMESTAMP",
    ],
    [
      {
        currentLocalDateTime: "2026-07-01T12:00:00-05:00",
        timeZone: "America/New_York",
      },
      "OFFSET_TIME_ZONE_MISMATCH",
    ],
    [
      {
        currentLocalDateTime: "2026-01-15T12:00:00-04:00",
        timeZone: "America/New_York",
      },
      "OFFSET_TIME_ZONE_MISMATCH",
    ],
    [
      {
        currentLocalDateTime: "2026-03-08T02:30:00-05:00",
        timeZone: "America/New_York",
      },
      "OFFSET_TIME_ZONE_MISMATCH",
    ],
    [
      { currentLocalDateTime: "2026-10-13T20:34:12+05:30", timeZone: "IST" },
      "INVALID_TIME_ZONE",
    ],
    [
      {
        currentLocalDateTime: "2026-10-13T20:34:12+05:30",
        timeZone: "GMT+5:30",
      },
      "INVALID_TIME_ZONE",
    ],
    [
      {
        currentLocalDateTime: "2026-10-13T20:34:12+05:30",
        timeZone: "Mars/Olympus",
      },
      "INVALID_TIME_ZONE",
    ],
    [{ currentLocalDateTime: 42, timeZone: "UTC" }, "INVALID_TIMESTAMP"],
    [
      { currentLocalDateTime: "2026-10-13T20:34:12+05:30", timeZone: 42 },
      "INVALID_TIME_ZONE",
    ],
    [
      {
        currentLocalDateTime: "2026-10-13T20:34:12+05:30",
        timeZone: "Asia/Kolkata",
        userId: "forbidden",
      },
      "INVALID_CONTEXT",
    ],
  ] as const)("rejects invalid raw context %#", (value, code) => {
    try {
      acceptCalendarContext(value);
      throw new Error("Expected calendar context rejection.");
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarContextValidationError);
      expect((error as CalendarContextValidationError).code).toBe(
        code as CalendarContextErrorCode,
      );
    }
  });

  it.each([
    ["2026-03-01", "2026-02-28"],
    ["2024-03-01", "2024-02-29"],
    ["2026-01-01", "2025-12-31"],
    ["2026-05-01", "2026-04-30"],
    ["2026-10-13", "2026-10-12"],
  ])("derives previous calendar date %s -> %s", (date, previous) => {
    expect(previousCalendarDate(date)).toBe(previous);
  });

  it("rejects impossible previous-date input and an out-of-range predecessor", () => {
    expect(() => previousCalendarDate("2026-02-30")).toThrow(
      CalendarContextValidationError,
    );
    expect(() => previousCalendarDate("0001-01-01")).toThrow(
      CalendarContextValidationError,
    );
  });

  it("represents absent context explicitly without consulting a clock", () => {
    expect(acceptCalendarContext(undefined)).toBeNull();
    expect(acceptCalendarContext(null)).toBeNull();
  });

  it("rehydrates the exact accepted snapshot through the existing persistence shape", () => {
    const accepted = accept("2026-10-13T20:34:12.123+05:30", "Asia/Kolkata");
    const stored = JSON.parse(JSON.stringify(accepted));
    const rehydrated = parseAccountTurnCalendarSnapshot(stored);
    expect(rehydrated).toEqual(accepted);
    expect(rehydrated?.schema).toBe("client-calendar-v2");
    if (rehydrated?.schema !== "client-calendar-v2") {
      throw new Error("Expected accepted calendar snapshot.");
    }
    expect(deriveCalendarFacts(rehydrated)).toEqual({
      localDate: "2026-10-13",
      localTime: "20:34:12.123",
      utcOffsetMinutes: 330,
    });
  });
});
