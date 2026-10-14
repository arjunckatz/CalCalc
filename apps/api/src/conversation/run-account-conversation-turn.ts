import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  parseAccountTurnRoutingResolution,
  type AccountTurnRoutingResolution,
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
      readonly kind: "RESOLUTION_READY";
      readonly resolution: AccountTurnRoutingResolution;
    };

/** Durable routing checkpoint only: no transaction spans model inference and
 * no FoodDay, FoodEntry, pointer, plan, tool, or public response is written. */
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
    return {
      kind: "RESOLUTION_READY",
      resolution: parseAccountTurnRoutingResolution(existing.routingResolution),
    };
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
  return {
    kind: "RESOLUTION_READY",
    resolution: parseAccountTurnRoutingResolution(saved.routingResolution),
  };
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
