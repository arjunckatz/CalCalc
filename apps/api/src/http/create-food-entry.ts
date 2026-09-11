import {
  DomainValidationError,
  IncompatibleUnitError,
  evidenceClasses,
  measurementUnits,
} from "@cal-calc/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PostgresTransactionRunner } from "@cal-calc/persistence";

import type { AuthenticatedIdentity } from "../auth/authorization.js";
import {
  createFoodEntryMutation,
  type CreateFoodEntryCommand,
} from "../mutations/create-food-entry.js";
import { readIdempotencyKey } from "./idempotency-key.js";
import { toFoodEntryDto } from "./food-entry-dto.js";

export class InvalidCreateFoodEntryRequestError extends Error {
  override readonly name = "InvalidCreateFoodEntryRequestError";
  constructor() {
    super("Invalid FoodEntry creation request.");
  }
}

export function createFoodEntryHandler(
  transactionRunner: PostgresTransactionRunner,
) {
  return async (
    identity: AuthenticatedIdentity,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const idempotencyKey = readIdempotencyKey(request);
    const command = parseBody(request.body);
    let result;
    try {
      result = await createFoodEntryMutation(
        { transactionRunner },
        {
          trustedUserId: identity.userId,
          idempotencyKey,
          command,
        },
      );
    } catch (error) {
      if (
        error instanceof DomainValidationError ||
        error instanceof IncompatibleUnitError
      ) {
        throw new InvalidCreateFoodEntryRequestError();
      }
      throw error;
    }
    return reply.code(result.disposition === "CREATED" ? 201 : 200).send({
      disposition: result.disposition,
      entry: toFoodEntryDto(result.entry),
    });
  };
}

function parseBody(value: unknown): CreateFoodEntryCommand {
  const body = object(value, [
    "foodDayId",
    "rawUserDescription",
    "displayName",
    "quantity",
    "nutritionBasis",
    "evidenceClass",
  ]);
  const quantity = object(body.quantity, ["amount", "unit"]);
  const basis = object(body.nutritionBasis, ["amount", "unit", "nutrition"]);
  const nutrition = object(basis.nutrition, [
    "calories",
    "protein",
    "carbs",
    "fat",
    "fibre",
    "sodium",
  ]);
  if (
    typeof body.foodDayId !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
      body.foodDayId.trim(),
    ) ||
    typeof body.rawUserDescription !== "string" ||
    typeof body.displayName !== "string" ||
    !member(body.evidenceClass, evidenceClasses) ||
    !member(quantity.unit, measurementUnits) ||
    !member(basis.unit, measurementUnits)
  ) {
    throw new InvalidCreateFoodEntryRequestError();
  }
  decimalText(quantity.amount);
  decimalText(basis.amount);
  decimalText(nutrition.calories);
  for (const key of ["protein", "carbs", "fat", "fibre", "sodium"]) {
    if (Object.hasOwn(nutrition, key)) decimalText(nutrition[key]);
  }
  // Structure is checked without coercion; domain creation owns numeric semantics.
  return body as unknown as CreateFoodEntryCommand;
}

function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new InvalidCreateFoodEntryRequestError();
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new InvalidCreateFoodEntryRequestError();
  }
  return value as Record<string, unknown>;
}

function member(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function decimalText(value: unknown): void {
  // Bound wire decimal expansion, matching the existing FoodDay transport convention.
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^\d+(?:\.\d+)?$/.test(value.trim())
  ) {
    throw new InvalidCreateFoodEntryRequestError();
  }
}
