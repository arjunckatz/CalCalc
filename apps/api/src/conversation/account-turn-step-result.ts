import { isDeepStrictEqual } from "node:util";

import {
  parseAccountTurnStepResult,
  type AccountTurnPlan,
  type AccountTurnStepResult,
  type JsonObject,
} from "@cal-calc/persistence";

import type { FoodDayToolResult } from "../agent/tools/execute-food-day-tool.js";

type Slot = AccountTurnPlan["slots"][number];

export class AccountTurnStepIntegrityError extends Error {
  override readonly name = "AccountTurnStepIntegrityError";
  constructor() {
    super(
      "Account turn step checkpoint is inconsistent with its durable plan.",
    );
  }
}

/** Retain immutable semantic effects, not mutable current-entry replay snapshots. */
export function normalizeAccountTurnToolResult(
  slot: Slot,
  tool: FoodDayToolResult,
  foodDayId: string,
): AccountTurnStepResult {
  if (slot.action !== tool.name) throw new AccountTurnStepIntegrityError();
  let outcome: JsonObject;
  switch (tool.name) {
    case "LOG_FOOD":
      outcome = { entryId: tool.result.entry.id, revision: 1 };
      break;
    case "UPDATE_FOOD_QUANTITY":
    case "REMOVE_FOOD":
    case "CHANGE_FOOD_STATUS":
      outcome = {
        entryId: tool.result.entry.id,
        appliedRevision: tool.result.appliedRevision,
      };
      break;
    case "SET_FOOD_DAY_COMPLETENESS":
      outcome = {
        foodDayId: tool.result.foodDayId,
        completeness: slot.command.targetCompleteness!,
      };
      break;
    case "LOG_BODY_WEIGHT":
      outcome = { ...tool.result.weightEntry };
      break;
    case "GET_BODY_WEIGHT_HISTORY":
      outcome = {
        recentObservations: tool.result.recentObservations.map((item) => ({
          ...item,
        })),
        recentHistoryMayBeTruncated: tool.result.recentHistoryMayBeTruncated,
        latestMeasurementDate: tool.result.latestMeasurementDate,
        latestDateObservationCount: tool.result.latestDateObservationCount,
        latestDateObservations: tool.result.latestDateObservations.map(
          (item) => ({ ...item }),
        ),
        latestDateObservationsComplete:
          tool.result.latestDateObservationsComplete,
      };
      break;
  }
  return validateAccountTurnStepResult(
    { schema: "account-turn-step-result-v1", action: tool.name, outcome },
    slot,
    foodDayId,
  );
}

/** Recheck JSONB on every read; a checkpoint must match its immutable slot. */
export function validateAccountTurnStepResult(
  value: unknown,
  slot: Slot,
  foodDayId: string,
): AccountTurnStepResult {
  try {
    const result = parseAccountTurnStepResult(value);
    if (result.action !== slot.action) throw new TypeError();
    const effect = result.outcome;
    switch (slot.action) {
      case "LOG_FOOD":
        if (
          !keys(effect, ["entryId", "revision"]) ||
          !uuid(effect.entryId) ||
          effect.revision !== 1
        )
          throw new TypeError();
        break;
      case "UPDATE_FOOD_QUANTITY":
      case "REMOVE_FOOD":
      case "CHANGE_FOOD_STATUS":
        if (
          !keys(effect, ["entryId", "appliedRevision"]) ||
          effect.entryId !== slot.command.entryId ||
          effect.appliedRevision !== Number(slot.command.expectedRevision) + 1
        )
          throw new TypeError();
        break;
      case "SET_FOOD_DAY_COMPLETENESS":
        if (
          !keys(effect, ["foodDayId", "completeness"]) ||
          effect.foodDayId !== foodDayId ||
          effect.completeness !== slot.command.targetCompleteness
        )
          throw new TypeError();
        break;
      case "LOG_BODY_WEIGHT":
        if (
          !keys(effect, [
            "id",
            "localDate",
            "sourceValue",
            "sourceUnit",
            "weightKg",
            "createdAt",
          ]) ||
          !uuid(effect.id) ||
          effect.localDate !== slot.command.localDate ||
          effect.sourceValue !== slot.command.sourceValue ||
          effect.sourceUnit !== slot.command.sourceUnit ||
          !decimal(effect.weightKg) ||
          typeof effect.createdAt !== "string" ||
          effect.createdAt === ""
        )
          throw new TypeError();
        break;
      case "GET_BODY_WEIGHT_HISTORY":
        if (!validHistory(effect)) throw new TypeError();
        break;
      case "DIRECT_RESPONSE":
        throw new TypeError();
    }
    return result;
  } catch {
    throw new AccountTurnStepIntegrityError();
  }
}

export function sameAccountTurnMutationEffect(
  left: AccountTurnStepResult,
  right: AccountTurnStepResult,
): boolean {
  return (
    left.action === right.action &&
    isDeepStrictEqual(left.outcome, right.outcome)
  );
}

function validHistory(value: JsonObject): boolean {
  if (
    !keys(value, [
      "recentObservations",
      "recentHistoryMayBeTruncated",
      "latestMeasurementDate",
      "latestDateObservationCount",
      "latestDateObservations",
      "latestDateObservationsComplete",
    ]) ||
    !Array.isArray(value.recentObservations) ||
    value.recentObservations.length > 30 ||
    typeof value.recentHistoryMayBeTruncated !== "boolean" ||
    (value.latestMeasurementDate !== null &&
      typeof value.latestMeasurementDate !== "string") ||
    !Number.isSafeInteger(value.latestDateObservationCount) ||
    (value.latestDateObservationCount as number) < 0 ||
    !Array.isArray(value.latestDateObservations) ||
    value.latestDateObservations.length > 30 ||
    typeof value.latestDateObservationsComplete !== "boolean"
  )
    return false;
  return [...value.recentObservations, ...value.latestDateObservations].every(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      keys(item, ["localDate", "sourceValue", "sourceUnit", "weightKg"]) &&
      typeof item.localDate === "string" &&
      decimal(item.sourceValue) &&
      (item.sourceUnit === "KG" || item.sourceUnit === "LB") &&
      decimal(item.weightKg),
  );
}

function keys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function decimal(value: unknown): value is string {
  return (
    typeof value === "string" && /^(0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value)
  );
}
