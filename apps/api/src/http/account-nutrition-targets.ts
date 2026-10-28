import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  AccountNutritionTargets,
  PostgresAccountNutritionTargetsRepository,
  PostgresTransactionRunner,
} from "@cal-calc/persistence";

import type { AuthenticatedIdentity } from "../auth/authorization.js";
import {
  parseSetAccountNutritionTargetsCommand,
  setAccountNutritionTargetsMutation,
} from "../mutations/set-account-nutrition-targets.js";
import { parseIdempotencyKey } from "../mutations/mutation-identity.js";
import { getAccountNutritionTargets } from "../queries/get-account-nutrition-targets.js";

export class InvalidAccountNutritionTargetsRequestError extends Error {
  override readonly name = "InvalidAccountNutritionTargetsRequestError";

  constructor() {
    super("Invalid account nutrition targets request.");
  }
}

export function getAccountNutritionTargetsHandler(
  targets: Pick<PostgresAccountNutritionTargetsRepository, "findByUser">,
) {
  return async (
    identity: AuthenticatedIdentity,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    assertNoQuery(request.query);
    const result = await getAccountNutritionTargets(
      { targets },
      { trustedUserId: identity.userId },
    );
    return reply
      .code(200)
      .send(
        result.kind === "NOT_CONFIGURED"
          ? { status: "NOT_CONFIGURED" }
          : configuredDto(result.targets),
      );
  };
}

export function putAccountNutritionTargetsHandler(
  transactionRunner: PostgresTransactionRunner,
) {
  return async (
    identity: AuthenticatedIdentity,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    assertNoQuery(request.query);
    const body = strictBody(request.body);
    const idempotencyKey = parseIdempotencyKey(body.retryKey);
    const command = parseSetAccountNutritionTargetsCommand({
      expectedVersion: body.expectedVersion,
      calorieTarget: body.calorieTarget,
      proteinTarget: body.proteinTarget,
    });
    const result = await setAccountNutritionTargetsMutation(
      { transactionRunner },
      {
        trustedUserId: identity.userId,
        idempotencyKey,
        command,
      },
    );
    // Both first application and durable replay expose the same saved value.
    return reply.code(200).send(configuredDto(result.targets));
  };
}

function configuredDto(targets: AccountNutritionTargets) {
  return {
    status: "CONFIGURED" as const,
    calorieTarget: targets.calorieTarget,
    proteinTarget: targets.proteinTarget,
    version: targets.version,
  };
}

function assertNoQuery(value: unknown): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 0
  ) {
    throw new InvalidAccountNutritionTargetsRequestError();
  }
}

function strictBody(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidAccountNutritionTargetsRequestError();
  }
  const fields = [
    "retryKey",
    "expectedVersion",
    "calorieTarget",
    "proteinTarget",
  ];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => {
      if (typeof key !== "string" || !fields.includes(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable !== true || !("value" in descriptor);
    })
  ) {
    throw new InvalidAccountNutritionTargetsRequestError();
  }
  return value as Record<string, unknown>;
}
