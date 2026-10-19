import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  parseAccountTurnRoutingResolution,
  type AccountTurnRoutingResolution,
  type MaterializeAccountTurnFoodDayResult,
  type PostgresAccountConversationTurnRepository,
} from "@cal-calc/persistence";

import {
  deriveAccountTurnIdentity,
  type AccountTurnRequest,
} from "./account-turn.js";
import {
  acceptLocalDate,
  type AcceptedCalendarContext,
} from "./calendar-context.js";
import {
  resolveFoodDayTarget,
  type FoodDayTargetResolutionModel,
  type ValidatedFoodDayTarget,
} from "./resolve-food-day-target.js";
import {
  buildRoutingContext,
  type RoutingRepositories,
} from "./routing-context.js";

export interface AccountConversationTurnDependencies {
  readonly turns: Pick<
    PostgresAccountConversationTurnRepository,
    "claimPending" | "setRoutingResolutionOnce"
  >;
  readonly routing: RoutingRepositories;
  readonly model: FoodDayTargetResolutionModel;
  readonly materializeFoodDay: (input: {
    readonly trustedUserId: string;
    readonly turnId: string;
  }) => Promise<MaterializeAccountTurnFoodDayResult>;
}

export interface RunAccountConversationTurnRequest extends Omit<
  AccountTurnRequest,
  "calendarContext"
> {
  readonly calendarContext: AcceptedCalendarContext | null;
}

export type AccountConversationTurnResult =
  | { readonly kind: "COMPLETED_REPLAY"; readonly response: string }
  | {
      readonly kind: "FOOD_DAY_READY";
      readonly foodDayId: string;
      readonly source: "CREATED" | "EXISTING";
      readonly resolution: Extract<
        AccountTurnRoutingResolution,
        { kind: "DATE_TARGET" }
      >;
    }
  | {
      readonly kind: "FOOD_DAY_READY";
      readonly foodDayId: string;
      readonly source: "RESOLVED_EXISTING";
      readonly resolution: Extract<
        AccountTurnRoutingResolution,
        { kind: "EXISTING_DAY" | "EXISTING_ENTRY_REFERENCE" }
      >;
    }
  | { readonly kind: "TARGETS_REQUIRED"; readonly localDate: string }
  | { readonly kind: "AMBIGUOUS_EXISTING_DAYS"; readonly localDate: string }
  | { readonly kind: "DAYLESS_READY" }
  | { readonly kind: "CLARIFICATION_READY"; readonly question: string };

/** Durable routing and optional FoodDay acquisition checkpoints only. No
 * transaction spans model inference; no pointer, plan, tool, or response write. */
export async function runAccountConversationTurn(
  dependencies: AccountConversationTurnDependencies,
  request: RunAccountConversationTurnRequest,
): Promise<AccountConversationTurnResult> {
  const identity = deriveAccountTurnIdentity({
    ...request,
    calendarContext:
      request.calendarContext === null
        ? null
        : {
            currentLocalDateTime: request.calendarContext.currentLocalDateTime,
            timeZone: request.calendarContext.timeZone,
          },
  });
  if (!isDeepStrictEqual(identity.calendarContext, request.calendarContext))
    throw new TypeError(
      "Account turn requires an exact accepted calendar context.",
    );
  const claim = await dependencies.turns.claimPending({
    id: randomUUID(),
    ...identity,
  });
  const existing = claim.turn;
  if (existing.status === "COMPLETED") {
    if (existing.response === null)
      throw new TypeError("Completed account turn lacks a response.");
    return { kind: "COMPLETED_REPLAY", response: existing.response };
  }
  if (existing.routingResolution !== null) {
    return resolveExecutionTarget(
      dependencies,
      identity.userId,
      existing.id,
      parseAccountTurnRoutingResolution(existing.routingResolution),
    );
  }

  const explicit = inspectLiteralIsoDates(identity.userMessage);
  let resolution: ValidatedFoodDayTarget;
  if (explicit.kind === "AMBIGUOUS") {
    // More than one literal date, or an impossible literal date, is not a
    // licence to query/select one canonical bucket or ask a model to guess.
    resolution = { kind: "CLARIFY", question: "Which date did you mean?" };
  } else {
    const snapshot = await buildRoutingContext(dependencies.routing, {
      trustedUserId: identity.userId,
      calendarContext: identity.calendarContext,
      explicitLocalDate: explicit.localDate,
    });
    resolution = await resolveFoodDayTarget(dependencies.model, {
      message: identity.userMessage,
      calendarContext: identity.calendarContext,
      snapshot,
    });
  }

  const saved = await dependencies.turns.setRoutingResolutionOnce({
    userId: identity.userId,
    turnKey: identity.turnKey,
    requestFingerprint: identity.requestFingerprint,
    resolution: toPersistedResolution(resolution),
  });
  // A concurrent worker may have completed after this worker's initial read.
  if (saved.status === "COMPLETED") {
    if (saved.response === null)
      throw new TypeError("Completed account turn lacks a response.");
    return { kind: "COMPLETED_REPLAY", response: saved.response };
  }
  if (saved.routingResolution === null)
    throw new TypeError("Account turn resolution was not persisted.");
  return resolveExecutionTarget(
    dependencies,
    identity.userId,
    saved.id,
    parseAccountTurnRoutingResolution(saved.routingResolution),
  );
}

async function resolveExecutionTarget(
  dependencies: AccountConversationTurnDependencies,
  trustedUserId: string,
  turnId: string,
  resolution: AccountTurnRoutingResolution,
): Promise<AccountConversationTurnResult> {
  switch (resolution.kind) {
    case "DATE_TARGET": {
      const materialized = await dependencies.materializeFoodDay({
        trustedUserId,
        turnId,
      });
      switch (materialized.kind) {
        case "FOOD_DAY_READY":
          return {
            kind: "FOOD_DAY_READY",
            foodDayId: materialized.foodDayId,
            source: materialized.source,
            resolution,
          };
        case "TARGETS_REQUIRED":
          return { kind: "TARGETS_REQUIRED", localDate: resolution.localDate };
        case "AMBIGUOUS_EXISTING_DAYS":
          return {
            kind: "AMBIGUOUS_EXISTING_DAYS",
            localDate: resolution.localDate,
          };
      }
      throw new TypeError("Unexpected FoodDay materialization outcome.");
    }
    case "EXISTING_DAY":
    case "EXISTING_ENTRY_REFERENCE":
      return {
        kind: "FOOD_DAY_READY",
        foodDayId: resolution.foodDayId,
        source: "RESOLVED_EXISTING",
        resolution,
      };
    case "DAYLESS":
      return { kind: "DAYLESS_READY" };
    case "CLARIFY":
      return { kind: "CLARIFICATION_READY", question: resolution.question };
  }
}

function toPersistedResolution(
  value: ValidatedFoodDayTarget,
): AccountTurnRoutingResolution {
  return parseAccountTurnRoutingResolution({
    schema: "account-routing-resolution-v1",
    ...value,
  });
}

function inspectLiteralIsoDates(
  message: string,
):
  | { readonly kind: "SINGLE_OR_NONE"; readonly localDate: string | null }
  | { readonly kind: "AMBIGUOUS" } {
  const dates = [
    ...new Set(message.match(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g) ?? []),
  ];
  if (dates.length > 1) return { kind: "AMBIGUOUS" };
  if (dates.length === 0) return { kind: "SINGLE_OR_NONE", localDate: null };
  try {
    return { kind: "SINGLE_OR_NONE", localDate: acceptLocalDate(dates[0]!) };
  } catch {
    return { kind: "AMBIGUOUS" };
  }
}
