import { DomainValidationError } from "@cal-calc/domain";

import type {
  FoodDayCompleteness,
  JsonObject,
  PersistedFoodDay,
  PersistedSemanticOperation,
} from "../types.js";
import {
  FoodDayCompletenessConflictError,
  FoodDayNotFoundError,
  PostgresFoodDayRepository,
} from "./food-day-repository.js";
import {
  PostgresSemanticOperationRepository,
  SemanticOperationStateConflictError,
} from "./semantic-operation-repository.js";
import type { PostgresTransactionRunner } from "./transaction.js";

export interface SetFoodDayCompletenessExactlyOnceInput {
  readonly userId: string;
  readonly foodDayId: string;
  readonly expectedCompleteness: FoodDayCompleteness;
  readonly targetCompleteness: FoodDayCompleteness;
  readonly operationId: string;
  readonly operationKey: string;
  readonly requestFingerprint: string;
}

export interface SetFoodDayCompletenessExactlyOnceResult {
  readonly disposition: "APPLIED" | "REPLAYED";
  /** The current authoritative owned FoodDay, including on replay. */
  readonly foodDay: PersistedFoodDay;
  readonly operation: PersistedSemanticOperation;
}

export class SetFoodDayCompletenessIntegrityError extends Error {
  override readonly name = "SetFoodDayCompletenessIntegrityError";

  constructor(readonly reason: "MALFORMED_RESULT" | "FOOD_DAY_NOT_FOUND") {
    super("Stored FoodDay completeness operation is inconsistent.");
  }
}

export async function setFoodDayCompletenessExactlyOnce(
  transactionRunner: PostgresTransactionRunner,
  input: SetFoodDayCompletenessExactlyOnceInput,
): Promise<SetFoodDayCompletenessExactlyOnceResult> {
  return transactionRunner.runInTransaction(async (executor) => {
    const operations = new PostgresSemanticOperationRepository(executor);
    const foodDays = new PostgresFoodDayRepository(executor);
    const claim = await operations.claim({
      id: input.operationId,
      userId: input.userId,
      operationKey: input.operationKey,
      requestFingerprint: input.requestFingerprint,
    });

    if (claim.disposition === "EXISTING") {
      if (claim.operation.status !== "SUCCEEDED") {
        throw new SemanticOperationStateConflictError(
          claim.operation.operationKey,
          claim.operation.status,
        );
      }
      if (!isStoredResult(claim.operation.result, input)) {
        throw new SetFoodDayCompletenessIntegrityError("MALFORMED_RESULT");
      }
      const foodDay = await foodDays.findById(input.userId, input.foodDayId);
      if (foodDay === null) {
        throw new SetFoodDayCompletenessIntegrityError("FOOD_DAY_NOT_FOUND");
      }
      return {
        disposition: "REPLAYED",
        foodDay,
        operation: claim.operation,
      };
    }

    // A fresh same-value command is a no-op, but an exact retry above still
    // replays before this check. Check ownership before revealing a conflict.
    if (input.targetCompleteness === input.expectedCompleteness) {
      const current = await foodDays.findById(input.userId, input.foodDayId);
      if (current === null) throw new FoodDayNotFoundError(input.foodDayId);
      if (current.completeness !== input.expectedCompleteness) {
        throw new FoodDayCompletenessConflictError();
      }
      throw new DomainValidationError(
        "Food day completeness is already the requested value.",
      );
    }

    const foodDay = await foodDays.setCompleteness(input);
    const result = {
      kind: "FOOD_DAY_COMPLETENESS_SET",
      foodDayId: foodDay.foodDay.id,
      completeness: foodDay.completeness,
    } as const satisfies JsonObject;
    const operation = await operations.markSucceeded({
      userId: input.userId,
      operationKey: input.operationKey,
      result,
    });
    return { disposition: "APPLIED", foodDay, operation };
  });
}

function isStoredResult(
  result: JsonObject | null,
  input: SetFoodDayCompletenessExactlyOnceInput,
): boolean {
  return (
    result !== null &&
    result.kind === "FOOD_DAY_COMPLETENESS_SET" &&
    result.foodDayId === input.foodDayId &&
    result.completeness === input.targetCompleteness
  );
}
