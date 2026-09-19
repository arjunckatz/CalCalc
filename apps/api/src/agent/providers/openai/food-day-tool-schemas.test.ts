import { describe, expect, it } from "vitest";

import {
  parseFoodDayToolCall,
  ToolValidationError,
} from "../../tools/food-day-tools.js";
import {
  normalizeOpenAIFoodDayToolArguments,
  openAIFoodDayTools,
} from "./food-day-tool-schemas.js";

type Schema = Record<string, unknown>;

const entryId = "123e4567-e89b-12d3-a456-426614174000";

function asSchema(value: unknown): Schema {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON Schema object.");
  }
  return value as Schema;
}

function propertiesOf(schema: Schema): Record<string, unknown> {
  return asSchema(schema.properties);
}

function parametersOf(name: string): Schema {
  const tool = openAIFoodDayTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing ${name} tool.`);
  return asSchema(tool.parameters);
}

function expectStrictObjects(schema: Schema): void {
  if (schema.type === "object") {
    const properties = propertiesOf(schema);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(properties));
    for (const child of Object.values(properties)) {
      expectStrictObjects(asSchema(child));
    }
  }
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) expectStrictObjects(asSchema(branch));
  }
}

function logArguments() {
  return {
    rawUserDescription: "Ate a bowl of lentils",
    displayName: "Lentil bowl",
    quantity: { amount: "1", unit: "SERVING" },
    nutritionBasis: {
      amount: "1",
      unit: "SERVING",
      nutrition: {
        calories: "250",
        protein: "14",
        carbs: null,
        fat: null,
        fibre: null,
        sodium: null,
      },
    },
    evidenceClass: "ESTIMATED",
  };
}

function updateArguments() {
  return {
    entryId,
    expectedRevision: 2,
    quantity: { amount: "2", unit: "SERVING" },
    overrideAction: {
      type: "REPLACE",
      override: {
        calories: null,
        protein: "28",
        carbs: null,
        fat: null,
        fibre: null,
        sodium: null,
      },
    },
  };
}

describe("OpenAI FoodDay function tools", () => {
  it("exposes exactly the three M4B1 actions with strict function tools", () => {
    expect(openAIFoodDayTools.map((tool) => tool.name)).toEqual([
      "LOG_FOOD",
      "UPDATE_FOOD_QUANTITY",
      "REMOVE_FOOD",
    ]);
    for (const tool of openAIFoodDayTools) {
      expect(tool.type).toBe("function");
      expect(tool.strict).toBe(true);
      expectStrictObjects(asSchema(tool.parameters));
    }
  });

  it("matches M4B1's exact argument field sets and nested override variants", () => {
    const log = parametersOf("LOG_FOOD");
    expect(Object.keys(propertiesOf(log))).toEqual([
      "rawUserDescription",
      "displayName",
      "quantity",
      "nutritionBasis",
      "evidenceClass",
    ]);
    const basis = asSchema(propertiesOf(log).nutritionBasis);
    expect(Object.keys(propertiesOf(basis))).toEqual([
      "amount",
      "unit",
      "nutrition",
    ]);
    const nutrition = asSchema(propertiesOf(basis).nutrition);
    expect(Object.keys(propertiesOf(nutrition))).toEqual([
      "calories",
      "protein",
      "carbs",
      "fat",
      "fibre",
      "sodium",
    ]);
    expect(asSchema(propertiesOf(nutrition).calories).type).toBe("string");
    for (const field of ["protein", "carbs", "fat", "fibre", "sodium"]) {
      expect(asSchema(propertiesOf(nutrition)[field]).type).toEqual([
        "string",
        "null",
      ]);
    }

    const update = parametersOf("UPDATE_FOOD_QUANTITY");
    expect(Object.keys(propertiesOf(update))).toEqual([
      "entryId",
      "expectedRevision",
      "quantity",
      "overrideAction",
    ]);
    const action = asSchema(propertiesOf(update).overrideAction);
    expect(Array.isArray(action.anyOf)).toBe(true);
    const branches = action.anyOf as unknown[];
    expect(
      branches.map((branch) => Object.keys(propertiesOf(asSchema(branch)))),
    ).toEqual([["type"], ["type"], ["type", "override"]]);
    expect(
      branches.map(
        (branch) => asSchema(propertiesOf(asSchema(branch)).type).enum,
      ),
    ).toEqual([["PRESERVE"], ["CLEAR"], ["REPLACE"]]);
    expect(
      Object.keys(
        propertiesOf(asSchema(propertiesOf(asSchema(branches[2])).override)),
      ),
    ).toEqual(["calories", "protein", "carbs", "fat", "fibre", "sodium"]);

    const remove = parametersOf("REMOVE_FOOD");
    expect(Object.keys(propertiesOf(remove))).toEqual([
      "entryId",
      "expectedRevision",
    ]);
  });

  it("uses the domain unit and evidence enums", () => {
    const log = parametersOf("LOG_FOOD");
    expect(asSchema(propertiesOf(log).evidenceClass).enum).toEqual([
      "EXACT",
      "SOURCED",
      "ESTIMATED",
    ]);
    expect(
      asSchema(propertiesOf(asSchema(propertiesOf(log).quantity)).unit).enum,
    ).toEqual(["GRAM", "MILLILITRE", "SERVING", "CONTAINER"]);
  });

  it("exposes no trusted or internal operation fields in any schema", () => {
    const encoded = JSON.stringify(openAIFoodDayTools);
    for (const field of [
      "trustedUserId",
      "foodDayId",
      "idempotencyKey",
      "operationScope",
      "trustedFoodDayId",
      "operationKey",
      "requestFingerprint",
      "semanticOperationId",
      "resultingRevision",
      "deletedAt",
    ]) {
      expect(encoded).not.toContain(field);
    }
  });
});

describe("OpenAI nullable-nutrient adaptation", () => {
  it("omits only null optional LOG nutrients before M4B1 parsing", () => {
    const args = logArguments();
    const normalized = normalizeOpenAIFoodDayToolArguments("LOG_FOOD", args);
    expect(normalized).toEqual({
      ...args,
      nutritionBasis: {
        ...args.nutritionBasis,
        nutrition: { calories: "250", protein: "14" },
      },
    });
    expect(args.nutritionBasis.nutrition.carbs).toBeNull();
    expect(
      parseFoodDayToolCall({ name: "LOG_FOOD", arguments: normalized }),
    ).toMatchObject({
      arguments: {
        nutritionBasis: { nutrition: { calories: "250", protein: "14" } },
      },
    });
  });

  it("omits only null REPLACE nutrients and leaves the override partial", () => {
    const args = updateArguments();
    const normalized = normalizeOpenAIFoodDayToolArguments(
      "UPDATE_FOOD_QUANTITY",
      args,
    );
    expect(
      parseFoodDayToolCall({
        name: "UPDATE_FOOD_QUANTITY",
        arguments: normalized,
      }),
    ).toMatchObject({
      arguments: {
        overrideAction: { type: "REPLACE", override: { protein: "28" } },
      },
    });
    expect(args.overrideAction.override.calories).toBeNull();
  });

  it("leaves all-null REPLACE empty for M4B1 to reject", () => {
    const args = updateArguments();
    const allNull = {
      ...args,
      overrideAction: {
        ...args.overrideAction,
        override: { ...args.overrideAction.override, protein: null },
      },
    };
    const normalized = normalizeOpenAIFoodDayToolArguments(
      "UPDATE_FOOD_QUANTITY",
      allNull,
    );
    expect(() =>
      parseFoodDayToolCall({
        name: "UPDATE_FOOD_QUANTITY",
        arguments: normalized,
      }),
    ).toThrow(ToolValidationError);
  });

  it("does not remove null from required or unknown fields", () => {
    const args = {
      ...logArguments(),
      rawUserDescription: null,
      trustedUserId: null,
    };
    const normalized = normalizeOpenAIFoodDayToolArguments("LOG_FOOD", args);
    expect(normalized).toMatchObject({
      rawUserDescription: null,
      trustedUserId: null,
    });
    expect(() =>
      parseFoodDayToolCall({ name: "LOG_FOOD", arguments: normalized }),
    ).toThrow(ToolValidationError);
  });

  it("does not change REMOVE or non-REPLACE UPDATE arguments", () => {
    const remove = { entryId, expectedRevision: 2 };
    expect(normalizeOpenAIFoodDayToolArguments("REMOVE_FOOD", remove)).toBe(
      remove,
    );
    const preserve = {
      entryId,
      expectedRevision: 2,
      quantity: { amount: "2", unit: "SERVING" },
      overrideAction: { type: "PRESERVE", override: { calories: "1" } },
    };
    expect(
      normalizeOpenAIFoodDayToolArguments("UPDATE_FOOD_QUANTITY", preserve),
    ).toBe(preserve);
    expect(() =>
      parseFoodDayToolCall({
        name: "UPDATE_FOOD_QUANTITY",
        arguments: preserve,
      }),
    ).toThrow(ToolValidationError);
  });
});
