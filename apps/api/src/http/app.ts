import type { ServerResponse } from "node:http";

import {
  FoodDayNotFoundError,
  FoodDayTurnIdempotencyConflictError,
  FoodEntryNotFoundError,
  FoodEntryRevisionConflictError,
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
import { OpenAIFoodDayModelProtocolError } from "../agent/providers/openai/openai-food-day-turn-model.js";
import type { FoodDayTurnRunner } from "../agent/turn/create-food-day-turn-runner.js";
import {
  FoodDayTurnExecutionError,
  FoodDayTurnValidationError,
} from "../agent/turn/run-food-day-turn.js";
import { ToolValidationError } from "../agent/tools/food-day-tools.js";
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
import {
  InvalidUpdateFoodEntryRequestError,
  updateFoodEntryHandler,
} from "./update-food-entry.js";
import {
  InvalidRemoveFoodEntryRequestError,
  removeFoodEntryHandler,
} from "./remove-food-entry.js";
import {
  foodDayTurnHandler,
  InvalidFoodDayTurnRequestError,
} from "./food-day-turn.js";

export interface ApiAppDependencies {
  readonly authVerifier: AccessTokenVerifier;
  readonly postgres: PostgresExecutor;
  readonly transactionRunner: PostgresTransactionRunner;
  /** Omission keeps reusable/test app construction independent of model config. */
  readonly foodDayTurn?: FoodDayTurnRunner;
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
    const failure =
      error instanceof FoodDayTurnExecutionError ? error.cause : error;
    if (failure instanceof InvalidFoodDayTurnRequestError) {
      if (failure.reason === "INVALID_FOOD_DAY_ID") {
        return reply.code(400).send({
          error: {
            code: "INVALID_FOOD_DAY_ID",
            message: "Food day ID must be a UUID.",
          },
        });
      }
      return reply.code(400).send({
        error: {
          code: "INVALID_FOOD_DAY_TURN",
          message: "Invalid FoodDay turn request.",
        },
      });
    }
    if (failure instanceof InvalidRemoveFoodEntryRequestError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_REMOVE_FOOD_ENTRY",
          message: "Invalid FoodEntry removal request.",
        },
      });
    }
    if (failure instanceof InvalidUpdateFoodEntryRequestError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_UPDATE_FOOD_ENTRY",
          message: "Invalid FoodEntry quantity correction request.",
        },
      });
    }
    if (failure instanceof InvalidCreateFoodEntryRequestError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_CREATE_FOOD_ENTRY",
          message: "Invalid FoodEntry creation request.",
        },
      });
    }
    if (failure instanceof InvalidCreateFoodDayCommandError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_CREATE_FOOD_DAY",
          message: "Invalid FoodDay creation request.",
        },
      });
    }
    if (
      failure instanceof MutationIdentityError &&
      failure.reason === "INVALID_IDEMPOTENCY_KEY"
    ) {
      return reply.code(400).send({
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "A valid Idempotency-Key is required.",
        },
      });
    }
    if (
      failure instanceof SemanticOperationIdempotencyConflictError ||
      failure instanceof FoodDayTurnIdempotencyConflictError
    ) {
      return reply.code(409).send({
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "Idempotency key was already used for a different request.",
        },
      });
    }
    if (failure instanceof FoodEntryRevisionConflictError) {
      return reply.code(409).send({
        error: {
          code: "FOOD_ENTRY_REVISION_CONFLICT",
          message: "Food entry revision conflict.",
        },
      });
    }
    if (
      failure instanceof FoodEntryNotFoundError ||
      failure instanceof FoodDayNotFoundError
    ) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "Resource not found." },
      });
    }
    if (
      failure instanceof SemanticOperationStateConflictError &&
      (failure.actualStatus === "PENDING" || failure.actualStatus === "FAILED")
    ) {
      return reply.code(409).send({
        error: {
          code: "OPERATION_NOT_REPLAYABLE",
          message: "This operation cannot currently be replayed.",
        },
      });
    }
    if (
      failure instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
      failure instanceof Fastify.errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY ||
      failure instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_CONTENT_LENGTH
    ) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "Invalid request." },
      });
    }
    if (failure instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE) {
      return reply.code(415).send({
        error: {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Unsupported media type.",
        },
      });
    }
    if (failure instanceof Fastify.errorCodes.FST_ERR_CTP_BODY_TOO_LARGE) {
      return reply.code(413).send({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body is too large.",
        },
      });
    }
    if (failure instanceof AuthenticationError) {
      return reply.code(401).send({
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication required.",
        },
      });
    }
    if (
      failure instanceof OpenAIFoodDayModelProtocolError ||
      failure instanceof ToolValidationError ||
      (failure instanceof FoodDayTurnValidationError &&
        (failure.reason === "INVALID_MODEL_DECISION" ||
          failure.reason === "INVALID_FINAL_TEXT"))
    ) {
      return reply.code(502).send({
        error: {
          code: "MODEL_PROVIDER_ERROR",
          message: "The conversational model could not complete the request.",
        },
      });
    }
    if (failure instanceof FoodDayTurnValidationError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_FOOD_DAY_TURN",
          message: "Invalid FoodDay turn request.",
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
  app.patch<{ Params: { entryId: string } }>(
    "/v1/food-entries/:entryId/quantity",
    { bodyLimit: 16 * 1024 },
    authenticatedHandler<{ Params: { entryId: string } }>(
      dependencies.authVerifier,
      updateFoodEntryHandler(dependencies.transactionRunner),
    ),
  );
  app.delete<{ Params: { entryId: string } }>(
    "/v1/food-entries/:entryId",
    { bodyLimit: 16 * 1024 },
    authenticatedHandler<{ Params: { entryId: string } }>(
      dependencies.authVerifier,
      removeFoodEntryHandler(dependencies.transactionRunner),
    ),
  );
  if (dependencies.foodDayTurn !== undefined) {
    app.post<{
      Params: { foodDayId: string };
      Body: unknown;
    }>(
      "/v1/food-days/:foodDayId/turns",
      authenticatedHandler<{
        Params: { foodDayId: string };
        Body: unknown;
      }>(
        dependencies.authVerifier,
        foodDayTurnHandler(dependencies.foodDayTurn),
      ),
    );
  }
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
