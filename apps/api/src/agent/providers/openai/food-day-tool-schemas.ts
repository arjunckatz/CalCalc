import { evidenceClasses, measurementUnits } from "@cal-calc/domain";
import type { FunctionTool } from "openai/resources/responses/responses.js";

const optionalLogNutrients = [
  "protein",
  "carbs",
  "fat",
  "fibre",
  "sodium",
] as const;
const overrideNutrients = ["calories", ...optionalLogNutrients] as const;

function strictObject(properties: Record<string, unknown>) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  } as const;
}

const decimalString = { type: "string" } as const;
const nullableDecimalString = { type: ["string", "null"] } as const;
const unit = { type: "string", enum: measurementUnits } as const;
const quantity = strictObject({ amount: decimalString, unit });

const logNutrition = strictObject({
  calories: decimalString,
  ...Object.fromEntries(
    optionalLogNutrients.map((name) => [name, nullableDecimalString]),
  ),
});

const replacementNutrition = strictObject(
  Object.fromEntries(
    overrideNutrients.map((name) => [name, nullableDecimalString]),
  ),
);

const overrideAction = {
  anyOf: [
    strictObject({ type: { type: "string", enum: ["PRESERVE"] } }),
    strictObject({ type: { type: "string", enum: ["CLEAR"] } }),
    strictObject({
      type: { type: "string", enum: ["REPLACE"] },
      override: replacementNutrition,
    }),
  ],
} as const;

/** Model-facing schemas only. M4B1 remains the semantic validator. */
export const openAIFoodDayTools: FunctionTool[] = [
  {
    type: "function",
    name: "LOG_FOOD",
    description: "Record food the user consumed on the current FoodDay.",
    strict: true,
    parameters: strictObject({
      rawUserDescription: { type: "string" },
      displayName: { type: "string" },
      quantity,
      nutritionBasis: strictObject({
        amount: decimalString,
        unit,
        nutrition: logNutrition,
      }),
      evidenceClass: { type: "string", enum: evidenceClasses },
    }),
  },
  {
    type: "function",
    name: "UPDATE_FOOD_QUANTITY",
    description: "Correct the quantity of an existing FoodDay entry.",
    strict: true,
    parameters: strictObject({
      entryId: { type: "string" },
      expectedRevision: { type: "integer" },
      quantity,
      overrideAction,
    }),
  },
  {
    type: "function",
    name: "REMOVE_FOOD",
    description: "Remove an existing FoodDay entry.",
    strict: true,
    parameters: strictObject({
      entryId: { type: "string" },
      expectedRevision: { type: "integer" },
    }),
  },
];

/**
 * Strict schemas represent optional nutrients as null. Translate only those
 * slots to absence, leaving every other value for the M4B1 parser to judge.
 */
export function normalizeOpenAIFoodDayToolArguments(
  name: "LOG_FOOD" | "UPDATE_FOOD_QUANTITY" | "REMOVE_FOOD",
  args: unknown,
): unknown {
  if (!isPlainDataRecord(args)) return args;

  if (name === "LOG_FOOD") {
    const basis = args.nutritionBasis;
    if (!isPlainDataRecord(basis) || !isPlainDataRecord(basis.nutrition)) {
      return args;
    }
    const nutrition = omitNullFields(basis.nutrition, optionalLogNutrients);
    return nutrition === basis.nutrition
      ? args
      : { ...args, nutritionBasis: { ...basis, nutrition } };
  }

  if (name === "UPDATE_FOOD_QUANTITY") {
    const action = args.overrideAction;
    if (
      !isPlainDataRecord(action) ||
      action.type !== "REPLACE" ||
      !isPlainDataRecord(action.override)
    ) {
      return args;
    }
    const override = omitNullFields(action.override, overrideNutrients);
    return override === action.override
      ? args
      : { ...args, overrideAction: { ...action, override } };
  }

  return args;
}

function omitNullFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !fields.some(
      (field) => Object.hasOwn(value, field) && value[field] === null,
    )
  ) {
    return value;
  }
  const copy = { ...value };
  for (const field of fields) {
    if (Object.hasOwn(copy, field) && copy[field] === null) delete copy[field];
  }
  return copy;
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === "string" &&
      descriptor?.enumerable === true &&
      "value" in descriptor
    );
  });
}
