import {
  PostgresFoodDayRepository,
  type PostgresExecutor,
} from "@cal-calc/persistence";
import Fastify, { type FastifyInstance } from "fastify";

import {
  AuthenticationError,
  type AccessTokenVerifier,
} from "../auth/authorization.js";
import { authenticatedHandler } from "./authenticated-handler.js";
import { toFoodDayDto } from "./food-day-dto.js";

export interface ApiAppDependencies {
  readonly authVerifier: AccessTokenVerifier;
  readonly postgres: PostgresExecutor;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApiApp(
  dependencies: ApiAppDependencies,
): FastifyInstance {
  const app = Fastify({ logger: false, exposeHeadRoutes: false });
  const foodDays = new PostgresFoodDayRepository(dependencies.postgres);

  app.setErrorHandler((error, _request, reply) => {
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
  return app;
}
