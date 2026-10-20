import type {
  AccountTurnCalendarSnapshot,
  AccountTurnPlan,
  AccountTurnPlanAction,
  AccountTurnRoutingResolution,
  JsonObject,
  JsonValue,
} from "./types.js";

const actions: readonly AccountTurnPlanAction[] = [
  "DIRECT_RESPONSE",
  "LOG_FOOD",
  "UPDATE_FOOD_QUANTITY",
  "REMOVE_FOOD",
  "CHANGE_FOOD_STATUS",
  "SET_FOOD_DAY_COMPLETENESS",
  "LOG_BODY_WEIGHT",
  "GET_BODY_WEIGHT_HISTORY",
];

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidTextPattern =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const tokenPattern = /\b(?:day|entry)_[a-z0-9_]+\b/i;

/** Revalidate JSONB on every hydration, including version and exact variant keys. */
export function parseAccountTurnRoutingResolution(
  value: unknown,
): AccountTurnRoutingResolution {
  if (
    !isPlainRecord(value) ||
    value.schema !== "account-routing-resolution-v1"
  ) {
    throw new TypeError("Invalid account turn routing resolution.");
  }
  switch (value.kind) {
    case "EXISTING_DAY":
      if (
        recordWithKeys(value, ["schema", "kind", "foodDayId"]) &&
        validUuid(value.foodDayId)
      )
        return {
          schema: "account-routing-resolution-v1",
          kind: "EXISTING_DAY",
          foodDayId: value.foodDayId,
        };
      break;
    case "EXISTING_ENTRY_REFERENCE":
      if (
        recordWithKeys(value, [
          "schema",
          "kind",
          "foodDayId",
          "entryId",
          "revision",
        ]) &&
        validUuid(value.foodDayId) &&
        validUuid(value.entryId) &&
        Number.isSafeInteger(value.revision) &&
        (value.revision as number) > 0
      )
        return {
          schema: "account-routing-resolution-v1",
          kind: "EXISTING_ENTRY_REFERENCE",
          foodDayId: value.foodDayId,
          entryId: value.entryId,
          revision: value.revision as number,
        };
      break;
    case "DATE_TARGET":
      if (
        recordWithKeys(value, ["schema", "kind", "localDate"]) &&
        validDate(value.localDate)
      )
        return {
          schema: "account-routing-resolution-v1",
          kind: "DATE_TARGET",
          localDate: value.localDate,
        };
      break;
    case "DAYLESS":
      if (recordWithKeys(value, ["schema", "kind"]))
        return { schema: "account-routing-resolution-v1", kind: "DAYLESS" };
      break;
    case "CLARIFY":
      if (
        recordWithKeys(value, ["schema", "kind", "question"]) &&
        typeof value.question === "string" &&
        value.question.trim() === value.question &&
        value.question.length > 0 &&
        value.question.length <= 240 &&
        !uuidTextPattern.test(value.question) &&
        !tokenPattern.test(value.question)
      )
        return {
          schema: "account-routing-resolution-v1",
          kind: "CLARIFY",
          question: value.question,
        };
      break;
  }
  throw new TypeError("Invalid account turn routing resolution.");
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

/** A shape/size-validated internal plan, not raw provider output. */
export function parseAccountTurnPlan(value: unknown): AccountTurnPlan {
  if (
    (!recordWithKeys(value, ["schema", "slots"]) &&
      !recordWithKeys(value, ["schema", "foodDayId", "slots"])) ||
    value.schema !== "account-turn-plan-v1" ||
    (Object.hasOwn(value, "foodDayId") && !validUuid(value.foodDayId)) ||
    !Array.isArray(value.slots) ||
    Object.getPrototypeOf(value.slots) !== Array.prototype ||
    value.slots.length < 1 ||
    value.slots.length > 8 ||
    Reflect.ownKeys(value.slots).length !== value.slots.length + 1
  ) {
    throw new TypeError("Invalid account turn execution plan.");
  }
  const slots = Array.from({ length: value.slots.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      value.slots,
      String(index),
    );
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("Invalid account turn execution plan.");
    }
    const slot: unknown = descriptor.value;
    if (
      !recordWithKeys(slot, ["index", "action", "command"]) ||
      slot.index !== index ||
      !actions.includes(slot.action as AccountTurnPlanAction) ||
      !isPlainRecord(slot.command)
    ) {
      throw new TypeError("Invalid account turn execution plan.");
    }
    return {
      index,
      action: slot.action as AccountTurnPlanAction,
      command: copyJson(slot.command, 0) as JsonObject,
    };
  });
  const plan: AccountTurnPlan = {
    schema: "account-turn-plan-v1",
    ...(Object.hasOwn(value, "foodDayId")
      ? { foodDayId: value.foodDayId as string }
      : {}),
    slots,
  };
  if (JSON.stringify(plan).length > 16 * 1024) {
    throw new TypeError("Account turn execution plan is too large.");
  }
  return plan;
}

export function parseAccountTurnCalendarSnapshot(
  value: unknown,
): AccountTurnCalendarSnapshot {
  if (value === null) return null;
  if (
    recordWithKeys(value, ["schema", "currentLocalDateTime", "timeZone"]) &&
    value.schema === "client-calendar-v2" &&
    typeof value.currentLocalDateTime === "string" &&
    value.currentLocalDateTime !== "" &&
    typeof value.timeZone === "string" &&
    value.timeZone !== ""
  ) {
    return {
      schema: "client-calendar-v2",
      currentLocalDateTime: value.currentLocalDateTime,
      timeZone: value.timeZone,
    };
  }
  if (
    !recordWithKeys(value, ["schema", "currentLocalDate"]) ||
    value.schema !== "client-calendar-v1" ||
    !validDate(value.currentLocalDate)
  ) {
    throw new TypeError("Invalid accepted account turn calendar snapshot.");
  }
  return {
    schema: "client-calendar-v1",
    currentLocalDate: value.currentLocalDate,
  };
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]!
  );
}

function copyJson(value: unknown, depth: number): JsonValue {
  if (depth > 8) throw new TypeError("Account turn plan nesting is too deep.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype
  ) {
    if (Reflect.ownKeys(value).length !== value.length + 1)
      throw new TypeError("Invalid plan array.");
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("Invalid plan array.");
      }
      return copyJson(descriptor.value, depth + 1);
    });
  }
  if (isPlainRecord(value)) {
    const copy: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError("Invalid plan key.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor))
        throw new TypeError("Invalid plan field.");
      Object.defineProperty(copy, key, {
        value: copyJson(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  }
  throw new TypeError("Invalid account turn plan value.");
}

function recordWithKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value) || Reflect.ownKeys(value).length !== keys.length)
    return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
