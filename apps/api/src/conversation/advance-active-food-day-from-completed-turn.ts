import { isDeepStrictEqual } from "node:util";

import type {
  PostgresAccountConversationTurnRepository,
  PostgresAccountTurnStepResultRepository,
  PostgresConversationRepository,
} from "@cal-calc/persistence";

import { validateAccountTurnStepResult } from "./account-turn-step-result.js";
import { parseFoodDayExecutionPlan } from "./food-day-execution-plan.js";

const foodMutations = new Set([
  "LOG_FOOD",
  "UPDATE_FOOD_QUANTITY",
  "REMOVE_FOOD",
  "CHANGE_FOOD_STATUS",
  "SET_FOOD_DAY_COMPLETENESS",
]);

export interface AdvanceActiveFoodDayDependencies {
  readonly turns: Pick<
    PostgresAccountConversationTurnRepository,
    "findById" | "findExecutionCheckpoint"
  >;
  readonly stepResults: Pick<
    PostgresAccountTurnStepResultRepository,
    "listForTurn"
  >;
  readonly conversations: Pick<
    PostgresConversationRepository,
    "advanceActiveFoodDayFromCompletedTurn"
  >;
}

export class ActiveFoodDayPointerIntegrityError extends Error {
  override readonly name = "ActiveFoodDayPointerIntegrityError";
  constructor() {
    super("Completed account turn has inconsistent pointer evidence.");
  }
}

/** Completed response is already durable. This owner-scoped, idempotent repair
 * reads no model/STATE and never treats the advisory pointer as authority. */
export async function advanceActiveFoodDayFromCompletedTurn(
  dependencies: AdvanceActiveFoodDayDependencies,
  input: { readonly trustedUserId: string; readonly turnId: string },
): Promise<"ADVANCED" | "UNCHANGED" | "INELIGIBLE"> {
  const turn = await dependencies.turns.findById(
    input.trustedUserId,
    input.turnId,
  );
  if (turn === null || turn.status !== "COMPLETED") return "INELIGIBLE";
  if (turn.userId !== input.trustedUserId || turn.response === null)
    throw new ActiveFoodDayPointerIntegrityError();
  if (turn.executionPlan === null) return "INELIGIBLE";
  const hasFoodMutation = turn.executionPlan.slots.some((slot) =>
    foodMutations.has(slot.action),
  );
  if (!hasFoodMutation) return "INELIGIBLE";

  const checkpoint = await dependencies.turns.findExecutionCheckpoint(
    input.trustedUserId,
    input.turnId,
  );
  if (
    checkpoint === null ||
    checkpoint.status !== "COMPLETED" ||
    checkpoint.userId !== input.trustedUserId ||
    checkpoint.turnId !== input.turnId ||
    checkpoint.routingResolution === null ||
    !isDeepStrictEqual(checkpoint.routingResolution, turn.routingResolution)
  )
    throw new ActiveFoodDayPointerIntegrityError();
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
    throw new ActiveFoodDayPointerIntegrityError();
  const rows = await dependencies.stepResults.listForTurn(
    input.trustedUserId,
    input.turnId,
  );
  try {
    const plan = parseFoodDayExecutionPlan(turn.executionPlan, target);
    if (rows.length !== plan.slots.length)
      throw new ActiveFoodDayPointerIntegrityError();
    for (const [ordinal, row] of rows.entries()) {
      const slot = plan.slots[ordinal];
      if (
        slot === undefined ||
        row.ordinal !== ordinal ||
        row.userId !== input.trustedUserId ||
        row.turnId !== input.turnId
      )
        throw new ActiveFoodDayPointerIntegrityError();
      validateAccountTurnStepResult(row.result, slot, target);
    }
  } catch {
    throw new ActiveFoodDayPointerIntegrityError();
  }
  const advanced =
    await dependencies.conversations.advanceActiveFoodDayFromCompletedTurn({
      userId: input.trustedUserId,
      turnId: input.turnId,
    });
  return advanced === null ? "UNCHANGED" : "ADVANCED";
}
