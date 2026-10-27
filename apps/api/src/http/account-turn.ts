import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainValidationError } from "@cal-calc/domain";
import {
  AccountTurnIdempotencyConflictError,
  AccountTurnStateConflictError,
  FoodDayCompletenessConflictError,
} from "@cal-calc/persistence";
import { APIError } from "openai";

import type { AuthenticatedIdentity } from "../auth/authorization.js";
import {
  acceptCalendarContext,
  CalendarContextValidationError,
} from "../conversation/calendar-context.js";
import type { DurableAccountConversationTurnRunner } from "../conversation/create-durable-account-conversation-turn-runner.js";
import { OpenAIFoodDayTargetModelError } from "../conversation/providers/openai/openai-food-day-target-model.js";
import { FoodDayTargetResolutionError } from "../conversation/resolve-food-day-target.js";
import { InvalidLogBodyWeightCommandError } from "../mutations/log-body-weight.js";
import { parseIdempotencyKey } from "../mutations/mutation-identity.js";

interface AccountTurnRoute {
  Body: unknown;
}

export class InvalidAccountTurnRequestError extends Error {
  override readonly name = "InvalidAccountTurnRequestError";
  constructor() {
    super("Invalid account turn request.");
  }
}

export function accountTurnHandler(
  runTurn: DurableAccountConversationTurnRunner,
) {
  return async (
    identity: AuthenticatedIdentity,
    request: FastifyRequest<AccountTurnRoute>,
    reply: FastifyReply,
  ) => {
    try {
      const body = parseAccountTurnBody(request.body);
      const result = await runTurn({
        trustedUserId: identity.userId,
        idempotencyKey: body.retryKey,
        userMessage: body.message,
        calendarContext: body.calendar,
      });
      switch (result.kind) {
        case "COMPLETED":
          return reply
            .code(200)
            .send({ status: "COMPLETED", response: result.response });
        case "CLARIFICATION_READY":
          return reply.code(409).send({
            error: {
              code: "CLARIFICATION_REQUIRED",
              message: "Clarification is required to continue this turn.",
              question: result.question,
            },
          });
        case "TARGETS_REQUIRED":
          return conflict(
            reply,
            "ACCOUNT_NUTRITION_TARGETS_REQUIRED",
            "Account nutrition targets are required.",
          );
        case "AMBIGUOUS_EXISTING_DAYS":
          return conflict(
            reply,
            "AMBIGUOUS_FOOD_DAY",
            "More than one FoodDay matches this request.",
          );
        case "ENTRY_REFERENCE_STALE":
          return conflict(
            reply,
            "ENTRY_REFERENCE_STALE",
            "The referenced food entry has changed.",
          );
        case "DAYLESS_READY":
          return conflict(
            reply,
            "DAYLESS_TURN_NOT_SUPPORTED",
            "Dayless turn execution is not supported yet.",
          );
      }
      throw new TypeError("Unexpected account turn result.");
    } catch (error) {
      if (
        error instanceof CalendarContextValidationError ||
        error instanceof InvalidAccountTurnRequestError
      )
        return reply.code(400).send({
          error: {
            code: "INVALID_ACCOUNT_TURN",
            message: "Invalid account turn request.",
          },
        });
      if (error instanceof AccountTurnIdempotencyConflictError)
        return conflict(
          reply,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used for a different request.",
        );
      if (
        error instanceof AccountTurnStateConflictError ||
        error instanceof FoodDayCompletenessConflictError
      )
        return conflict(
          reply,
          "ACCOUNT_TURN_CONFLICT",
          "Account turn conflicts with current state.",
        );
      if (
        error instanceof DomainValidationError ||
        error instanceof InvalidLogBodyWeightCommandError
      )
        return reply.code(400).send({
          error: {
            code: "INVALID_ACCOUNT_TURN",
            message: "Invalid account turn request.",
          },
        });
      if (
        error instanceof OpenAIFoodDayTargetModelError ||
        error instanceof FoodDayTargetResolutionError ||
        error instanceof APIError
      )
        return reply.code(502).send({
          error: {
            code: "MODEL_PROVIDER_ERROR",
            message: "The conversational model could not complete the request.",
          },
        });
      throw error;
    }
  };
}

function conflict(reply: FastifyReply, code: string, message: string) {
  return reply.code(409).send({ error: { code, message } });
}

function parseAccountTurnBody(input: unknown) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    throw new InvalidAccountTurnRequestError();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length < 2 ||
    keys.length > 3 ||
    !keys.includes("message") ||
    !keys.includes("retryKey") ||
    keys.some(
      (key) => key !== "message" && key !== "retryKey" && key !== "calendar",
    )
  )
    throw new InvalidAccountTurnRequestError();
  const read = (key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.enumerable !== true || !("value" in descriptor))
      throw new InvalidAccountTurnRequestError();
    return descriptor.value as unknown;
  };
  const message = read("message");
  if (typeof message !== "string" || message.trim() === "")
    throw new InvalidAccountTurnRequestError();
  const retryKey = parseIdempotencyKey(read("retryKey"));
  const calendar = acceptCalendarContext(
    keys.includes("calendar") ? read("calendar") : null,
  );
  return { message, retryKey, calendar };
}
