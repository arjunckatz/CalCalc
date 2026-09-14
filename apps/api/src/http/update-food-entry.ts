import {
  DomainValidationError,
  IncompatibleUnitError,
  measurementUnits,
  type NutritionOverride,
  type QuantityOverrideAction,
} from "@cal-calc/domain";
import type { PostgresTransactionRunner } from "@cal-calc/persistence";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthenticatedIdentity } from "../auth/authorization.js";
import {
  updateFoodEntryMutation,
  type UpdateFoodEntryCommand,
} from "../mutations/update-food-entry.js";
import { toFoodEntryDto } from "./food-entry-dto.js";
import { readIdempotencyKey } from "./idempotency-key.js";

interface UpdateFoodEntryRoute {
  readonly Params: { readonly entryId: string };
}

type QuantityCorrectionBody = Omit<UpdateFoodEntryCommand, "entryId">;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nutritionFields = [
  "calories",
  "protein",
  "carbs",
  "fat",
  "fibre",
  "sodium",
] as const;

export class InvalidUpdateFoodEntryRequestError extends Error {
  override readonly name = "InvalidUpdateFoodEntryRequestError";

  constructor() {
    super("Invalid FoodEntry quantity correction request.");
  }
}

export function updateFoodEntryHandler(
  transactionRunner: PostgresTransactionRunner,
) {
  return async (
    identity: AuthenticatedIdentity,
    request: FastifyRequest<UpdateFoodEntryRoute>,
    reply: FastifyReply,
  ) => {
    const idempotencyKey = readIdempotencyKey(request);
    const entryId = parseEntryId(request.params.entryId);
    const body = parseBody(request.body);
    let result;
    try {
      result = await updateFoodEntryMutation(
        { transactionRunner },
        {
          trustedUserId: identity.userId,
          idempotencyKey,
          command: { entryId, ...body },
        },
      );
    } catch (error) {
      if (
        error instanceof DomainValidationError ||
        error instanceof IncompatibleUnitError
      ) {
        throw new InvalidUpdateFoodEntryRequestError();
      }
      throw error;
    }
    return reply.code(200).send({
      disposition: result.disposition,
      appliedRevision: result.appliedRevision,
      entry: toFoodEntryDto(result.entry),
    });
  };
}

function parseEntryId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !uuidPattern.test(value)
  ) {
    throw new InvalidUpdateFoodEntryRequestError();
  }
  return value;
}

function parseBody(value: unknown): QuantityCorrectionBody {
  const body = object(value, [
    "expectedRevision",
    "quantity",
    "overrideAction",
  ]);
  const quantity = object(body.quantity, ["amount", "unit"]);
  if (
    typeof body.expectedRevision !== "number" ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 1 ||
    !member(quantity.unit, measurementUnits)
  ) {
    throw new InvalidUpdateFoodEntryRequestError();
  }
  decimalText(quantity.amount);
  return {
    expectedRevision: body.expectedRevision,
    quantity: quantity as unknown as QuantityCorrectionBody["quantity"],
    overrideAction: parseOverrideAction(body.overrideAction),
  };
}

function parseOverrideAction(value: unknown): QuantityOverrideAction {
  const action = object(value, ["type", "override"]);
  if (action.type === "PRESERVE" || action.type === "CLEAR") {
    exactFields(action, ["type"]);
    return { type: action.type };
  }
  if (action.type !== "REPLACE") {
    throw new InvalidUpdateFoodEntryRequestError();
  }
  exactFields(action, ["type", "override"]);
  const override = object(action.override, nutritionFields);
  for (const field of nutritionFields) {
    if (Object.hasOwn(override, field)) decimalText(override[field]);
  }
  return { type: "REPLACE", override: override as NutritionOverride };
}

function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidUpdateFoodEntryRequestError();
  }
  exactFields(value, fields);
  return value as Record<string, unknown>;
}

function exactFields(value: object, fields: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new InvalidUpdateFoodEntryRequestError();
  }
}

function member(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function decimalText(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^\d+(?:\.\d+)?$/.test(value.trim())
  ) {
    throw new InvalidUpdateFoodEntryRequestError();
  }
}
