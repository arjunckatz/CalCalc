import {
  DomainValidationError,
  evidenceClasses,
  measurementUnits,
  parseNutritionBasis,
  parseNutritionOverride,
  parseQuantity,
  type QuantityOverrideAction,
} from "@cal-calc/domain";

import type { CreateFoodEntryCommand } from "../../mutations/create-food-entry.js";
import type { RemoveFoodEntryCommand } from "../../mutations/remove-food-entry.js";
import type { UpdateFoodEntryCommand } from "../../mutations/update-food-entry.js";

export type FoodDayToolCall =
  | {
      readonly name: "LOG_FOOD";
      readonly arguments: Omit<CreateFoodEntryCommand, "foodDayId">;
    }
  | {
      readonly name: "UPDATE_FOOD_QUANTITY";
      readonly arguments: UpdateFoodEntryCommand;
    }
  | {
      readonly name: "REMOVE_FOOD";
      readonly arguments: RemoveFoodEntryCommand;
    };

const nutritionFields = [
  "calories",
  "protein",
  "carbs",
  "fat",
  "fibre",
  "sodium",
] as const;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ToolValidationError extends Error {
  override readonly name = "ToolValidationError";

  constructor() {
    super("Invalid FoodDay tool call.");
  }
}

/** Parse untrusted model output into a JSON-friendly, normalized action. */
export function parseFoodDayToolCall(input: unknown): FoodDayToolCall {
  const call = strictObject(input, ["name", "arguments"]);
  switch (call.name) {
    case "LOG_FOOD":
      return { name: "LOG_FOOD", arguments: parseLogArguments(call.arguments) };
    case "UPDATE_FOOD_QUANTITY":
      return {
        name: "UPDATE_FOOD_QUANTITY",
        arguments: parseUpdateArguments(call.arguments),
      };
    case "REMOVE_FOOD":
      return {
        name: "REMOVE_FOOD",
        arguments: parseRemoveArguments(call.arguments),
      };
    default:
      throw new ToolValidationError();
  }
}

function parseLogArguments(
  input: unknown,
): Extract<FoodDayToolCall, { name: "LOG_FOOD" }>["arguments"] {
  const value = strictObject(input, [
    "rawUserDescription",
    "displayName",
    "quantity",
    "nutritionBasis",
    "evidenceClass",
  ]);
  const quantity = parseQuantityInput(value.quantity);
  const basis = strictObject(value.nutritionBasis, [
    "amount",
    "unit",
    "nutrition",
  ]);
  const nutrition = strictObject(basis.nutrition, nutritionFields);
  decimalText(basis.amount);
  requireMember(basis.unit, measurementUnits);
  decimalText(nutrition.calories);
  for (const field of nutritionFields) {
    if (Object.hasOwn(nutrition, field)) decimalText(nutrition[field]);
  }
  requireMember(value.evidenceClass, evidenceClasses);
  const rawUserDescription = text(value.rawUserDescription);
  const displayName = text(value.displayName);
  return {
    rawUserDescription,
    displayName,
    quantity,
    nutritionBasis: domainParse(() =>
      parseNutritionBasis({
        amount: basis.amount,
        unit: basis.unit,
        nutrition,
      }),
    ),
    evidenceClass: value.evidenceClass,
  };
}

function parseUpdateArguments(input: unknown): UpdateFoodEntryCommand {
  const value = strictObject(input, [
    "entryId",
    "expectedRevision",
    "quantity",
    "overrideAction",
  ]);
  return {
    entryId: entryId(value.entryId),
    expectedRevision: revision(value.expectedRevision),
    quantity: parseQuantityInput(value.quantity),
    overrideAction: parseOverrideAction(value.overrideAction),
  };
}

function parseRemoveArguments(input: unknown): RemoveFoodEntryCommand {
  const value = strictObject(input, ["entryId", "expectedRevision"]);
  return {
    entryId: entryId(value.entryId),
    expectedRevision: revision(value.expectedRevision),
  };
}

function parseQuantityInput(input: unknown) {
  const value = strictObject(input, ["amount", "unit"]);
  decimalText(value.amount);
  requireMember(value.unit, measurementUnits);
  return domainParse(() => parseQuantity(value));
}

function parseOverrideAction(input: unknown): QuantityOverrideAction {
  const action = strictObject(input, ["type", "override"]);
  if (action.type === "PRESERVE" || action.type === "CLEAR") {
    exactFields(action, ["type"]);
    return { type: action.type };
  }
  if (action.type !== "REPLACE") throw new ToolValidationError();
  exactFields(action, ["type", "override"]);
  const override = strictObject(action.override, nutritionFields);
  for (const field of nutritionFields) {
    if (Object.hasOwn(override, field)) decimalText(override[field]);
  }
  return {
    type: "REPLACE",
    override: domainParse(() => parseNutritionOverride(override)),
  };
}

function strictObject(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new ToolValidationError();
  }
  exactFields(input, allowed);
  return input as Record<string, unknown>;
}

function exactFields(input: object, allowed: readonly string[]): void {
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw new ToolValidationError();
    }
  }
}

function requireMember<const T extends string>(
  value: unknown,
  members: readonly T[],
): asserts value is T {
  if (typeof value !== "string" || !members.includes(value as T)) {
    throw new ToolValidationError();
  }
}

function decimalText(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^\d+(?:\.\d+)?$/.test(value.trim())
  ) {
    throw new ToolValidationError();
  }
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolValidationError();
  }
  return value.trim();
}

function entryId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new ToolValidationError();
  }
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ToolValidationError();
  }
  return value;
}

function domainParse<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DomainValidationError) throw new ToolValidationError();
    throw error;
  }
}
