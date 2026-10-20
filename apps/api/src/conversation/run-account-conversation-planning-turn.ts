import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  AccountTurnExecutionCheckpoint,
  PersistedAccountTurn,
  PostgresAccountConversationTurnRepository,
  AccountTurnPlan,
} from "@cal-calc/persistence";

import type { FoodDayTurnModel } from "../agent/turn/food-day-turn-types.js";
import {
  deriveAccountTurnIdentity,
  type AccountTurnIdentity,
} from "./account-turn.js";
import { deriveCalendarFacts } from "./calendar-context.js";
import {
  createFoodDayExecutionPlan,
  parseFoodDayExecutionPlan,
} from "./food-day-execution-plan.js";
import {
  prepareAccountTurnFoodDayExecution,
  type PrepareAccountTurnFoodDayExecutionDependencies,
  type PrepareAccountTurnFoodDayExecutionResult,
} from "./prepare-account-turn-food-day-execution.js";
import {
  runAccountConversationTurn,
  type AccountConversationTurnDependencies,
  type AccountConversationTurnResult,
  type RunAccountConversationTurnRequest,
} from "./run-account-conversation-turn.js";

export interface RunAccountConversationPlanningTurnDependencies
  extends
    AccountConversationTurnDependencies,
    PrepareAccountTurnFoodDayExecutionDependencies {
  readonly turns: AccountConversationTurnDependencies["turns"] &
    PrepareAccountTurnFoodDayExecutionDependencies["turns"] &
    Pick<
      PostgresAccountConversationTurnRepository,
      "findByKey" | "setPlanOnce" | "listRecentCompleted"
    >;
  readonly foodDayModel: Pick<FoodDayTurnModel, "decide">;
}

export type AccountConversationPlanningTurnResult =
  | {
      readonly kind: "PLAN_READY";
      readonly turnId: string;
      readonly plan: AccountTurnPlan;
    }
  | Exclude<AccountConversationTurnResult, { kind: "FOOD_DAY_READY" }>
  | Extract<
      PrepareAccountTurnFoodDayExecutionResult,
      { kind: "ENTRY_REFERENCE_STALE" }
    >;

export class AccountTurnPlanIntegrityError extends Error {
  override readonly name = "AccountTurnPlanIntegrityError";
  constructor() {
    super(
      "Account turn execution plan is inconsistent with its durable target.",
    );
  }
}

/** Durable initial decision only. No tools, finalization, canonical mutation,
 * active-pointer update, or turn completion occurs in this boundary. */
export async function runAccountConversationPlanningTurn(
  dependencies: RunAccountConversationPlanningTurnDependencies,
  request: RunAccountConversationTurnRequest,
): Promise<AccountConversationPlanningTurnResult> {
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
  const immediate = await priorOutcome(
    dependencies.turns,
    claim.turn,
    identity,
  );
  if (immediate !== null) return immediate;

  let routed: AccountConversationTurnResult;
  try {
    routed = await runAccountConversationTurn(dependencies, request);
  } catch (error) {
    // A concurrent worker can persist a plan while routing/materialization is
    // in progress. The winner is authoritative even if this attempt lost a CAS.
    const current = await dependencies.turns.findByKey(
      identity.userId,
      identity.turnKey,
    );
    if (current !== null) {
      const winner = await priorOutcome(dependencies.turns, current, identity);
      if (winner !== null) return winner;
    }
    throw error;
  }
  if (routed.kind !== "FOOD_DAY_READY") return routed;
  // Close the ordinary race window before M5A8A/state/transcript work.
  const latest = await dependencies.turns.findByKey(
    identity.userId,
    identity.turnKey,
  );
  if (latest === null) throw new AccountTurnPlanIntegrityError();
  const winner = await priorOutcome(dependencies.turns, latest, identity);
  if (winner !== null) return winner;

  const prepared = await prepareAccountTurnFoodDayExecution(dependencies, {
    trustedUserId: identity.userId,
    ready: routed,
  });
  if (prepared.kind === "ENTRY_REFERENCE_STALE") return prepared;
  if (prepared.turnId !== latest.id || prepared.foodDayId !== routed.foodDayId)
    throw new AccountTurnPlanIntegrityError();
  const transcript = await dependencies.turns.listRecentCompleted(
    identity.userId,
  );
  const userMessage = latest.userMessage;
  const calendarContext = calendarForModel(latest);
  const decision = await dependencies.foodDayModel.decide({
    userMessage,
    state: prepared.state,
    recentTranscript: transcript,
    ...(calendarContext === undefined ? {} : { calendarContext }),
    ...(prepared.routingKind === "EXISTING_ENTRY_REFERENCE"
      ? { entryReference: prepared.entryReference }
      : {}),
  });
  const proposal = createFoodDayExecutionPlan({
    decision,
    state: prepared.state,
    userMessage,
    ...(calendarContext === undefined ? {} : { calendarContext }),
  });
  let saved: PersistedAccountTurn;
  try {
    saved = await dependencies.turns.setPlanOnce({
      userId: identity.userId,
      turnKey: identity.turnKey,
      requestFingerprint: identity.requestFingerprint,
      plan: proposal,
    });
  } catch (error) {
    // A completion or committed first writer can overtake this proposal.
    // If there is no durable winner, preserve the original failure.
    let current: PersistedAccountTurn | null;
    try {
      current = await dependencies.turns.findByKey(
        identity.userId,
        identity.turnKey,
      );
    } catch {
      throw error;
    }
    if (current !== null) {
      const winner = await priorOutcome(dependencies.turns, current, identity);
      if (winner !== null) return winner;
    }
    throw error;
  }
  const outcome = await priorOutcome(dependencies.turns, saved, identity);
  if (outcome === null) throw new AccountTurnPlanIntegrityError();
  return outcome;
}

async function priorOutcome(
  turns: RunAccountConversationPlanningTurnDependencies["turns"],
  turn: PersistedAccountTurn,
  identity: AccountTurnIdentity,
): Promise<AccountConversationPlanningTurnResult | null> {
  if (
    turn.userId !== identity.userId ||
    turn.turnKey !== identity.turnKey ||
    turn.requestFingerprint !== identity.requestFingerprint ||
    turn.userMessage !== identity.userMessage
  )
    throw new AccountTurnPlanIntegrityError();
  if (turn.status === "COMPLETED") {
    if (turn.response === null) throw new AccountTurnPlanIntegrityError();
    return { kind: "COMPLETED_REPLAY", response: turn.response };
  }
  if (turn.executionPlan === null) return null;
  const checkpoint = await turns.findExecutionCheckpoint(
    identity.userId,
    turn.id,
  );
  if (checkpoint?.status === "COMPLETED") {
    const completed = await turns.findByKey(identity.userId, identity.turnKey);
    if (completed?.status === "COMPLETED")
      return priorOutcome(turns, completed, identity);
    throw new AccountTurnPlanIntegrityError();
  }
  if (!isDeepStrictEqual(checkpoint?.routingResolution, turn.routingResolution))
    throw new AccountTurnPlanIntegrityError();
  const foodDayId = durableTarget(checkpoint, turn);
  let plan: AccountTurnPlan;
  try {
    plan = parseFoodDayExecutionPlan(turn.executionPlan, foodDayId);
  } catch {
    throw new AccountTurnPlanIntegrityError();
  }
  return { kind: "PLAN_READY", turnId: turn.id, plan };
}

export function durableTarget(
  checkpoint: AccountTurnExecutionCheckpoint | null,
  turn: PersistedAccountTurn,
): string {
  if (
    checkpoint === null ||
    checkpoint.turnId !== turn.id ||
    checkpoint.userId !== turn.userId ||
    checkpoint.status !== "PENDING" ||
    checkpoint.routingResolution === null
  )
    throw new AccountTurnPlanIntegrityError();
  const resolution = checkpoint.routingResolution;
  const target =
    resolution.kind === "DATE_TARGET"
      ? checkpoint.materializedFoodDayId
      : resolution.kind === "EXISTING_DAY" ||
          resolution.kind === "EXISTING_ENTRY_REFERENCE"
        ? checkpoint.resolvedFoodDayId
        : null;
  if (
    target === null ||
    ((resolution.kind === "EXISTING_DAY" ||
      resolution.kind === "EXISTING_ENTRY_REFERENCE") &&
      target !== resolution.foodDayId)
  )
    throw new AccountTurnPlanIntegrityError();
  return target;
}

function calendarForModel(turn: PersistedAccountTurn) {
  if (turn.calendarContext === null) return undefined;
  return {
    currentLocalDate:
      turn.calendarContext.schema === "client-calendar-v1"
        ? turn.calendarContext.currentLocalDate
        : deriveCalendarFacts(turn.calendarContext).localDate,
  };
}
