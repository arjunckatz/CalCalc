import type { FastifyReply, FastifyRequest } from "fastify";

import { isCanonicalLocalDate } from "../calendar/local-date.js";
import type { FoodDayTurnRunner } from "../agent/turn/create-food-day-turn-runner.js";
import type { AuthenticatedIdentity } from "../auth/authorization.js";
import { readIdempotencyKey } from "./idempotency-key.js";

interface FoodDayTurnRoute {
  Params: { foodDayId: string };
  Body: unknown;
}

type InvalidFoodDayTurnRequestReason = "INVALID_FOOD_DAY_ID" | "INVALID_BODY";

export class InvalidFoodDayTurnRequestError extends Error {
  override readonly name = "InvalidFoodDayTurnRequestError";

  constructor(readonly reason: InvalidFoodDayTurnRequestReason) {
    super(
      reason === "INVALID_FOOD_DAY_ID"
        ? "Food day ID must be a UUID."
        : "Invalid FoodDay turn request.",
    );
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function foodDayTurnHandler(runTurn: FoodDayTurnRunner) {
  return async (
    identity: AuthenticatedIdentity,
    request: FastifyRequest<FoodDayTurnRoute>,
    reply: FastifyReply,
  ) => {
    const foodDayId = parseFoodDayId(request.params.foodDayId);
    const turnIdempotencyKey = readIdempotencyKey(request);
    const { message: userMessage, currentLocalDate } = parseTurnBody(
      request.body,
    );
    const result = await runTurn({
      trustedUserId: identity.userId,
      foodDayId,
      turnIdempotencyKey,
      userMessage,
      ...(currentLocalDate === undefined
        ? {}
        : { calendarContext: { currentLocalDate } }),
    });
    return reply.code(200).send({ response: result.response });
  };
}

function parseFoodDayId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !uuidPattern.test(value)
  ) {
    throw new InvalidFoodDayTurnRequestError("INVALID_FOOD_DAY_ID");
  }
  return value;
}

function parseTurnBody(input: unknown): {
  readonly message: string;
  readonly currentLocalDate?: string;
} {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new InvalidFoodDayTurnRequestError("INVALID_BODY");
  }
  const keys = Reflect.ownKeys(input);
  if (
    !keys.includes("message") ||
    keys.length > 2 ||
    keys.some((key) => key !== "message" && key !== "currentLocalDate")
  ) {
    throw new InvalidFoodDayTurnRequestError("INVALID_BODY");
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, "message");
  const message = descriptor && "value" in descriptor ? descriptor.value : null;
  if (
    descriptor?.enumerable !== true ||
    typeof message !== "string" ||
    message.trim() === ""
  ) {
    throw new InvalidFoodDayTurnRequestError("INVALID_BODY");
  }
  if (!keys.includes("currentLocalDate")) return { message };
  const dateDescriptor = Object.getOwnPropertyDescriptor(
    input,
    "currentLocalDate",
  );
  const currentLocalDate =
    dateDescriptor && "value" in dateDescriptor ? dateDescriptor.value : null;
  if (
    dateDescriptor?.enumerable !== true ||
    !isCanonicalLocalDate(currentLocalDate)
  ) {
    throw new InvalidFoodDayTurnRequestError("INVALID_BODY");
  }
  return { message, currentLocalDate };
}
