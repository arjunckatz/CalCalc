import { DomainValidationError } from "@cal-calc/domain";
import type { PostgresTransactionRunner } from "@cal-calc/persistence";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthenticatedIdentity } from "../auth/authorization.js";
import { removeFoodEntryMutation } from "../mutations/remove-food-entry.js";
import { toFoodEntryDto } from "./food-entry-dto.js";
import { readIdempotencyKey } from "./idempotency-key.js";

interface RemoveFoodEntryRoute {
  readonly Params: { readonly entryId: string };
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidRemoveFoodEntryRequestError extends Error {
  override readonly name = "InvalidRemoveFoodEntryRequestError";

  constructor() {
    super("Invalid FoodEntry removal request.");
  }
}

export function removeFoodEntryHandler(
  transactionRunner: PostgresTransactionRunner,
) {
  return async (
    identity: AuthenticatedIdentity,
    request: FastifyRequest<RemoveFoodEntryRoute>,
    reply: FastifyReply,
  ) => {
    const idempotencyKey = readIdempotencyKey(request);
    const entryId = parseEntryId(request.params.entryId);
    const expectedRevision = parseBody(request.body);
    let result;
    try {
      result = await removeFoodEntryMutation(
        { transactionRunner },
        {
          trustedUserId: identity.userId,
          idempotencyKey,
          command: { entryId, expectedRevision },
        },
      );
    } catch (error) {
      if (error instanceof DomainValidationError) {
        throw new InvalidRemoveFoodEntryRequestError();
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
    throw new InvalidRemoveFoodEntryRequestError();
  }
  return value;
}

function parseBody(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRemoveFoodEntryRequestError();
  }
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => key !== "expectedRevision") ||
    typeof body.expectedRevision !== "number" ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 1
  ) {
    throw new InvalidRemoveFoodEntryRequestError();
  }
  return body.expectedRevision;
}
