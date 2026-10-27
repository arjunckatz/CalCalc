import type {
  AccountTurnPlan,
  PostgresAccountConversationTurnRepository,
  PostgresAccountTurnStepResultRepository,
} from "@cal-calc/persistence";

import { executeBodyWeightHistoryRead } from "../agent/tools/execute-food-day-tool.js";
import type { GetBodyWeightHistoryDependencies } from "../queries/get-body-weight-history.js";
import type {
  DurableFoodDayFinalizationInput,
  DurableFoodDayTurnFinalizer,
} from "../agent/turn/food-day-turn-types.js";
import type { ListFoodEntriesForFoodDayDependencies } from "../queries/list-food-entries-for-food-day.js";
import {
  parseFinalizationStep,
  validText,
} from "../agent/turn/run-food-day-turn.js";
import { getFoodDayState } from "../state/get-food-day-state.js";
import { parseFoodDayExecutionPlan } from "./food-day-execution-plan.js";
import {
  AccountTurnPlanIntegrityError,
  durableTarget,
} from "./run-account-conversation-planning-turn.js";
import {
  AccountTurnStepIntegrityError,
  normalizeAccountTurnToolResult,
  validateAccountTurnStepResult,
} from "./account-turn-step-result.js";

export interface FinalizeAccountConversationTurnDependencies
  extends
    GetBodyWeightHistoryDependencies,
    ListFoodEntriesForFoodDayDependencies {
  readonly turns: Pick<
    PostgresAccountConversationTurnRepository,
    | "findCompletionState"
    | "findById"
    | "findExecutionCheckpoint"
    | "markCompleted"
  >;
  readonly stepResults: Pick<
    PostgresAccountTurnStepResultRepository,
    "listForTurn"
  >;
  readonly model: DurableFoodDayTurnFinalizer;
}

export class AccountTurnFinalizationNotReadyError extends Error {
  override readonly name = "AccountTurnFinalizationNotReadyError";
  constructor() {
    super("Account turn execution is not complete.");
  }
}

export class AccountTurnFinalizationIntegrityError extends Error {
  override readonly name = "AccountTurnFinalizationIntegrityError";
  constructor() {
    super("Account turn finalization state is inconsistent.");
  }
}

/** A separate boundary: reads completed effects, but never executes plan slots. */
export async function finalizeAccountConversationTurn(
  dependencies: FinalizeAccountConversationTurnDependencies,
  input: { readonly trustedUserId: string; readonly turnId: string },
): Promise<{ readonly response: string }> {
  const completion = await dependencies.turns.findCompletionState(
    input.trustedUserId,
    input.turnId,
  );
  if (completion === null) throw new AccountTurnFinalizationNotReadyError();
  if (completion.status === "COMPLETED") {
    if (completion.response === null)
      throw new AccountTurnFinalizationIntegrityError();
    return { response: completion.response };
  }

  const turn = await dependencies.turns.findById(
    input.trustedUserId,
    input.turnId,
  );
  if (turn === null) throw new AccountTurnFinalizationIntegrityError();
  if (turn.status === "COMPLETED") {
    if (turn.response === null)
      throw new AccountTurnFinalizationIntegrityError();
    return { response: turn.response };
  }
  if (turn.executionPlan === null)
    throw new AccountTurnFinalizationNotReadyError();
  const checkpoint = await dependencies.turns.findExecutionCheckpoint(
    input.trustedUserId,
    turn.id,
  );
  if (checkpoint?.status === "COMPLETED") {
    const winner = await dependencies.turns.findCompletionState(
      input.trustedUserId,
      turn.id,
    );
    if (winner?.status === "COMPLETED" && winner.response !== null)
      return { response: winner.response };
    throw new AccountTurnFinalizationIntegrityError();
  }
  if (checkpoint === null || checkpoint.userId !== input.trustedUserId)
    throw new AccountTurnFinalizationIntegrityError();
  let foodDayId: string;
  let plan: AccountTurnPlan;
  try {
    foodDayId = durableTarget(checkpoint, turn);
    plan = parseFoodDayExecutionPlan(turn.executionPlan, foodDayId);
  } catch {
    throw new AccountTurnPlanIntegrityError();
  }
  const rows = await dependencies.stepResults.listForTurn(
    input.trustedUserId,
    turn.id,
  );
  const direct = plan.slots[0]?.action === "DIRECT_RESPONSE";
  if (direct) {
    if (rows.length !== 0) throw new AccountTurnStepIntegrityError();
    return complete(
      dependencies.turns,
      turn,
      plan.slots[0]!.command.response as string,
    );
  }
  if (rows.length < plan.slots.length) {
    // A partial valid prefix is not a finalization result.
    for (const [index, row] of rows.entries())
      validateRow(row, plan, index, input.trustedUserId, turn.id, foodDayId);
    throw new AccountTurnFinalizationNotReadyError();
  }
  if (rows.length !== plan.slots.length)
    throw new AccountTurnStepIntegrityError();
  const toolResults: DurableFoodDayFinalizationInput["toolResults"][number][] =
    [];
  for (const [index, row] of rows.entries()) {
    const result = validateRow(
      row,
      plan,
      index,
      input.trustedUserId,
      turn.id,
      foodDayId,
    );
    const slot = plan.slots[index]!;
    if (slot.action === "DIRECT_RESPONSE")
      throw new AccountTurnStepIntegrityError();
    toolResults.push({
      name: slot.action,
      command: slot.command,
      outcome: result.outcome,
    });
  }

  // This canonical snapshot is response context only; it cannot alter the plan
  // or its frozen optimistic preconditions. No newer account transcript is read.
  const stateAfterExecution = await getFoodDayState(dependencies, {
    trustedUserId: input.trustedUserId,
    foodDayId,
  });
  const finalizationInput: DurableFoodDayFinalizationInput = {
    userMessage: turn.userMessage,
    stateAfterExecution,
    toolResults,
  };
  const first = parseFinalizationStep(
    await dependencies.model.finalizeDurableOrRead(finalizationInput),
    true,
  );
  let response: string;
  if (first.type === "FINAL") {
    response = first.text;
  } else {
    const history = await executeBodyWeightHistoryRead(
      dependencies,
      input.trustedUserId,
    );
    const continuation = normalizeAccountTurnToolResult(
      {
        index: plan.slots.length,
        action: "GET_BODY_WEIGHT_HISTORY",
        command: {},
      },
      history,
      foodDayId,
    );
    response = validText(
      await dependencies.model.finalizeDurable({
        ...finalizationInput,
        toolResults: [
          ...toolResults,
          {
            name: "GET_BODY_WEIGHT_HISTORY",
            command: {},
            outcome: continuation.outcome,
          },
        ],
      }),
      "INVALID_FINAL_TEXT",
      true,
    );
  }
  return complete(dependencies.turns, turn, response);
}

function validateRow(
  row: Awaited<
    ReturnType<PostgresAccountTurnStepResultRepository["listForTurn"]>
  >[number],
  plan: AccountTurnPlan,
  index: number,
  userId: string,
  turnId: string,
  foodDayId: string,
) {
  const slot = plan.slots[index];
  if (
    slot === undefined ||
    row.ordinal !== index ||
    row.userId !== userId ||
    row.turnId !== turnId
  )
    throw new AccountTurnStepIntegrityError();
  return validateAccountTurnStepResult(row.result, slot, foodDayId);
}

async function complete(
  turns: FinalizeAccountConversationTurnDependencies["turns"],
  turn: {
    readonly userId: string;
    readonly turnKey: string;
    readonly requestFingerprint: string;
  },
  response: string,
): Promise<{ readonly response: string }> {
  const saved = await turns.markCompleted({
    userId: turn.userId,
    turnKey: turn.turnKey,
    requestFingerprint: turn.requestFingerprint,
    response,
  });
  if (saved.turn.status !== "COMPLETED" || saved.turn.response === null)
    throw new AccountTurnFinalizationIntegrityError();
  return { response: saved.turn.response };
}
