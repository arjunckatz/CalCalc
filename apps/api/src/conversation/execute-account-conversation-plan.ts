import { isDeepStrictEqual } from "node:util";

import type {
  AccountTurnPlan,
  AccountTurnStepResult,
  PersistedAccountTurn,
  PostgresAccountConversationTurnRepository,
  PostgresAccountTurnStepResultRepository,
} from "@cal-calc/persistence";

import {
  executeFoodDayTool,
  type ExecuteFoodDayToolDependencies,
} from "../agent/tools/execute-food-day-tool.js";
import { parseFoodDayToolCall } from "../agent/tools/food-day-tools.js";
import { deriveCalendarFacts } from "./calendar-context.js";
import { parseFoodDayExecutionPlan } from "./food-day-execution-plan.js";
import {
  AccountTurnPlanIntegrityError,
  durableTarget,
} from "./run-account-conversation-planning-turn.js";
import { deriveAccountTurnPlanStepKey } from "./account-turn-step-identity.js";
import {
  AccountTurnStepIntegrityError,
  normalizeAccountTurnToolResult,
  sameAccountTurnMutationEffect,
  validateAccountTurnStepResult,
} from "./account-turn-step-result.js";

export interface ExecuteAccountConversationPlanDependencies extends ExecuteFoodDayToolDependencies {
  readonly turns: Pick<
    PostgresAccountConversationTurnRepository,
    "findById" | "findExecutionCheckpoint"
  >;
  readonly stepResults: Pick<
    PostgresAccountTurnStepResultRepository,
    "listForTurn" | "setOnce"
  >;
}

export type AccountConversationPlanExecutionResult =
  | { readonly kind: "COMPLETED_REPLAY"; readonly response: string }
  | { readonly kind: "DIRECT_RESPONSE_READY"; readonly response: string }
  | {
      readonly kind: "TOOL_SEQUENCE_EXECUTED";
      readonly plan: AccountTurnPlan;
      readonly orderedStepResults: readonly AccountTurnStepResult[];
    };

export class AccountTurnPlanNotReadyError extends Error {
  override readonly name = "AccountTurnPlanNotReadyError";
  constructor() {
    super("Account turn has no durable execution plan.");
  }
}

export class AccountTurnExecutionNotFoundError extends Error {
  override readonly name = "AccountTurnExecutionNotFoundError";
  constructor() {
    super("Account turn was not found for this user.");
  }
}

/** Executes only a persisted plan; no STATE, transcript, model or turn completion. */
export async function executeAccountConversationPlan(
  dependencies: ExecuteAccountConversationPlanDependencies,
  input: { readonly trustedUserId: string; readonly turnId: string },
): Promise<AccountConversationPlanExecutionResult> {
  const turn = await dependencies.turns.findById(
    input.trustedUserId,
    input.turnId,
  );
  if (turn === null) throw new AccountTurnExecutionNotFoundError();
  if (turn.status === "COMPLETED") {
    if (turn.response === null) throw new AccountTurnPlanIntegrityError();
    return { kind: "COMPLETED_REPLAY", response: turn.response };
  }
  if (turn.executionPlan === null) throw new AccountTurnPlanNotReadyError();
  const checkpoint = await dependencies.turns.findExecutionCheckpoint(
    input.trustedUserId,
    turn.id,
  );
  if (checkpoint?.status === "COMPLETED") {
    const latest = await dependencies.turns.findById(
      input.trustedUserId,
      turn.id,
    );
    if (latest?.status === "COMPLETED" && latest.response !== null)
      return { kind: "COMPLETED_REPLAY", response: latest.response };
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
  const stored = await dependencies.stepResults.listForTurn(
    input.trustedUserId,
    turn.id,
  );
  if (plan.slots[0]?.action === "DIRECT_RESPONSE") {
    if (stored.length !== 0) throw new AccountTurnStepIntegrityError();
    return {
      kind: "DIRECT_RESPONSE_READY",
      response: plan.slots[0].command.response as string,
    };
  }
  if (stored.length > plan.slots.length)
    throw new AccountTurnStepIntegrityError();
  const orderedStepResults: AccountTurnStepResult[] = [];
  for (const [index, row] of stored.entries()) {
    const slot = plan.slots[index];
    if (
      slot === undefined ||
      row.userId !== input.trustedUserId ||
      row.turnId !== turn.id ||
      row.ordinal !== index
    )
      throw new AccountTurnStepIntegrityError();
    orderedStepResults.push(
      validateAccountTurnStepResult(row.result, slot, foodDayId),
    );
  }
  for (let index = stored.length; index < plan.slots.length; index += 1) {
    const slot = plan.slots[index]!;
    const tool = await executeFoodDayTool(
      dependencies,
      {
        trustedUserId: input.trustedUserId,
        foodDayId,
        idempotencyKey: deriveAccountTurnPlanStepKey(
          input.trustedUserId,
          turn.id,
          index,
        ),
        operationScope: "ACCOUNT_TURN_PLAN_STEP",
        stateCompleteness:
          slot.action === "SET_FOOD_DAY_COMPLETENESS"
            ? (slot.command.expectedCompleteness as
                "UNKNOWN" | "PARTIAL" | "USER_DECLARED_COMPLETE")
            : "UNKNOWN",
        userMessage: turn.userMessage,
        ...calendarForExecution(turn),
      },
      planToolCall(slot),
    );
    const proposed = normalizeAccountTurnToolResult(slot, tool, foodDayId);
    const saved = await dependencies.stepResults.setOnce({
      userId: input.trustedUserId,
      turnId: turn.id,
      ordinal: index,
      result: proposed,
    });
    if (
      saved.userId !== input.trustedUserId ||
      saved.turnId !== turn.id ||
      saved.ordinal !== index
    )
      throw new AccountTurnStepIntegrityError();
    const winner = validateAccountTurnStepResult(saved.result, slot, foodDayId);
    if (
      slot.action !== "GET_BODY_WEIGHT_HISTORY" &&
      !sameAccountTurnMutationEffect(winner, proposed)
    )
      throw new AccountTurnStepIntegrityError();
    orderedStepResults.push(winner);
  }
  return { kind: "TOOL_SEQUENCE_EXECUTED", plan, orderedStepResults };
}

function planToolCall(slot: AccountTurnPlan["slots"][number]) {
  return parseFoodDayToolCall({
    name: slot.action,
    arguments:
      slot.action === "SET_FOOD_DAY_COMPLETENESS"
        ? { targetCompleteness: slot.command.targetCompleteness }
        : slot.command,
  });
}

function calendarForExecution(turn: PersistedAccountTurn) {
  if (turn.calendarContext === null) return {};
  return {
    calendarContext: {
      currentLocalDate:
        turn.calendarContext.schema === "client-calendar-v1"
          ? turn.calendarContext.currentLocalDate
          : deriveCalendarFacts(turn.calendarContext).localDate,
    },
  };
}
