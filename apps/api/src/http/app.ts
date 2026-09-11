import type { ServerResponse } from "node:http";

import {
  PostgresFoodDayRepository,
  SemanticOperationIdempotencyConflictError,
  SemanticOperationStateConflictError,
  type PostgresExecutor,
  type PostgresTransactionRunner,
} from "@cal-calc/persistence";
import Fastify, { type FastifyInstance } from "fastify";

import {
  AuthenticationError,
  type AccessTokenVerifier,
} from "../auth/authorization.js";
import { authenticatedHandler } from "./authenticated-handler.js";
import { toFoodDayDto } from "./food-day-dto.js";
import {
  createFoodDayMutation,
  InvalidCreateFoodDayCommandError,
  parseCreateFoodDayCommand,
} from "../mutations/create-food-day.js";
import { MutationIdentityError } from "../mutations/mutation-identity.js";
import { readIdempotencyKey } from "./idempotency-key.js";
import {
  createFoodEntryHandler,
  InvalidCreateFoodEntryRequestError,
} from "./create-food-entry.js";

export interface ApiAppDependencies {
  readonly authVerifier: AccessTokenVerifier;
  readonly postgres: PostgresExecutor;
  readonly transactionRunner: PostgresTransactionRunner;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApiApp(
  dependencies: ApiAppDependencies,
): FastifyInstance {
  const app = Fastify({
    logger: false,
    exposeHeadRoutes: false,
    routerOptions: {
      onBadUrl: (_path, _request, response) => {
        sendRouterError(response, 400);
      },
      onMaxParamLength: (_path, _request, response) => {
        sendRouterError(response, 414);
      },
    },
  });
  const foodDays = new PostgresFoodDayRepository(dependencies.postgres);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof InvalidCreateFoodEntryRequestError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_CREATE_FOOD_ENTRY",
          message: "Invalid FoodEntry creation request.",
        },
      });
    }
    if (error instanceof InvalidCreateFoodDayCommandError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_CREATE_FOOD_DAY",
          message: "Invalid FoodDay creation request.",
        },
      });
    }
    if (
      error instanceof MutationIdentityError &&
      error.reason === "INVALID_IDEMPOTENCY_KEY"
    ) {
      return reply.code(400).send({
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "A valid Idempotency-Key is required.",
        },
      });
    }
    if (error instanceof SemanticOperationIdempotencyConflictError) {
      return reply.code(409).send({
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "Idempotency key was already used for a different request.",
        },
      });
    }
    if (
      error instanceof SemanticOperationStateConflictError &&
      (error.actualStatus === "PENDING" || error.actualStatus === "FAILED")
    ) {
      return reply.code(409).send({
        error: {
          code: "OPERATION_NOT_REPLAYABLE",
          message: "This operation cannot currently be replayed.",
        },
      });
    }
    if (
      error instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
      error instanceof Fastify.errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY ||
      error instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH
    ) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Invalid request." },
      });
    }
    if (error instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE) {
      return reply.code(415).send({
        error: {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Unsupported media type.",
        },
      });
    }
    if (error instanceof Fastify.errorCodes.FST_ERR_CTP_BODY_TOO_LARGE) {
      return reply.code(413).send({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body is too large.",
        },
      });
    }
    if (error instanceof AuthenticationError) {
      return reply.code(401).send({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication required.",
        },
      });
    }
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred.",
      },
    });
  });
  app.setNotFoundHandler((_request, reply) => {
    return reply
      .code(404)
      .send({ error: { code: "NOT_FOUND", message: "Resource not found." } });
  });

  app.get<{ Params: { foodDayId: string } }>(
    "/v1/food-days/:foodDayId",
    authenticatedHandler<{ Params: { foodDayId: string } }>(
      dependencies.authVerifier,
      async (identity, request, reply) => {
        const { foodDayId } = request.params;
        if (foodDayId.length !== 36 || !uuidPattern.test(foodDayId)) {
          return reply.code(400).send({
            error: {
              code: "INVALID_FOOD_DAY_ID",
              message: "Food day ID must be a UUID.",
            },
          });
        }
        const found = await foodDays.findById(identity.userId, foodDayId);
        if (found === null) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Resource not found." },
          });
        }
        return toFoodDayDto(found);
      },
    ),
  );
  app.post(
    "/v1/food-days",
    { bodyLimit: 16 * 1024 },
    authenticatedHandler(
      dependencies.authVerifier,
      async (identity, request, reply) => {
        const idempotencyKey = readIdempotencyKey(request);
        const command = parseCreateFoodDayCommand(request.body);
        const result = await createFoodDayMutation(
          { transactionRunner: dependencies.transactionRunner },
          { trustedUserId: identity.userId, idempotencyKey, command },
        );
        return reply
          .code(result.disposition === "CREATED" ? 201 : 200)
          .send(result);
      },
    ),
  );
  app.post(
    "/v1/food-entries",
    { bodyLimit: 16 * 1024 },
    authenticatedHandler(
      dependencies.authVerifier,
      createFoodEntryHandler(dependencies.transactionRunner),
    ),
  );
  return app;
}

function sendRouterError(
  response: ServerResponse,
  statusCode: 400 | 414,
): void {
  const error =
    statusCode === 400
      ? { code: "INVALID_REQUEST", message: "Invalid request." }
      : { code: "URI_TOO_LONG", message: "Request URI is too long." };
  const body = JSON.stringify({ error });
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}
