import type { AcceptedAccountTurnCalendarSnapshot } from "@cal-calc/persistence";

export interface RawCalendarContext {
  readonly currentLocalDateTime: string;
  readonly timeZone: string;
}

export type AcceptedCalendarContext = AcceptedAccountTurnCalendarSnapshot;

export interface AcceptedCalendarFacts {
  readonly localDate: string;
  readonly localTime: string;
  readonly utcOffsetMinutes: number;
}

export type CalendarContextErrorCode =
  | "INVALID_CONTEXT"
  | "INVALID_TIMESTAMP"
  | "MISSING_OFFSET"
  | "INVALID_DATE_TIME"
  | "INVALID_OFFSET"
  | "INVALID_TIME_ZONE"
  | "OFFSET_TIME_ZONE_MISMATCH"
  | "PREVIOUS_DATE_OUT_OF_RANGE";

const messages: Record<CalendarContextErrorCode, string> = {
  INVALID_CONTEXT: "Invalid calendar context.",
  INVALID_TIMESTAMP:
    "Calendar timestamp must include a date, time, and numeric UTC offset.",
  MISSING_OFFSET: "Calendar timestamp requires a numeric UTC offset.",
  INVALID_DATE_TIME: "Invalid Gregorian calendar date or time.",
  INVALID_OFFSET: "Invalid numeric UTC offset.",
  INVALID_TIME_ZONE: "Invalid IANA time zone.",
  OFFSET_TIME_ZONE_MISMATCH:
    "Calendar timestamp offset does not match its time zone.",
  PREVIOUS_DATE_OUT_OF_RANGE:
    "Previous calendar date is outside the supported range.",
};

export class CalendarContextValidationError extends Error {
  override readonly name = "CalendarContextValidationError";

  constructor(readonly code: CalendarContextErrorCode) {
    super(messages[code]);
  }
}

const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([+-])(\d{2}):(\d{2})$/;
const missingOffsetPattern =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
// Intl accepts non-IANA abbreviations such as IST/PST; exclude them first.
const ianaNamePattern = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/i;

/** Accept client evidence once. No server clock, geolocation, or FoodDay policy. */
export function acceptCalendarContext(
  value: unknown,
): AcceptedCalendarContext | null {
  if (value === null || value === undefined) return null;
  return inspectCalendarContext(value).snapshot;
}

/** Read frozen civil facts without reinterpreting the accepted IANA rules. */
export function deriveCalendarFacts(
  snapshot: AcceptedCalendarContext,
): AcceptedCalendarFacts {
  if (
    !recordWithKeys(snapshot, ["schema", "currentLocalDateTime", "timeZone"]) ||
    snapshot.schema !== "client-calendar-v2" ||
    typeof snapshot.timeZone !== "string" ||
    !ianaNamePattern.test(snapshot.timeZone)
  ) {
    throw new CalendarContextValidationError("INVALID_CONTEXT");
  }
  const timestamp = parseTimestamp(snapshot.currentLocalDateTime);
  return {
    localDate: formatDate(timestamp.year, timestamp.month, timestamp.day),
    localTime: `${pad2(timestamp.hour)}:${pad2(timestamp.minute)}:${pad2(timestamp.second)}${timestamp.fraction}`,
    utcOffsetMinutes: timestamp.offsetMinutes,
  };
}

export function previousCalendarDate(localDate: string): string {
  const match = datePattern.exec(localDate);
  if (match === null) {
    throw new CalendarContextValidationError("INVALID_DATE_TIME");
  }
  let year = Number(match[1]);
  let month = Number(match[2]);
  let day = Number(match[3]);
  validateDate(year, month, day);
  if (day > 1) return formatDate(year, month, day - 1);
  if (month === 1) {
    if (year === 1) {
      throw new CalendarContextValidationError("PREVIOUS_DATE_OUT_OF_RANGE");
    }
    year -= 1;
    month = 12;
  } else {
    month -= 1;
  }
  day = daysInMonth(year, month);
  return formatDate(year, month, day);
}

function inspectCalendarContext(value: unknown): {
  snapshot: AcceptedCalendarContext;
  facts: AcceptedCalendarFacts;
} {
  if (!recordWithKeys(value, ["currentLocalDateTime", "timeZone"])) {
    throw new CalendarContextValidationError("INVALID_CONTEXT");
  }
  const timestamp = parseTimestamp(value.currentLocalDateTime);
  if (
    typeof value.timeZone !== "string" ||
    !ianaNamePattern.test(value.timeZone)
  ) {
    throw new CalendarContextValidationError("INVALID_TIME_ZONE");
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: value.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new CalendarContextValidationError("INVALID_TIME_ZONE");
  }
  const zoneParts = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp.instantMs))
      .map((part) => [part.type, part.value]),
  );
  if (
    Number(zoneParts.year) !== timestamp.year ||
    Number(zoneParts.month) !== timestamp.month ||
    Number(zoneParts.day) !== timestamp.day ||
    Number(zoneParts.hour) !== timestamp.hour ||
    Number(zoneParts.minute) !== timestamp.minute ||
    Number(zoneParts.second) !== timestamp.second
  ) {
    throw new CalendarContextValidationError("OFFSET_TIME_ZONE_MISMATCH");
  }
  const localDate = formatDate(timestamp.year, timestamp.month, timestamp.day);
  const localTime = `${pad2(timestamp.hour)}:${pad2(timestamp.minute)}:${pad2(timestamp.second)}${timestamp.fraction}`;
  return {
    snapshot: {
      schema: "client-calendar-v2",
      currentLocalDateTime: `${localDate}T${localTime}${timestamp.offsetText}`,
      timeZone: formatter.resolvedOptions().timeZone,
    },
    facts: {
      localDate,
      localTime,
      utcOffsetMinutes: timestamp.offsetMinutes,
    },
  };
}

function parseTimestamp(value: unknown): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  fraction: string;
  offsetMinutes: number;
  offsetText: string;
  instantMs: number;
} {
  if (typeof value !== "string") {
    throw new CalendarContextValidationError("INVALID_TIMESTAMP");
  }
  const match = timestampPattern.exec(value);
  if (match === null) {
    throw new CalendarContextValidationError(
      missingOffsetPattern.test(value) ? "MISSING_OFFSET" : "INVALID_TIMESTAMP",
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const offsetHours = Number(match[9]);
  const offsetRemainder = Number(match[10]);
  validateDate(year, month, day);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new CalendarContextValidationError("INVALID_DATE_TIME");
  }
  if (offsetHours > 23 || offsetRemainder > 59) {
    throw new CalendarContextValidationError("INVALID_OFFSET");
  }
  const offsetMinutes =
    (match[8] === "-" ? -1 : 1) * (offsetHours * 60 + offsetRemainder);
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetText = `${offsetMinutes < 0 ? "-" : "+"}${pad2(Math.floor(absoluteOffset / 60))}:${pad2(absoluteOffset % 60)}`;
  const fraction =
    millisecond === 0 ? "" : `.${String(millisecond).padStart(3, "0")}`;

  // This Date represents parsed input, never the server's current date/time.
  const civilAsUtc = new Date(0);
  civilAsUtc.setUTCFullYear(year, month - 1, day);
  civilAsUtc.setUTCHours(hour, minute, second, millisecond);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    offsetMinutes,
    offsetText,
    instantMs: civilAsUtc.getTime() - offsetMinutes * 60_000,
  };
}

function validateDate(year: number, month: number, day: number): void {
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new CalendarContextValidationError("INVALID_DATE_TIME");
  }
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ]!;
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function recordWithKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== keys.length
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}
