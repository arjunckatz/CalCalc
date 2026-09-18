import { describe, expect, it } from "vitest";

import { parseFoodDayToolCall, ToolValidationError } from "./food-day-tools.js";

const entryId = "123e4567-e89b-12d3-a456-426614174000";

function logCall() {
  return {
    name: "LOG_FOOD",
    arguments: {
      rawUserDescription: "  Ate one serving  ",
      displayName: "  Lentil bowl  ",
      quantity: { amount: "01.00", unit: "SERVING" },
      nutritionBasis: {
        amount: "1.0",
        unit: "SERVING",
        nutrition: { calories: "249.1300", protein: "14.910" },
      },
      evidenceClass: "ESTIMATED",
    },
  };
}

function updateCall() {
  return {
    name: "UPDATE_FOOD_QUANTITY",
    arguments: {
      entryId,
      expectedRevision: 3,
      quantity: { amount: "02.00", unit: "SERVING" },
      overrideAction: { type: "PRESERVE" },
    },
  };
}

function removeCall() {
  return { name: "REMOVE_FOOD", arguments: { entryId, expectedRevision: 3 } };
}

describe("parseFoodDayToolCall", () => {
  it("normalizes a valid LOG_FOOD call to serializable semantic arguments", () => {
    const call = parseFoodDayToolCall(logCall());
    expect(call).toEqual({
      name: "LOG_FOOD",
      arguments: {
        rawUserDescription: "Ate one serving",
        displayName: "Lentil bowl",
        quantity: { amount: "1", unit: "SERVING" },
        nutritionBasis: {
          amount: "1",
          unit: "SERVING",
          nutrition: { calories: "249.13", protein: "14.91" },
        },
        evidenceClass: "ESTIMATED",
      },
    });
    expect(JSON.parse(JSON.stringify(call))).toEqual(call);
  });

  it("accepts LOG_FOOD with absent optional nutrients", () => {
    const call = logCall();
    call.arguments.nutritionBasis.nutrition = { calories: "0", protein: "0" };
    delete (call.arguments.nutritionBasis.nutrition as { protein?: string })
      .protein;
    expect(parseFoodDayToolCall(call)).toMatchObject({
      arguments: { nutritionBasis: { nutrition: { calories: "0" } } },
    });
  });

  it.each(["BOGUS", "CREATE_FOOD_ENTRY", "getFoodDayState"])(
    "rejects unknown tool name %s",
    (name) => {
      expect(() => parseFoodDayToolCall({ name, arguments: {} })).toThrow(
        ToolValidationError,
      );
    },
  );

  it.each([null, [], "LOG_FOOD", {}])(
    "rejects malformed top-level call %s",
    (value) => {
      expect(() => parseFoodDayToolCall(value)).toThrow(ToolValidationError);
    },
  );

  it("rejects extra top-level data", () => {
    expect(() =>
      parseFoodDayToolCall({ ...logCall(), trustedUserId: "attacker" }),
    ).toThrow(ToolValidationError);
  });

  it.each(["trustedUserId", "foodDayId", "idempotencyKey", "status"])(
    "rejects trusted or internal LOG_FOOD argument %s",
    (field) => {
      const call = logCall();
      expect(() =>
        parseFoodDayToolCall({
          ...call,
          arguments: { ...call.arguments, [field]: "attacker" },
        }),
      ).toThrow(ToolValidationError);
    },
  );

  it("rejects malformed LOG_FOOD arguments", () => {
    expect(() =>
      parseFoodDayToolCall({ name: "LOG_FOOD", arguments: [] }),
    ).toThrow(ToolValidationError);
  });

  it("rejects unknown quantity and nutrition fields", () => {
    const call = logCall();
    expect(() =>
      parseFoodDayToolCall({
        ...call,
        arguments: {
          ...call.arguments,
          quantity: { ...call.arguments.quantity, userId: "attacker" },
        },
      }),
    ).toThrow(ToolValidationError);
    expect(() =>
      parseFoodDayToolCall({
        ...call,
        arguments: {
          ...call.arguments,
          nutritionBasis: {
            ...call.arguments.nutritionBasis,
            nutrition: {
              ...call.arguments.nutritionBasis.nutrition,
              operationKey: "attacker",
            },
          },
        },
      }),
    ).toThrow(ToolValidationError);
  });

  it.each([0.1, "Infinity", "-1", "1e2", "0"])(
    "rejects invalid or non-wire quantity decimal %s",
    (amount) => {
      const call = logCall();
      expect(() =>
        parseFoodDayToolCall({
          ...call,
          arguments: {
            ...call.arguments,
            quantity: { amount, unit: "SERVING" },
          },
        }),
      ).toThrow(ToolValidationError);
    },
  );

  it("rejects missing required calories and invalid evidence classes", () => {
    const call = logCall();
    expect(() =>
      parseFoodDayToolCall({
        ...call,
        arguments: {
          ...call.arguments,
          nutritionBasis: {
            ...call.arguments.nutritionBasis,
            nutrition: { protein: "14" },
          },
        },
      }),
    ).toThrow(ToolValidationError);
    expect(() =>
      parseFoodDayToolCall({
        ...call,
        arguments: { ...call.arguments, evidenceClass: "GUESS" },
      }),
    ).toThrow(ToolValidationError);
  });

  it("normalizes valid UPDATE_FOOD_QUANTITY with PRESERVE", () => {
    expect(parseFoodDayToolCall(updateCall())).toEqual({
      name: "UPDATE_FOOD_QUANTITY",
      arguments: {
        entryId,
        expectedRevision: 3,
        quantity: { amount: "2", unit: "SERVING" },
        overrideAction: { type: "PRESERVE" },
      },
    });
  });

  it("accepts CLEAR without replacement data", () => {
    const call = updateCall();
    expect(
      parseFoodDayToolCall({
        ...call,
        arguments: { ...call.arguments, overrideAction: { type: "CLEAR" } },
      }),
    ).toMatchObject({ arguments: { overrideAction: { type: "CLEAR" } } });
  });

  it("normalizes a full REPLACE override without filling absent nutrients", () => {
    const call = updateCall();
    expect(
      parseFoodDayToolCall({
        ...call,
        arguments: {
          ...call.arguments,
          overrideAction: {
            type: "REPLACE",
            override: { calories: "0685.10750", protein: "041.00250" },
          },
        },
      }),
    ).toMatchObject({
      arguments: {
        overrideAction: {
          type: "REPLACE",
          override: { calories: "685.1075", protein: "41.0025" },
        },
      },
    });
  });

  it.each(["PRESERVE", "CLEAR"])("rejects replacement data on %s", (type) => {
    const call = updateCall();
    expect(() =>
      parseFoodDayToolCall({
        ...call,
        arguments: {
          ...call.arguments,
          overrideAction: { type, override: { calories: "1" } },
        },
      }),
    ).toThrow(ToolValidationError);
  });

  it("rejects empty or unknown-field REPLACE overrides", () => {
    const call = updateCall();
    for (const override of [{}, { calories: "1", userId: "attacker" }]) {
      expect(() =>
        parseFoodDayToolCall({
          ...call,
          arguments: {
            ...call.arguments,
            overrideAction: { type: "REPLACE", override },
          },
        }),
      ).toThrow(ToolValidationError);
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"])(
    "rejects invalid expected revision %s",
    (expectedRevision) => {
      const call = updateCall();
      expect(() =>
        parseFoodDayToolCall({
          ...call,
          arguments: { ...call.arguments, expectedRevision },
        }),
      ).toThrow(ToolValidationError);
    },
  );

  it("rejects non-UUID entry IDs and extra update fields", () => {
    const call = updateCall();
    expect(() =>
      parseFoodDayToolCall({
        ...call,
        arguments: { ...call.arguments, entryId: "not-a-uuid" },
      }),
    ).toThrow(ToolValidationError);
    expect(() =>
      parseFoodDayToolCall({
        ...call,
        arguments: { ...call.arguments, resultingRevision: 4 },
      }),
    ).toThrow(ToolValidationError);
  });

  it("accepts a valid REMOVE_FOOD command unchanged", () => {
    expect(parseFoodDayToolCall(removeCall())).toEqual(removeCall());
  });

  it.each(["deletedAt", "trustedUserId", "operationKey", "foodDayId"])(
    "rejects internal REMOVE_FOOD argument %s",
    (field) => {
      const call = removeCall();
      expect(() =>
        parseFoodDayToolCall({
          ...call,
          arguments: { ...call.arguments, [field]: "attacker" },
        }),
      ).toThrow(ToolValidationError);
    },
  );

  it("rejects accessor-backed arguments rather than executing a getter", () => {
    const argumentsWithGetter = Object.defineProperty({}, "entryId", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    expect(() =>
      parseFoodDayToolCall({
        name: "REMOVE_FOOD",
        arguments: argumentsWithGetter,
      }),
    ).toThrow(ToolValidationError);
  });
});
